// Deploying an app: the instance provisions everything in the app's namespace, builds the repo in
// a throwaway Container that holds none of the instance's credentials, and uploads the Worker with
// only that app's bindings. Each step reports itself on the run, which the app's page shows.

import { readConfig, names, previewAddress, type App, type Target, type Features } from "./apps.ts";
import { Cloudflare, SetupError, type Zone } from "./cloudflare.ts";
import { Source, type GitHubApp } from "./github.ts";
import { Neon, placement, type Branch } from "./neon.ts";
import { Resend, type MailDomain } from "./resend.ts";

export interface Run {
  id: string;
  app: string;
  kind: "deploy" | "cleanup";
  target: Target;
  ref: string;
  commit?: string;
  by: string;
  state: "queued" | "running" | "done" | "failed";
  done: string[];
  warnings: string[];
  error?: string;
  // The build's last lines, when the build stopped it.
  log?: string[];
  url?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

// One build machine, started for one run and destroyed after it.
export interface Builder {
  fetch(request: Request): Promise<Response>;
  destroy(): Promise<void>;
}

export interface DeployEnv {
  account: string;
  // Where the instance answers, for the links it puts on commits.
  host: string;
  cf: Cloudflare;
  neon?: Neon;
  resend?: Resend;
  github?: GitHubApp;
  builder: (run: string) => Builder;
  // The app's own secrets, as its admins set them.
  appSecrets: Record<string, string>;
  fetcher: typeof fetch;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export const BACKUP_PREFIX = "backup-";
export const BACKUPS_KEPT = 3;
export const PREVIEW_FILES_DAYS = 14;
export const VERIFY_WAIT_MS = 2 * 60_000;
export const UNGENERATED = "The app's schema has changes with no migration. Run `npx @celsoft/platform db generate` in the app's repo, review the SQL in drizzle/, commit it, and deploy again.";

export const dnsComment = (app: string) => `managed by @celsoft/platform for ${app}`;
const sendKeyName = (hostname: string) => `platform ${hostname}`;

class Reporter {
  constructor(
    readonly run: Run,
    private readonly save: (run: Run) => Promise<void>,
  ) {}

  async done(line: string) {
    this.run.done.push(line);
    await this.save(this.run);
  }

  async warn(line: string) {
    this.run.warnings.push(line);
    await this.save(this.run);
  }
}

export interface Outcome {
  // What changed in the app's record.
  patch: Partial<App>;
}

export async function deploy(env: DeployEnv, app: App, run: Run, save: (run: Run) => Promise<void>): Promise<Outcome> {
  const say = new Reporter(run, save);
  const { cf, account } = env;
  const target = run.target;
  const n = names(app.name, target);
  const hostname = target.kind === "prod" ? app.address : previewAddress(target.pr, app.address);
  const patch: Partial<App> = {};

  const source = new Source(app.repo.owner, app.repo.name, env.github, env.fetcher);
  const commit = run.commit ?? (await source.commit(run.ref));
  run.commit = commit;
  await say.done(`Deploying ${app.repo.owner}/${app.repo.name} at ${run.ref} (${commit.slice(0, 7)}) to ${hostname}.`);
  const link = `https://${env.host}/admin/apps/${app.name}`;
  await source.status(commit, "pending", `Deploying to ${hostname}`, link).catch(() => undefined);

  try {
    const path = app.dir ? `${app.dir}/platform.jsonc` : "platform.jsonc";
    const text = await source.file(path, commit);
    if (text === undefined) throw new SetupError(`${path} is not in the repo at ${commit.slice(0, 7)}.`);
    const config = readConfig(text, app.name, hostname);
    for (const w of config.warnings) await say.warn(w);
    const f = config.features;

    const missingSecrets = f.secrets.filter((s) => !env.appSecrets[s]);
    if (missingSecrets.length) throw new SetupError(`The app needs ${missingSecrets.join(", ")}; set ${missingSecrets.length === 1 ? "it" : "them"} under the app's Secrets, then deploy again.`);

    await checkAddress(env, app.zone, hostname, n.worker);
    await say.done(`${hostname} is free for this app.`);

    const existing = await cf.script(account, n.worker);
    const workerSecrets = existing ? (await cf.secrets(account, n.worker)).map((s) => s.name) : [];
    const generated: Record<string, string> = {};
    if (f.auth && !workerSecrets.includes("BETTER_AUTH_SECRET")) generated.BETTER_AUTH_SECRET = randomSecret();

    let database: { uri: string; hyperdrive: string; forgetKeys: boolean; placement?: string } | undefined;
    if (f.database) {
      const made = await prepareDatabase(env, app, target, say);
      Object.assign(patch, made.patch);
      const hyperdrive = await ensureHyperdrive(env, n.hyperdrive, made.uri, say);
      database = { uri: made.uri, hyperdrive, forgetKeys: made.copied || Boolean(generated.BETTER_AUTH_SECRET), placement: placement(made.region) };
    }

    const email = f.email ? await prepareEmail(env, app, f, target, hostname, workerSecrets, say) : { vars: {}, generated: {} };
    Object.assign(generated, email.generated);

    if (f.files) await ensureBucket(env, n.bucket, target.kind === "preview", say);

    // The build: nothing in the machine can reach anything but this app.
    const builder = env.builder(run.id);
    try {
      const step = async <T>(path: string, body?: BodyInit): Promise<T> => {
        // A streamed body must say it is sent before the answer starts.
        const init = { method: "POST", ...(body === undefined ? {} : { body }), ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as RequestInit;
        const response = await builder.fetch(new Request(`http://builder${path}`, init));
        const result = (await response.json().catch(() => ({ error: `the build machine answered ${response.status}` }))) as T & { error?: string; log?: string[] };
        if (!response.ok || result.error) {
          run.log = result.log;
          throw new SetupError(`The build stopped: ${result.error ?? response.status}.`);
        }
        return result;
      };
      await step("/source", await source.tarball(commit));
      await say.done("The build machine has the source.");
      const built = await step<Built>("/build", JSON.stringify({ config: config.text, dir: app.dir, ...app.build }));
      await say.done(`Built with ${built.manager} and @celsoft/platform ${built.framework}.`);
      if (!built.upToDate) throw new SetupError(UNGENERATED);
      if (database) {
        await step("/migrate", JSON.stringify({ uri: database.uri, forgetKeys: database.forgetKeys }));
        await say.done(`Migrated the database${database.forgetKeys ? ", forgetting signing keys this Worker cannot read" : ""}.`);
      }
      const bundle = await step<Bundle>("/bundle");
      await say.done(`Bundled the Worker (${Math.round(bundle.modules.reduce((sum, m) => sum + (m.content.length * 3) / 4, 0) / 1024)} KB).`);

      let assetsJwt: string | undefined;
      const files = Object.keys(bundle.assets.manifest).length;
      if (built.wrangler.assets) {
        const session = await cf.assetsSession(account, n.worker, bundle.assets.manifest);
        assetsJwt = session.jwt;
        if (session.buckets?.length) assetsJwt = (await step<{ jwt: string }>("/upload", JSON.stringify({ account, jwt: session.jwt, buckets: session.buckets }))).jwt;
        await say.done(`Uploaded ${session.buckets?.flat().length ?? 0} of ${files} static files; the rest were unchanged.`);
      }

      const vars: Record<string, string> = {
        APP_URL: `https://${hostname}`,
        TRACE: target.kind === "preview" ? "on" : "sample",
        DEPLOY_TARGET: target.kind === "prod" ? "production" : "preview",
        DEPLOY_AT: env.now().toISOString(),
        DEPLOY_COMMIT: commit,
        DEPLOY_BRANCH: run.ref,
        ...email.vars,
        ...(f.files && n.filesPrefix ? { FILES_PREFIX: n.filesPrefix } : {}),
      };
      const form = await scriptForm({
        worker: n.worker,
        wrangler: built.wrangler,
        bundle,
        vars,
        hyperdrive: database?.hyperdrive,
        bucket: f.files ? n.bucket : undefined,
        secrets: { ...env.appSecrets, ...generated },
        assetsJwt,
        migrationTag: existing?.migration_tag,
        placement: database?.placement,
      });
      await cf.uploadScript(account, n.worker, form);
      await say.done(`Uploaded the Worker ${n.worker} with only this app's bindings.`);
    } finally {
      await builder.destroy().catch(() => undefined);
    }

    await cf.setWorkersDev(account, n.worker, false);
    if (!(await cf.domains(account, hostname)).some((d) => d.service === n.worker)) await cf.attachDomain(account, hostname, n.worker, app.zone.id);
    await say.done(`https://${hostname} serves the app.`);
    run.url = `https://${hostname}`;
    await source.status(commit, "success", `Deployed to ${hostname}`, run.url).catch(() => undefined);
    if (target.kind === "prod") {
      patch.deployed = { ref: run.ref, commit, at: env.now().toISOString() };
      if (app.available?.commit === commit) patch.available = undefined;
    } else if (!app.previews.includes(target.pr)) patch.previews = [...app.previews, target.pr];
    return { patch };
  } catch (error) {
    await source.status(commit, "failure", error instanceof Error ? error.message : "The deploy failed", link).catch(() => undefined);
    throw error;
  }
}

interface Built {
  framework: string;
  manager: string;
  upToDate: boolean;
  pages: string[];
  wrangler: Wrangler;
}

// The Wrangler config the app's own framework wrote. Only what cannot reach beyond the app is
// taken from it: its settings, never a binding's target.
export interface Wrangler {
  compatibility_date: string;
  compatibility_flags?: string[];
  vars?: Record<string, unknown>;
  assets?: { not_found_handling?: string; run_worker_first?: string[] | boolean; html_handling?: string };
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] };
  migrations?: { tag: string; new_sqlite_classes?: string[]; new_classes?: string[]; deleted_classes?: string[]; renamed_classes?: { from: string; to: string }[] }[];
  ratelimits?: { name: string; simple: { limit: number; period: number } }[];
}

interface Bundle {
  main: string;
  modules: { name: string; type: string; content: string }[];
  assets: { manifest: Record<string, { hash: string; size: number }>; headers?: string; redirects?: string };
}

const VAR = /^[A-Z][A-Z0-9_]*$/;

export async function scriptForm(input: {
  worker: string;
  wrangler: Wrangler;
  bundle: Bundle;
  vars: Record<string, string>;
  hyperdrive?: string | undefined;
  bucket?: string | undefined;
  secrets: Record<string, string>;
  assetsJwt?: string | undefined;
  migrationTag?: string | undefined;
  placement?: string | undefined;
}): Promise<FormData> {
  const { wrangler: w, bundle } = input;
  const plain = Object.entries({ ...(w.vars ?? {}), ...input.vars }).filter(([name, value]) => VAR.test(name) && typeof value === "string");
  const objects = (w.durable_objects?.bindings ?? []).filter((b) => !b.script_name && VAR.test(b.name));
  const bindings: unknown[] = [
    ...plain.map(([name, text]) => ({ type: "plain_text", name, text })),
    { type: "version_metadata", name: "CF_VERSION_METADATA" },
    ...(input.hyperdrive ? [{ type: "hyperdrive", name: "DB", id: input.hyperdrive }] : []),
    ...(input.bucket ? [{ type: "r2_bucket", name: "FILES", bucket_name: input.bucket }] : []),
    ...objects.map((b) => ({ type: "durable_object_namespace", name: b.name, class_name: b.class_name })),
    ...(await Promise.all((w.ratelimits ?? []).filter((r) => VAR.test(r.name)).map(async (r) => ({ type: "ratelimit", name: r.name, namespace_id: await namespaceId(r.name === "AUTH_LIMIT" ? input.worker : `${input.worker}:${r.name === "API_LIMIT" ? "api" : r.name}`), simple: r.simple })))),
    ...Object.entries(input.secrets).map(([name, text]) => ({ type: "secret_text", name, text })),
  ];
  const steps = pendingMigrations(w.migrations ?? [], input.migrationTag);
  const metadata = {
    main_module: bundle.main,
    compatibility_date: w.compatibility_date,
    compatibility_flags: w.compatibility_flags ?? [],
    bindings,
    // Secrets set earlier, such as the generated auth secret, stay as they are.
    keep_bindings: ["secret_text"],
    observability: { enabled: true },
    ...(input.placement ? { placement: { region: input.placement } } : {}),
    ...(steps.length ? { migrations: { ...(input.migrationTag ? { old_tag: input.migrationTag } : {}), new_tag: steps.at(-1)!.tag, steps: steps.map(({ tag: _tag, ...step }) => step) } } : {}),
    ...(input.assetsJwt
      ? {
          assets: {
            jwt: input.assetsJwt,
            config: {
              ...(w.assets?.not_found_handling ? { not_found_handling: w.assets.not_found_handling } : {}),
              ...(w.assets?.html_handling ? { html_handling: w.assets.html_handling } : {}),
              ...(w.assets?.run_worker_first !== undefined ? { run_worker_first: w.assets.run_worker_first } : {}),
              ...(bundle.assets.headers ? { _headers: bundle.assets.headers } : {}),
              ...(bundle.assets.redirects ? { _redirects: bundle.assets.redirects } : {}),
            },
          },
        }
      : {}),
  };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const m of bundle.modules) {
    const bytes = Uint8Array.from(atob(m.content), (c) => c.charCodeAt(0));
    form.append(m.name, new File([bytes], m.name, { type: m.type }));
  }
  return form;
}

// Durable Object migrations the Worker has not had yet, after the tag it last took.
export function pendingMigrations<M extends { tag: string }>(migrations: M[], current: string | undefined): M[] {
  if (!current) return migrations;
  const at = migrations.findIndex((m) => m.tag === current);
  return at < 0 ? [] : migrations.slice(at + 1);
}

// Rate limit namespaces are account-wide integers, so each Worker gets its own from its name.
export async function namespaceId(name: string): Promise<string> {
  const digest = new DataView(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(name)));
  return String(1000 + (digest.getUint32(0) % 2_000_000_000));
}

function randomSecret(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// An address is the app's only when it is free or already this Worker's: a record or another
// Worker there is someone else's site.
async function checkAddress(env: DeployEnv, zone: { id: string }, hostname: string, worker: string): Promise<void> {
  const owner = (await env.cf.domains(env.account, hostname)).find((d) => d.hostname === hostname)?.service;
  if (owner === worker) return;
  if (owner) throw new SetupError(`${hostname} already serves the Worker ${owner}; remove it from that Worker first, or give the app another address.`);
  const records = (await env.cf.records(zone.id, hostname)).filter((r) => ["A", "AAAA", "CNAME"].includes(r.type));
  if (records.length) throw new SetupError(`${hostname} already has a DNS record (${records.map((r) => `${r.type} ${r.content}`).join(", ")}) the instance did not make; delete it first, or give the app another address.`);
}

async function prepareDatabase(env: DeployEnv, app: App, target: Target, say: Reporter): Promise<{ uri: string; region: string; copied: boolean; patch: Partial<App> }> {
  if (!env.neon) throw new SetupError("The app needs a database, and this instance has no Neon key; the super admin adds one in Settings, Database.");
  const neon = env.neon;
  const patch: Partial<App> = {};
  let project = app.resources.neonProject ? await neon.project(app.resources.neonProject) : undefined;
  if (!project) {
    project = await neon.createProject(app.name);
    patch.resources = { ...app.resources, neonProject: project.id, region: project.region_id };
    await say.done(`Made the app's own Neon project, Postgres ${project.pg_version} in ${project.region_id}.`);
  }
  const branches = await neon.branches(project.id);
  const prod = branches.find((b) => b.default);
  if (!prod) throw new SetupError("The app's Neon project has no default branch.");
  let branch: Branch = prod;
  let copied = false;
  if (target.kind === "prod") {
    await backup(env, project.id, prod, branches, say);
  } else {
    const name = `pr-${target.pr}`;
    const found = branches.find((b) => b.name === name);
    branch = found ?? (await neon.createBranch(project.id, name, prod.id, true));
    copied = !found;
    if (copied) await say.done(`Copied the prod database to the preview's branch ${name}.`);
  }
  return { uri: await neon.connectionUri(project.id, branch.id), region: project.region_id, copied, patch };
}

// Neon includes ten branches a project, so only the newest few backups are kept.
async function backup(env: DeployEnv, project: string, prod: Branch, branches: Branch[], say: Reporter): Promise<void> {
  const name = `${BACKUP_PREFIX}${env.now().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  await env.neon!.createBranch(project, name, prod.id, false);
  const old = branches.filter((b) => b.name.startsWith(BACKUP_PREFIX)).sort((a, b) => b.name.localeCompare(a.name)).slice(BACKUPS_KEPT - 1);
  for (const b of old) await env.neon!.deleteBranch(project, b.id);
  await say.done(`Backed up the prod database as ${name}.`);
}

async function ensureHyperdrive(env: DeployEnv, name: string, uri: string, say: Reporter): Promise<string> {
  const existing = (await env.cf.hyperdriveList(env.account)).find((h) => h.name === name);
  const url = new URL(uri);
  if (existing && existing.origin.host === url.hostname && existing.origin.user === decodeURIComponent(url.username)) return existing.id;
  const saved = await env.cf.saveHyperdrive(env.account, existing?.id, name, uri);
  await say.done(`${existing ? "Updated" : "Made"} the Hyperdrive connection ${name}.`);
  return saved.id;
}

async function ensureBucket(env: DeployEnv, bucket: string, preview: boolean, say: Reporter): Promise<void> {
  if (!(await env.cf.bucketExists(env.account, bucket))) {
    await env.cf.createBucket(env.account, bucket);
    if (preview) await env.cf.expireBucket(env.account, bucket, PREVIEW_FILES_DAYS);
    await say.done(`Made the file bucket ${bucket}${preview ? `, whose files expire after ${PREVIEW_FILES_DAYS} days` : ""}.`);
  }
}

// Prod sends from its own address; a preview emails only the addresses platform.jsonc lists,
// from prod's address, and captures the rest.
async function prepareEmail(env: DeployEnv, app: App, f: Features, target: Target, hostname: string, workerSecrets: string[], say: Reporter): Promise<{ vars: Record<string, string>; generated: Record<string, string> }> {
  if (!env.resend) throw new SetupError("The app sends email, and this instance has no Resend key; the super admin adds one in Settings, Email.");
  const resend = env.resend;
  const generated: Record<string, string> = {};
  const fresh = async (domain: MailDomain) => {
    const old = await resend.findKey(sendKeyName(hostname));
    if (old) await resend.deleteKey(old);
    generated.EMAIL_API_KEY = await resend.sendingKey(sendKeyName(hostname), domain.id);
  };
  if (target.kind === "prod") {
    const domain = await ensureMailDomain(env, app, hostname, say);
    if (!workerSecrets.includes("EMAIL_API_KEY")) await fresh(domain);
    return { vars: { EMAIL_MODE: "send", EMAIL_FROM: `noreply@${hostname}` }, generated };
  }
  const allowed = f.previews.sendEmailTo;
  const vars: Record<string, string> = { EMAIL_MODE: "capture", EMAIL_FROM: `noreply@${app.address}` };
  if (allowed.length) {
    const domain = await resend.findDomain(app.address);
    if (!domain) await say.warn(`Previews email nobody until prod has deployed and made the sending domain ${app.address}.`);
    else {
      vars.EMAIL_SEND_TO = allowed.join(",");
      if (!workerSecrets.includes("EMAIL_API_KEY")) await fresh(domain);
    }
  }
  return { vars, generated };
}

// Resend's records sit on names below the app's address, so the zone's own mail records are never touched.
async function ensureMailDomain(env: DeployEnv, app: App, hostname: string, say: Reporter): Promise<MailDomain> {
  const resend = env.resend!;
  const domain = (await resend.findDomain(hostname)) ?? (await resend.createDomain(hostname));
  const comment = dnsComment(app.name);
  const wanted = (domain.records ?? []).map((r) => ({ type: r.type, name: `${r.name}.${app.zone.name}`, content: r.value, ...(r.priority !== undefined ? { priority: r.priority } : {}) }));
  for (const record of wanted) {
    const existing = (await env.cf.records(app.zone.id, record.name)).filter((e) => e.type === record.type);
    if (existing.some((e) => unquote(e.content) === unquote(record.content))) continue;
    const foreign = existing.filter((e) => e.comment !== comment);
    if (foreign.length) throw new SetupError(`${record.name} already has a ${record.type} record the instance did not make; remove it, or give the app another address.`);
    for (const old of existing) await env.cf.deleteRecord(app.zone.id, old.id);
    await env.cf.createRecord(app.zone.id, record, comment);
  }
  if (domain.status === "verified") {
    await say.done(`Email sends from noreply@${hostname}.`);
    return domain;
  }
  await resend.verify(domain.id);
  for (let waited = 0; waited < VERIFY_WAIT_MS; waited += 10_000) {
    await env.sleep(10_000);
    if ((await resend.findDomain(hostname))?.status === "verified") {
      await say.done(`Resend verified ${hostname}; email sends from noreply@${hostname}.`);
      return domain;
    }
  }
  await say.warn(`Resend has not verified ${hostname} yet, so no email sends until it does; it usually finishes within the hour.`);
  return domain;
}

const unquote = (value: string) => value.replace(/^"|"$/g, "");

// Removes a preview: its Worker, database branch and sending key. Its files expire on their own.
export async function cleanup(env: DeployEnv, app: App, run: Run, save: (run: Run) => Promise<void>): Promise<Outcome> {
  const say = new Reporter(run, save);
  if (run.target.kind !== "preview") throw new SetupError("Only a preview is cleaned up.");
  const pr = run.target.pr;
  const n = names(app.name, run.target);
  await removeWorker(env, n.worker, n.hyperdrive, say);
  if (env.neon && app.resources.neonProject) {
    const branch = (await env.neon.branches(app.resources.neonProject)).find((b) => b.name === n.branch);
    if (branch) {
      await env.neon.deleteBranch(app.resources.neonProject, branch.id);
      await say.done(`Deleted the database branch ${branch.name}.`);
    }
  }
  if (env.resend) {
    const key = await env.resend.findKey(sendKeyName(previewAddress(pr, app.address)));
    if (key) await env.resend.deleteKey(key);
  }
  return { patch: { previews: app.previews.filter((p) => p !== pr) } };
}

async function removeWorker(env: DeployEnv, worker: string, hyperdrive: string, say: Reporter): Promise<void> {
  if (await env.cf.script(env.account, worker)) {
    await env.cf.deleteScript(env.account, worker);
    await say.done(`Deleted the Worker ${worker} and its address.`);
  }
  const h = (await env.cf.hyperdriveList(env.account)).find((x) => x.name === hyperdrive);
  if (h) {
    await env.cf.deleteHyperdrive(env.account, h.id);
    await say.done(`Deleted the Hyperdrive connection ${hyperdrive}.`);
  }
}

// Removes an app: every Worker, address, connection, sending domain and record the instance made
// for it. With `data`, its database and files too; without, they stay for adding it back.
export async function remove(env: DeployEnv, app: App, data: boolean, done: string[]): Promise<void> {
  const say = new Reporter({ done, warnings: [] } as unknown as Run, async () => {});
  for (const pr of app.previews) {
    const n = names(app.name, { kind: "preview", pr });
    await removeWorker(env, n.worker, n.hyperdrive, say);
  }
  const prod = names(app.name, { kind: "prod" });
  await removeWorker(env, prod.worker, prod.hyperdrive, say);
  for (const d of await env.cf.domains(env.account, app.address)) if (d.service === app.name) await env.cf.detachDomain(env.account, d.id);
  if (env.resend) {
    const domain = await env.resend.findDomain(app.address);
    if (domain) {
      await env.resend.deleteDomain(domain.id);
      await say.done(`Deleted the sending domain ${app.address}.`);
    }
    const key = await env.resend.findKey(sendKeyName(app.address));
    if (key) await env.resend.deleteKey(key);
  }
  for (const record of await env.cf.commented(app.zone.id, dnsComment(app.name))) await env.cf.deleteRecord(app.zone.id, record.id);
  if (!data) {
    done.push("Kept the app's database and files; adding it back with the same name finds them.");
    return;
  }
  if (env.neon && app.resources.neonProject) {
    await env.neon.deleteProject(app.resources.neonProject);
    await say.done("Deleted the app's Neon project and every backup in it.");
  }
  for (const bucket of [prod.bucket, names(app.name, { kind: "preview", pr: 0 }).bucket]) {
    if (!(await env.cf.bucketExists(env.account, bucket))) continue;
    try {
      await env.cf.deleteBucket(env.account, bucket);
      await say.done(`Deleted the file bucket ${bucket}.`);
    } catch {
      await env.cf.expireBucket(env.account, bucket, 1);
      done.push(`The file bucket ${bucket} still holds files; they now expire within a day, then delete the empty bucket in Cloudflare, R2.`);
    }
  }
}

export type { Zone };
