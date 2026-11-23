// The admin API for apps: adding one from its repo, its page, deploying it, its secrets and its
// removal, each scoped to who is asking; and the GitHub events and checks that deploy apps by themselves.

import { APP_NAME, CONFIG_FILE, HOSTNAME, needs, readConfig, zoneFor, type App, type Updates } from "./apps.ts";
import { Cloudflare, SetupError } from "./cloudflare.ts";
import { claimed, stored, syncAccess, type Context } from "./complete.ts";
import { remove, type Builder, type DeployEnv, type Run } from "./deploy.ts";
import { installUrl, parseRepo, Source, type GitHubApp } from "./github.ts";
import { Neon } from "./neon.ts";
import { Resend } from "./resend.ts";
import { EMAIL, type InstanceRecord, type Viewer } from "./setup.ts";

export interface AppContext extends Context {
  builder?: (run: string) => Builder;
}

const UPDATES: Updates[] = ["push", "releases", "branch"];

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const github = (ctx: Context): GitHubApp | undefined => (ctx.secrets.GITHUB_APP ? (JSON.parse(ctx.secrets.GITHUB_APP) as GitHubApp) : undefined);

export function deployEnv(ctx: AppContext, record: InstanceRecord, host: string, appSecrets: Record<string, string>): DeployEnv {
  const { secrets, fetcher } = ctx;
  if (!secrets.CLOUDFLARE_API_TOKEN) throw new SetupError("This instance has no Cloudflare token; the super admin adds it in Settings.");
  return {
    account: record.account,
    host,
    cf: new Cloudflare(secrets.CLOUDFLARE_API_TOKEN, fetcher, true),
    ...(secrets.NEON_API_KEY ? { neon: new Neon(secrets.NEON_API_KEY, fetcher) } : {}),
    ...(secrets.RESEND_API_KEY ? { resend: new Resend(secrets.RESEND_API_KEY, fetcher) } : {}),
    ...(github(ctx) ? { github: github(ctx)! } : {}),
    builder: ctx.builder ?? (() => ({ fetch: async () => Response.json({ error: "no build machine" }, { status: 500 }), destroy: async () => {} })),
    appSecrets,
    fetcher,
    now: () => new Date(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

export function newRun(app: string, kind: Run["kind"], target: Run["target"], ref: string, by: string, commit?: string): Run {
  const id = `${Date.now().toString(36)}-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return { id, app, kind, target, ref, ...(commit ? { commit } : {}), by, state: "queued", done: [], warnings: [], queuedAt: new Date().toISOString() };
}

const sees = (who: Viewer, app: App) => who.role !== "app" || app.admins.includes(who.email);
const manages = (who: Viewer) => who.role !== "app";

async function attempt(step: (done: string[]) => Promise<unknown>): Promise<Response> {
  const done: string[] = [];
  try {
    const extra = await step(done);
    return json({ done, ...(extra && typeof extra === "object" ? extra : {}) });
  } catch (error) {
    if (error instanceof SetupError) return json({ done, error: error.message }, 400);
    console.error(error);
    return json({ done, error: `Something went wrong that the instance did not expect: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` }, 400);
  }
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function emails(value: unknown): string[] {
  const list = (Array.isArray(value) ? value.map(String) : text(value).split(/[\s,]+/)).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((e) => !EMAIL.test(e));
  if (bad.length) throw new SetupError(`Not valid email addresses: ${bad.join(", ")}.`);
  return [...new Set(list)];
}

function build(value: unknown): App["build"] {
  const input = (value ?? {}) as Record<string, unknown>;
  const out: App["build"] = {};
  for (const key of ["install", "build", "test"] as const) if (typeof input[key] === "string") out[key] = (input[key] as string).trim();
  return out;
}

// The latest version to deploy: the newest release, or the default branch.
async function latest(source: Source, app: Pick<App, "updates" | "repo">): Promise<string> {
  if (app.updates === "releases") return (await source.latestRelease()) ?? app.repo.defaultBranch;
  return app.repo.defaultBranch;
}

export async function appRoute(request: Request, route: string, who: Viewer, ctx: AppContext): Promise<Response> {
  const record = await claimed(ctx);
  const body = request.method === "POST" ? (((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>) : {};
  const post = request.method === "POST";

  if (route === "" && !post) {
    const apps = (await ctx.apps.list()).filter((a) => sees(who, a));
    const rows = await Promise.all(apps.map(async (a) => ({ ...summary(a), last: (await ctx.apps.runs(a.name)).at(-1) })));
    return json({ apps: rows, canAdd: manages(who) });
  }

  if (route === "inspect" && post) {
    if (!manages(who)) return json({ error: "Only platform admins add apps." }, 403);
    return attempt(async () => inspect(ctx, record, text(body.repo), text(body.dir)));
  }

  if (route === "add" && post) {
    if (!manages(who)) return json({ error: "Only platform admins add apps." }, 403);
    return attempt((done) => add(ctx, record, who, body, done));
  }

  const [name = "", action = ""] = route.split("/");
  const app = await ctx.apps.get(name);
  if (!app || !sees(who, app)) return json({ error: "No such app." }, 404);

  if (action === "" && !post) {
    const declared = await ctx.apps.secrets(app.name);
    const source = new Source(app.repo.owner, app.repo.name, github(ctx), ctx.fetcher);
    let secretNames: string[] = Object.keys(declared);
    let installed = false;
    try {
      installed = await source.installed();
      const textAt = await source.file(app.dir ? `${app.dir}/${CONFIG_FILE}` : CONFIG_FILE, app.deployed?.commit ?? app.repo.defaultBranch);
      if (textAt) secretNames = [...new Set([...readConfig(textAt, app.name, app.address).features.secrets, ...secretNames])];
    } catch {
      // The page still shows what it has.
    }
    const gh = github(ctx);
    return json({
      app: summary(app),
      admins: app.admins,
      build: app.build,
      runs: (await ctx.apps.runs(app.name)).slice().reverse(),
      // Write-only: only whether each is set.
      secrets: secretNames.map((s) => ({ name: s, set: Boolean(declared[s]) })),
      installed,
      ...(gh && !installed ? { installUrl: installUrl(gh, app.repo) } : {}),
      canManage: manages(who),
    });
  }
  if (!post) return json({ error: "Not found." }, 404);

  switch (action) {
    case "deploy":
      return attempt(async (done) => {
        const source = new Source(app.repo.owner, app.repo.name, github(ctx), ctx.fetcher);
        const ref = app.available?.ref ?? (await latest(source, app));
        await ctx.apps.enqueue(newRun(app.name, "deploy", { kind: "prod" }, ref, who.email), ctx.self.host);
        done.push(`Queued a deploy of ${ref}.`);
      });
    case "settings":
      return attempt(async (done) => {
        const patch: Partial<App> = {};
        if (body.build !== undefined) patch.build = build(body.build);
        if (body.updates !== undefined) {
          if (!UPDATES.includes(body.updates as Updates)) throw new SetupError("Updates must be push, releases or branch.");
          if (body.updates === "push" && !(await new Source(app.repo.owner, app.repo.name, github(ctx), ctx.fetcher).installed())) throw new SetupError("Deploying on push needs the instance's GitHub App installed on the repo.");
          patch.updates = body.updates as Updates;
        }
        if (body.admins !== undefined) {
          if (!manages(who)) throw new SetupError("Only platform admins change who administers an app.");
          patch.admins = emails(body.admins);
        }
        await ctx.apps.patch(app.name, patch);
        if (patch.admins) {
          await syncAccess(ctx, record);
          done.push(patch.admins.length ? `${patch.admins.join(", ")} administer ${app.name}.` : `${app.name} has no app admins.`);
        }
        done.push("Saved.");
      });
    case "secret":
      return attempt(async (done) => {
        const key = text(body.key);
        if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new SetupError("A secret's name is UPPER_SNAKE_CASE.");
        const value = typeof body.value === "string" ? body.value : "";
        if (!value) throw new SetupError("Paste the secret's value.");
        await ctx.apps.setSecret(app.name, key, value);
        done.push(`Saved ${key}; the next deploy gives it to the app.`);
      });
    case "remove":
      return attempt(async (done) => {
        if (!manages(who)) throw new SetupError("Only platform admins remove apps.");
        if (text(body.confirm) !== app.name) throw new SetupError(`Type ${app.name} to confirm.`);
        await remove(deployEnv(ctx, record, ctx.self.host, {}), app, body.data === true, done);
        await ctx.apps.delete(app.name);
        await syncAccess(ctx, record);
        done.push(`Removed ${app.name}.`);
      });
  }
  return json({ error: "Not found." }, 404);
}

function summary(app: App) {
  return { name: app.name, address: app.address, repo: `${app.repo.owner}/${app.repo.name}`, dir: app.dir, updates: app.updates, deployed: app.deployed, available: app.available, previews: app.previews };
}

// What Add app shows once a repo is named: what the app needs, and whether the instance reaches it.
async function inspect(ctx: AppContext, record: InstanceRecord, input: string, dir: string) {
  const parsed = parseRepo(input);
  if (!parsed) throw new SetupError("Enter a GitHub repo, like celsoft-com/pages or its link.");
  const gh = github(ctx);
  const source = new Source(parsed.owner, parsed.name, gh, ctx.fetcher);
  const repo = await source.repo();
  const installed = await source.installed();
  const path = dir ? `${dir}/${CONFIG_FILE}` : CONFIG_FILE;
  const text = await source.file(path, repo.defaultBranch);
  if (text === undefined) throw new SetupError(`${repo.owner}/${repo.name} has no ${path} on ${repo.defaultBranch}, so it is not a platform app${dir ? "" : "; if the app is in a folder, name the folder"}.`);
  const suggested = repo.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const config = readConfig(text, suggested, "app.invalid");
  const zones = (await stored(ctx).zones(record.account)).map((z) => z.name).sort();
  const release = await source.latestRelease();
  return {
    repo: { owner: repo.owner, name: repo.name, private: repo.private, defaultBranch: repo.defaultBranch },
    installed,
    ...(gh && !installed ? { installUrl: installUrl(gh, repo) } : {}),
    needs: needs(config.features),
    warnings: config.warnings,
    zones,
    name: suggested,
    release,
    updates: installed ? "push" : release ? "releases" : "branch",
  };
}

async function add(ctx: AppContext, record: InstanceRecord, who: Viewer, body: Record<string, unknown>, done: string[]) {
  const parsed = parseRepo(text(body.repo));
  if (!parsed) throw new SetupError("Enter a GitHub repo, like celsoft-com/pages or its link.");
  const name = text(body.name);
  if (!APP_NAME.test(name)) throw new SetupError("The name must be 3 to 50 characters of a-z, 0-9 and single hyphens, starting with a letter.");
  const address = text(body.address).toLowerCase();
  if (!HOSTNAME.test(address)) throw new SetupError("The address must be a hostname, like pages.example.com.");
  const updates = text(body.updates) as Updates;
  if (!UPDATES.includes(updates)) throw new SetupError("Choose how the app updates.");
  const admins = emails(body.admins);
  const dir = text(body.dir).replace(/^\/+|\/+$/g, "");

  const apps = await ctx.apps.list();
  if (apps.some((a) => a.name === name)) throw new SetupError(`There is already an app named ${name}.`);
  const taken = apps.find((a) => address === a.address || address.endsWith(`.${a.address}`) || a.address.endsWith(`.${address}`));
  if (taken) throw new SetupError(`${address} overlaps ${taken.name}'s address ${taken.address}; each app gets an address of its own.`);
  if (address === ctx.self.host) throw new SetupError("That is this instance's own address.");
  const cf = stored(ctx);
  if (name === record.script || (await cf.script(record.account, name))) throw new SetupError(`This Cloudflare account already has a Worker named ${name}; choose another name.`);
  const zone = zoneFor(address, await cf.zones(record.account));
  if (!zone) throw new SetupError(`${address} is not in any of this account's domains; add its domain to Cloudflare first, or choose an address under one of them.`);
  done.push(`${address} is in the account's domain ${zone.name}.`);

  const source = new Source(parsed.owner, parsed.name, github(ctx), ctx.fetcher);
  const repo = await source.repo();
  if (updates === "push" && !(await source.installed())) throw new SetupError("Deploying on push needs the instance's GitHub App installed on the repo; install it, or choose releases or the default branch.");
  const path = dir ? `${dir}/${CONFIG_FILE}` : CONFIG_FILE;
  const config = await source.file(path, repo.defaultBranch);
  if (config === undefined) throw new SetupError(`${repo.owner}/${repo.name} has no ${path}.`);
  readConfig(config, name, address);
  done.push(`Read ${path} from ${repo.owner}/${repo.name}.`);

  const app: App = {
    name,
    repo: { owner: repo.owner, ownerId: repo.ownerId, name: repo.name, id: repo.id, private: repo.private, defaultBranch: repo.defaultBranch },
    dir,
    address,
    zone: { id: zone.id, name: zone.name },
    admins,
    build: build(body.build),
    updates,
    resources: {},
    previews: [],
    addedBy: who.email,
    addedAt: new Date().toISOString(),
  };
  await ctx.apps.put(app);
  if (admins.length) {
    await syncAccess(ctx, record);
    done.push(`Cloudflare Access lets in ${admins.join(", ")} as ${name}'s admins.`);
  }
  const ref = await latest(source, app);
  await ctx.apps.enqueue(newRun(name, "deploy", { kind: "prod" }, ref, who.email), ctx.self.host);
  done.push(`Added ${name}, and queued its first deploy of ${ref}.`);
  return { name };
}

// GitHub's events for repos the instance's app is installed on: a push to the default branch
// deploys an app that updates on push; a pull request from the same repo gets a preview.
export async function githubEvent(ctx: AppContext, event: string | null, payload: Record<string, any>): Promise<void> {
  const repoId = payload.repository?.id as number | undefined;
  if (!repoId) return;
  const apps = (await ctx.apps.list()).filter((a) => a.repo.id === repoId);
  for (const app of apps) {
    if (event === "push" && app.updates === "push" && payload.ref === `refs/heads/${app.repo.defaultBranch}` && payload.after && !payload.deleted) {
      await ctx.apps.enqueue(newRun(app.name, "deploy", { kind: "prod" }, app.repo.defaultBranch, `push by ${payload.pusher?.name ?? "someone"}`, payload.after), ctx.self.host);
    }
    if (event === "pull_request") {
      const pr = payload.number as number;
      const sameRepo = payload.pull_request?.head?.repo?.id === repoId;
      if (["opened", "synchronize", "reopened"].includes(payload.action) && sameRepo) {
        await ctx.apps.enqueue(newRun(app.name, "deploy", { kind: "preview", pr }, payload.pull_request.head.ref, `pull request ${pr}`, payload.pull_request.head.sha), ctx.self.host);
      }
      if (payload.action === "closed" && app.previews.includes(pr)) {
        await ctx.apps.enqueue(newRun(app.name, "cleanup", { kind: "preview", pr }, payload.pull_request?.head?.ref ?? "", `pull request ${pr} closed`), ctx.self.host);
      }
    }
  }
}

// The scheduled check: an app that follows its default branch deploys any new commit; one that
// takes releases shows a newer release as available, for its admins to deploy.
export async function checkUpdates(ctx: AppContext): Promise<void> {
  for (const app of await ctx.apps.list()) {
    if (app.updates === "push") continue;
    try {
      const source = new Source(app.repo.owner, app.repo.name, github(ctx), ctx.fetcher);
      if (app.updates === "branch") {
        const commit = await source.commit(app.repo.defaultBranch);
        if (commit !== app.deployed?.commit && commit !== app.available?.commit) {
          await ctx.apps.patch(app.name, { available: { ref: app.repo.defaultBranch, commit } });
          await ctx.apps.enqueue(newRun(app.name, "deploy", { kind: "prod" }, app.repo.defaultBranch, "a new commit", commit), ctx.self.host);
        }
      } else {
        const tag = await source.latestRelease();
        if (tag && tag !== app.deployed?.ref) await ctx.apps.patch(app.name, { available: { ref: tag, commit: await source.commit(tag) } });
      }
    } catch (error) {
      console.error(`checking ${app.name} for updates`, error);
    }
  }
}
