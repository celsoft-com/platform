// The admin API for apps: adding one from its repo, its page, deploying it, its secrets and its
// removal, each scoped to who is asking; and the GitHub events and checks that deploy apps by themselves.

import { APP_NAME, CONFIG_FILE, HOSTNAME, needs, readConfig, zoneFor, type App, type Upstream } from "./apps.ts";
import { Cloudflare, SetupError } from "./cloudflare.ts";
import { claimed, stored, syncAccess, type Context } from "./complete.ts";
import { machineStep, remove, type Builder, type DeployEnv, type Merge, type Run } from "./deploy.ts";
import { authorizeUrl, callbackUrl, checkApp, createRepo, installUrl, parseRepo, Source, userToken, type GitHubApp } from "./github.ts";
import { Neon } from "./neon.ts";
import { Resend } from "./resend.ts";
import { EMAIL, PLATFORM_SOURCE, type InstanceRecord, type Viewer } from "./setup.ts";

export interface AppContext extends Context {
  builder?: (run: string) => Builder;
}

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

const random = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export function newRun(app: string, kind: Run["kind"], target: Run["target"], ref: string, by: string, commit?: string, merge?: Merge): Run {
  const id = `${Date.now().toString(36)}-${random(4)}`;
  return { id, app, kind, target, ref, ...(commit ? { commit } : {}), ...(merge ? { merge } : {}), by, state: "queued", done: [], warnings: [], queuedAt: new Date().toISOString() };
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

// A source's newest version: its latest release, or its default branch if it makes none.
export async function newest(source: Source): Promise<{ ref: string; commit: string }> {
  const ref = (await source.latestRelease()) ?? (await source.repo()).defaultBranch;
  return { ref, commit: await source.commit(ref) };
}

// An app's repo is its own clone of its source, in the instance's owner; a repo already there is used as it is.
const clones = (gh: GitHubApp | undefined, owner: string) => !gh || gh.owner.toLowerCase() !== owner.toLowerCase();

interface Held {
  by: string;
  app: Omit<App, "repo" | "addedAt">;
  source: Upstream;
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

  if (route === "authorized" && post) {
    if (!manages(who)) return json({ error: "Only platform admins add apps." }, 403);
    return attempt((done) => authorized(ctx, record, who, text(body.code), text(body.state), done));
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
        await ctx.apps.enqueue(newRun(app.name, "deploy", { kind: "prod" }, app.repo.defaultBranch, who.email), ctx.self.host);
        done.push(`Queued a deploy of ${app.repo.defaultBranch}.`);
      });
    case "update":
      return attempt(async (done) => {
        if (!app.source || !app.available) throw new SetupError(`${app.name} has no update waiting.`);
        const merge: Merge = { source: { owner: app.source.owner, name: app.source.name }, ref: app.available.ref, commit: app.available.commit, clone: false, author: who.email };
        await ctx.apps.enqueue(newRun(app.name, "deploy", { kind: "prod" }, app.available.ref, who.email, undefined, merge), ctx.self.host);
        done.push(`Queued merging ${app.source.owner}/${app.source.name} ${app.available.ref} into ${app.repo.owner}/${app.repo.name}, then a deploy.`);
      });
    case "settings":
      return attempt(async (done) => {
        const patch: Partial<App> = {};
        if (body.build !== undefined) patch.build = build(body.build);
        if (body.admins !== undefined) {
          if (!manages(who)) throw new SetupError("Only platform admins change who administers an app.");
          patch.admins = emails(body.admins);
        }
        const address = body.address === undefined ? app.address : text(body.address).toLowerCase();
        if (address !== app.address) {
          if (!manages(who)) throw new SetupError("Only platform admins change an app's address.");
          const zone = await checkNewAddress(ctx, record, address, app.name);
          Object.assign(patch, { address, zone: { id: zone.id, name: zone.name }, moved: [...(app.moved ?? []), { address: app.address, zone: app.zone }] });
        }
        await ctx.apps.patch(app.name, patch);
        if (patch.admins) {
          await syncAccess(ctx, record);
          done.push(patch.admins.length ? `${patch.admins.join(", ")} administer ${app.name}.` : `${app.name} has no app admins.`);
        }
        if (patch.address) {
          await ctx.apps.enqueue(newRun(app.name, "deploy", { kind: "prod" }, app.repo.defaultBranch, who.email), ctx.self.host);
          done.push(`Queued a deploy that moves ${app.name} from ${app.address} to ${address}.`);
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
  return {
    name: app.name,
    address: app.address,
    repo: `${app.repo.owner}/${app.repo.name}`,
    dir: app.dir,
    ...(app.source ? { source: `${app.source.owner}/${app.source.name}`, sourceRef: app.source.ref } : {}),
    deployed: app.deployed,
    available: app.available,
    previews: app.previews,
  };
}

// An address an app may have: a hostname in one of the account's domains, overlapping no other app's.
async function checkNewAddress(ctx: AppContext, record: InstanceRecord, address: string, name: string) {
  if (!HOSTNAME.test(address)) throw new SetupError("The address must be a hostname, like pages.example.com.");
  const taken = (await ctx.apps.list()).find((a) => a.name !== name && (address === a.address || address.endsWith(`.${a.address}`) || a.address.endsWith(`.${address}`)));
  if (taken) throw new SetupError(`${address} overlaps ${taken.name}'s address ${taken.address}; each app gets an address of its own.`);
  if (address === ctx.self.host) throw new SetupError("That is this instance's own address.");
  const zone = zoneFor(address, await stored(ctx).zones(record.account));
  if (!zone) throw new SetupError(`${address} is not in any of this account's domains; add its domain to Cloudflare first, or choose an address under one of them.`);
  return zone;
}

// What Add app shows once a repo is named: what the app needs, and the repo it will deploy from.
async function inspect(ctx: AppContext, record: InstanceRecord, input: string, dir: string) {
  const parsed = parseRepo(input);
  if (!parsed) throw new SetupError("Enter a GitHub repo, like celsoft-com/pages or its link.");
  const gh = github(ctx);
  if (!gh) throw new SetupError("This instance has no GitHub App yet; the super admin creates it first.");
  const source = new Source(parsed.owner, parsed.name, gh, ctx.fetcher);
  const repo = await source.repo();
  const installed = await source.installed();
  const path = dir ? `${dir}/${CONFIG_FILE}` : CONFIG_FILE;
  const text = await source.file(path, repo.defaultBranch);
  if (text === undefined) throw new SetupError(`${repo.owner}/${repo.name} has no ${path} on ${repo.defaultBranch}, so it is not a platform app${dir ? "" : "; if the app is in a folder, name the folder"}.`);
  const suggested = repo.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const config = readConfig(text, suggested, "app.invalid");
  const zones = (await stored(ctx).zones(record.account)).map((z) => z.name).sort();
  const clone = clones(gh, repo.owner);
  return {
    repo: { owner: repo.owner, name: repo.name, private: repo.private, defaultBranch: repo.defaultBranch },
    clone,
    owner: gh.owner,
    installed,
    ...(!clone && !installed ? { installUrl: installUrl(gh, repo) } : {}),
    needs: needs(config.features),
    warnings: config.warnings,
    zones,
    name: suggested,
    release: await source.latestRelease(),
  };
}

// Adding an app checks everything, then, for a source outside the instance's owner, sends the admin
// to GitHub to let the instance make the app's repo as them; GitHub's answer finishes it.
async function add(ctx: AppContext, record: InstanceRecord, who: Viewer, body: Record<string, unknown>, done: string[]) {
  const parsed = parseRepo(text(body.repo));
  if (!parsed) throw new SetupError("Enter a GitHub repo, like celsoft-com/pages or its link.");
  const gh = github(ctx);
  if (!gh) throw new SetupError("This instance has no GitHub App yet; the super admin creates it first.");
  const name = text(body.name);
  if (!APP_NAME.test(name)) throw new SetupError("The name must be 3 to 50 characters of a-z, 0-9 and single hyphens, starting with a letter.");
  const address = text(body.address).toLowerCase();
  const admins = emails(body.admins);
  const dir = text(body.dir).replace(/^\/+|\/+$/g, "");

  if (await ctx.apps.get(name)) throw new SetupError(`There is already an app named ${name}.`);
  const cf = stored(ctx);
  if (name === record.script || (await cf.script(record.account, name))) throw new SetupError(`This Cloudflare account already has a Worker named ${name}; choose another name.`);
  const zone = await checkNewAddress(ctx, record, address, name);
  done.push(`${address} is in the account's domain ${zone.name}.`);

  const source = new Source(parsed.owner, parsed.name, gh, ctx.fetcher);
  const repo = await source.repo();
  const path = dir ? `${dir}/${CONFIG_FILE}` : CONFIG_FILE;
  const config = await source.file(path, repo.defaultBranch);
  if (config === undefined) throw new SetupError(`${repo.owner}/${repo.name} has no ${path}.`);
  readConfig(config, name, address);
  done.push(`Read ${path} from ${repo.owner}/${repo.name}.`);

  const app: Held["app"] = { name, dir, address, zone: { id: zone.id, name: zone.name }, admins, build: build(body.build), resources: {}, previews: [], addedBy: who.email };
  if (!clones(gh, repo.owner)) {
    if (!(await source.installed())) throw new SetupError(`The instance's GitHub App is not on ${repo.owner}/${repo.name}; install it there first.`);
    await finish(ctx, record, who, { ...app, repo, addedAt: new Date().toISOString() }, undefined, done);
    return { name };
  }

  if (await new Source(gh.owner, name, gh, ctx.fetcher).repo().then(() => true, () => false)) {
    throw new SetupError(`${gh.owner}/${name} already exists on GitHub; choose another name, or add that repo itself.`);
  }
  const state = random(16);
  const held: Held = { by: who.email, app, source: { owner: repo.owner, name: repo.name, ...(await newest(source)) } };
  await ctx.apps.hold(state, held);
  done.push(`GitHub asks you to let the instance make ${gh.owner}/${name} as you, once.`);
  return { name, authorize: authorizeUrl(gh, ctx.self.host, state) };
}

// GitHub's answer: the app's repo is made as the admin, the instance's app put on it, and the
// first run clones the source into it, then deploys.
async function authorized(ctx: AppContext, record: InstanceRecord, who: Viewer, code: string, state: string, done: string[]) {
  const held = (await ctx.apps.take(state)) as Held | undefined;
  if (!held || held.by !== who.email) throw new SetupError("This answer from GitHub is not for an Add app you started, or it is over an hour old; add the app again.");
  const gh = github(ctx)!;
  if (await ctx.apps.get(held.app.name)) throw new SetupError(`There is already an app named ${held.app.name}.`);
  const token = await userToken(gh, code, ctx.fetcher);
  const repo = await createRepo(gh, token, held.app.name, `${held.app.name}, cloned from ${held.source.owner}/${held.source.name}; deployed by the Platform Instance at ${ctx.self.host}.`, ctx.fetcher);
  done.push(`Made ${repo.owner}/${repo.name}, private, with the instance's GitHub App on it.`);
  const merge: Merge = { source: { owner: held.source.owner, name: held.source.name }, ref: held.source.ref, commit: held.source.commit, clone: true, author: who.email };
  await finish(ctx, record, who, { ...held.app, repo, addedAt: new Date().toISOString() }, merge, done);
  return { name: held.app.name };
}

async function finish(ctx: AppContext, record: InstanceRecord, who: Viewer, app: App, merge: Merge | undefined, done: string[]) {
  await ctx.apps.put(app);
  if (app.admins.length) {
    await syncAccess(ctx, record);
    done.push(`Cloudflare Access lets in ${app.admins.join(", ")} as ${app.name}'s admins.`);
  }
  await ctx.apps.enqueue(newRun(app.name, "deploy", { kind: "prod" }, merge?.ref ?? app.repo.defaultBranch, who.email, undefined, merge), ctx.self.host);
  done.push(`Added ${app.name}, and queued its first ${merge ? "clone and " : ""}deploy.`);
}

// GitHub's events for app repos: a push to the default branch deploys, unless a run already has
// that commit; a pull request from the same repo gets a preview.
export async function githubEvent(ctx: AppContext, event: string | null, payload: Record<string, any>): Promise<void> {
  const repoId = payload.repository?.id as number | undefined;
  if (!repoId) return;
  const apps = (await ctx.apps.list()).filter((a) => a.repo.id === repoId);
  for (const app of apps) {
    if (event === "push" && payload.ref === `refs/heads/${app.repo.defaultBranch}` && payload.after && !payload.deleted) {
      const runs = await ctx.apps.runs(app.name);
      if (runs.some((r) => r.state !== "failed" && (r.commit === payload.after || (r.merge && r.state !== "done")))) continue;
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

// The scheduled check: each source's newest version, shown as available until someone updates.
export async function checkUpdates(ctx: AppContext): Promise<void> {
  const gh = github(ctx);
  for (const app of await ctx.apps.list()) {
    if (!app.source) continue;
    try {
      const found = await newest(new Source(app.source.owner, app.source.name, gh, ctx.fetcher));
      if (found.commit !== app.source.commit && found.commit !== app.available?.commit) await ctx.apps.patch(app.name, { available: found });
    } catch (error) {
      console.error(`checking ${app.name} for updates`, error);
    }
  }
  try {
    const record = await ctx.store.get();
    if (!record?.repo) return;
    const found = await newest(new Source(PLATFORM_SOURCE.owner, PLATFORM_SOURCE.name, gh, ctx.fetcher));
    if (found.commit !== record.source?.commit && found.commit !== record.available?.commit) await ctx.store.put({ ...record, available: found });
  } catch (error) {
    console.error("checking the platform for updates", error);
  }
}

// The instance's own repo and its updates, which only the super admin sees.
export async function instanceView(ctx: AppContext, record: InstanceRecord) {
  const gh = github(ctx);
  let check: Awaited<ReturnType<typeof checkApp>> | { error: string } | undefined;
  if (gh) check = await checkApp(gh, ctx.fetcher).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  return {
    repo: record.repo ? `${record.repo.owner}/${record.repo.name}` : "",
    suggested: gh ? `${gh.owner}/${record.script}` : "",
    source: `${PLATFORM_SOURCE.owner}/${PLATFORM_SOURCE.name}`,
    merged: record.source,
    available: record.available,
    github: { check, callback: callbackUrl(ctx.self.host) },
  };
}

export async function instanceRepo(ctx: AppContext, input: string, done: string[]): Promise<void> {
  const parsed = parseRepo(input);
  if (!parsed) throw new SetupError("Enter the instance's repo, like celsoft-com/platform-deployed or its link.");
  const repo = await new Source(parsed.owner, parsed.name, github(ctx), ctx.fetcher).repo();
  if (!(await new Source(repo.owner, repo.name, github(ctx), ctx.fetcher).installed())) throw new SetupError(`The instance's GitHub App is not on ${repo.owner}/${repo.name}; install it there, then save again.`);
  const record = (await ctx.store.get())!;
  await ctx.store.put({ ...record, repo: { owner: repo.owner, name: repo.name, branch: repo.defaultBranch } });
  done.push(`Updates merge into ${repo.owner}/${repo.name}'s ${repo.defaultBranch}, which Cloudflare deploys.`);
}

// Merges the platform's newest version into the instance's repo; Workers Builds deploys the push.
export async function instanceUpdate(ctx: AppContext, who: Viewer, done: string[]): Promise<void> {
  const record = (await ctx.store.get())!;
  if (!record.repo) throw new SetupError("Name the instance's repo first.");
  if (!ctx.builder) throw new SetupError("This instance has no machine to merge on.");
  const gh = github(ctx);
  const from = `${PLATFORM_SOURCE.owner}/${PLATFORM_SOURCE.name}`;
  const into = `${record.repo.owner}/${record.repo.name}`;
  const found = record.available ?? (await newest(new Source(PLATFORM_SOURCE.owner, PLATFORM_SOURCE.name, gh, ctx.fetcher)));
  const token = await new Source(record.repo.owner, record.repo.name, gh, ctx.fetcher).writeToken();
  const machine = ctx.builder(`git-instance-${Date.now().toString(36)}`);
  const log = { log: undefined } as unknown as Run;
  try {
    const input = { source: from, commit: found.commit, target: into, branch: record.repo.branch, token, ...(record.source ? { base: record.source.commit } : {}), author: { name: who.email, email: who.email }, message: `Update from ${from} ${found.ref}` };
    const result = await machineStep<{ commit: string; upToDate?: boolean; conflicts?: string[] }>(machine, log, "Merging the platform", "/git/merge", JSON.stringify(input));
    if (result.conflicts) throw new SetupError(`${from} ${found.ref} changes what ${into} changed too, in ${result.conflicts.join(", ")}; merge it there by hand.`);
    const latest = (await ctx.store.get())!;
    const { available: _done, ...rest } = latest;
    await ctx.store.put({ ...rest, source: found });
    done.push(result.upToDate ? `${into} already has ${from} ${found.ref}.` : `Merged ${from} ${found.ref} into ${into}; Cloudflare is deploying it, and this page shows the new version in a few minutes.`);
  } finally {
    await machine.destroy().catch(() => undefined);
  }
}
