import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { Branch, MailDomain, Ports, Zone } from "./ports.js";
import type { Run } from "./run.js";
import { names, originOf, previewHostname, type Target } from "./target.js";
import { wranglerConfig } from "./wrangler-config.js";

export interface Context {
  config: Config;
  ports: Ports;
  run: Run;
  secrets: Record<string, string>;
  now?: () => Date;
}

export class PreflightError extends Error {}

export const MIN_POSTGRES = 18;

// uuidv7(), the default for every id, arrived in Postgres 18.
export async function requirePostgres(neon: Ports["neon"], project: string): Promise<void> {
  const version = await neon.postgresVersion(project);
  if (version < MIN_POSTGRES) {
    throw new PreflightError(`Neon project ${project} runs Postgres ${version}; the platform needs ${MIN_POSTGRES} or later, so create the project again on Postgres ${MIN_POSTGRES}`);
  }
}

export const UNGENERATED = "the schema has changes with no migration; run `npx @celsoft/platform db generate`, review the SQL in drizzle/, and commit it";

export async function deploy(ctx: Context, target: Target): Promise<{ hostname: string }> {
  const { config, ports, run } = ctx;
  const secrets = requireSecrets(config, ctx.secrets);
  const n = names(config, target);
  if (config.database && !(await ports.migrator.upToDate())) throw new PreflightError(UNGENERATED);

  const accountId = await ports.cloudflare.accountId();
  const zone = await ports.cloudflare.findZone(config.hostname);
  if (!zone) throw new PreflightError(`no Cloudflare zone for ${config.hostname}; add the apex domain to this account, or check the token's zone access`);
  const hostname = target.kind === "prod" ? config.hostname : previewHostname(n.worker, zone.name);

  let hyperdriveId: string | undefined;
  if (config.database) {
    const project = config.database.neonProject;
    await requirePostgres(ports.neon, project);
    const prod = await ports.neon.defaultBranch(project);

    const branch =
      target.kind === "prod"
        ? prod
        : await run.ensure<Branch>(
            `Neon branch ${n.neonBranch}`,
            () => ports.neon.findBranch(project, n.neonBranch!),
            () => ports.neon.createBranch(project, n.neonBranch!, prod.id, true),
            { id: "(new)", name: n.neonBranch! },
          );

    if (target.kind === "prod") await backup(ctx, project, prod);

    const uri = run.dryRun && branch.id === "(new)" ? undefined : await ports.neon.connectionUri(project, branch.id);

    if (uri) {
      await run.mutate(`run migrations on ${branch.name}`, () => ports.migrator.migrate(uri), undefined);
    } else {
      run.note(`would run migrations on ${branch.name}`);
    }

    hyperdriveId = await ensureHyperdrive(ctx, n.hyperdrive, uri);
  }

  const existingSecrets = await ports.cloudflare.workerSecretNames(n.worker);
  const generated: Record<string, string> = {};
  if (config.auth && !existingSecrets.includes("BETTER_AUTH_SECRET")) {
    generated.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
    run.note(`generate BETTER_AUTH_SECRET for ${n.worker}`);
  }

  const sending = config.email && target.kind === "prod";
  if (sending) {
    const domain = await ensureMailDomain(ctx, hostname, zone);
    if (!existingSecrets.includes("EMAIL_API_KEY")) {
      const key = await sendKey(ctx, hostname, domain.id);
      if (key) generated.EMAIL_API_KEY = key;
    }
  }

  if (config.files) await ensureBucket(ctx, n.bucket, target.kind === "preview");

  const vars: Record<string, string> = { APP_URL: `https://${hostname}` };
  if (config.email) {
    Object.assign(vars, { EMAIL_MODE: sending ? "send" : "capture", EMAIL_FROM: `noreply@${hostname}` });
  }
  if (config.files && n.filesPrefix) vars.FILES_PREFIX = n.filesPrefix;

  const wrangler = wranglerConfig({ config, worker: n.worker, hostname, accountId, hyperdriveId, vars, bucket: config.files ? n.bucket : undefined });
  await run.mutate(`deploy Worker ${n.worker} at https://${hostname}`, () => ports.wrangler.deploy(wrangler, { ...secrets, ...generated }), undefined);
  return { hostname };
}

export const PREVIEW_FILES_DAYS = 14;

// The shared preview bucket expires files after two weeks, a backstop for cleanups that never ran.
async function ensureBucket({ ports, run }: Context, bucket: string, preview: boolean): Promise<void> {
  await run.ensure(`R2 bucket ${bucket}`, async () => ((await ports.cloudflare.findBucket(bucket)) ? true : undefined), async () => {
    await ports.cloudflare.createBucket(bucket);
    return true;
  }, true);
  if (preview && (run.dryRun || (await ports.cloudflare.bucketExpiryDays(bucket)) !== PREVIEW_FILES_DAYS)) {
    await run.mutate(`expire files in ${bucket} after ${PREVIEW_FILES_DAYS} days`, () => ports.cloudflare.setBucketExpiry(bucket, PREVIEW_FILES_DAYS), undefined);
  }
}

export const DEV_BRANCH = "dev";
export const DEV_URL = "http://localhost:8787";

// Runs the app locally against its own Neon branch, copied from prod once and kept between runs.
export async function dev(ctx: Context): Promise<void> {
  const { config, ports, run } = ctx;
  const secrets = requireSecrets(config, ctx.secrets);

  let uri: string | undefined;
  if (config.database) {
    const project = config.database.neonProject;
    await requirePostgres(ports.neon, project);
    const prod = await ports.neon.defaultBranch(project);
    const branch = await run.ensure<Branch>(
      `Neon branch ${DEV_BRANCH}`,
      () => ports.neon.findBranch(project, DEV_BRANCH),
      () => ports.neon.createBranch(project, DEV_BRANCH, prod.id, true),
      { id: "(new)", name: DEV_BRANCH },
    );
    uri = await ports.neon.connectionUri(project, branch.id);
    await run.mutate("generate migrations from the schema", () => ports.migrator.generate(), undefined);
    await run.mutate(`run migrations on ${DEV_BRANCH}`, () => ports.migrator.migrate(uri!), undefined);
  }

  const vars: Record<string, string> = { APP_URL: DEV_URL, ...(config.email && { EMAIL_MODE: "capture", EMAIL_FROM: "noreply@localhost" }) };
  const { routes: _routes, account_id: _account, ...local } = wranglerConfig({
    config,
    worker: `${config.name}-dev`,
    hostname: "localhost",
    accountId: "",
    hyperdriveId: config.database ? "local" : undefined,
    vars,
    // wrangler dev keeps this bucket on disk locally; nothing is created in Cloudflare.
    bucket: config.files ? `${config.name}-dev` : undefined,
  }) as Record<string, unknown>;
  const devSecrets = { ...secrets, ...(config.auth && { BETTER_AUTH_SECRET: "local-development-only" }) };
  run.note(`serving at ${DEV_URL}; email is captured to this terminal`);
  await ports.wrangler.dev(local, devSecrets, uri);
}

export const MANAGED_COMMENT = "managed by @celsoft/platform";

// The app sends from its own hostname: Resend's DKIM and bounce records sit on names below it,
// so the zone's existing mail records are never touched.
async function ensureMailDomain({ ports, run }: Context, hostname: string, zone: Zone): Promise<MailDomain> {
  const domain = await run.ensure(
    `Resend sending domain ${hostname}`,
    () => ports.mail.findDomain(hostname),
    () => ports.mail.createDomain(hostname),
    { id: "(new)", name: hostname, verified: false, records: [] },
  );

  // Resend names records relative to the zone, not to the sending hostname.
  const wanted = domain.records.map((record) => ({ ...record, name: `${record.name}.${zone.name}` }));
  const label = (name: string) => name.slice(0, -(hostname.length + 1)) || name;

  for (const record of wanted) {
    const existing = await ports.cloudflare.dnsRecords(zone.id, record.name);
    if (existing.some((e) => e.type === record.type && unquote(e.content) === unquote(record.content))) {
      run.note(`✓ ${record.type} record ${label(record.name)}`);
      continue;
    }
    if (existing.some((e) => e.type === record.type && !e.managed)) {
      throw new PreflightError(`${label(record.name)} below the app hostname already has a ${record.type} record the platform did not create; remove it or send email from another hostname`);
    }
    await run.mutate(`create ${record.type} record ${label(record.name)}`, () => ports.cloudflare.createDnsRecord(zone.id, record), undefined);
  }

  const stale = (await ports.cloudflare.managedDnsRecords(zone.id)).filter(
    (e) => e.name.endsWith(`.${hostname}`) && !wanted.some((w) => w.type === e.type && w.name === e.name),
  );
  for (const record of stale) {
    await run.mutate(`delete stale ${record.type} record ${label(record.name)}`, () => ports.cloudflare.deleteDnsRecord(zone.id, record.id), undefined);
  }

  if (!domain.verified) {
    await run.mutate(`ask Resend to verify ${hostname}; email sends once it does, usually within minutes`, () => ports.mail.verifyDomain(domain.id), undefined);
  }
  return domain;
}

// A Resend key is only readable when created, so a Worker missing its key gets a fresh one.
const sendKeyName = (hostname: string) => `platform ${hostname}`;

async function sendKey({ ports, run }: Context, hostname: string, domainId: string): Promise<string | undefined> {
  const name = sendKeyName(hostname);
  const old = await ports.mail.findApiKey(name);
  if (old) await run.mutate(`replace Resend sending key for ${hostname}`, () => ports.mail.deleteApiKey(old), undefined);
  return run.mutate(`create Resend sending key for ${hostname}`, () => ports.mail.createSendKey(name, domainId), undefined);
}

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "");
}

export async function cleanup(ctx: Context, pr: number): Promise<void> {
  const { config, ports, run } = ctx;
  const n = names(config, { kind: "preview", pr });

  if (await ports.cloudflare.findWorker(n.worker)) {
    await run.mutate(`delete Worker ${n.worker}`, () => ports.cloudflare.deleteWorker(n.worker), undefined);
  }

  const hyperdrive = await ports.cloudflare.findHyperdrive(n.hyperdrive);
  if (hyperdrive) {
    await run.mutate(`delete Hyperdrive config ${n.hyperdrive}`, () => ports.cloudflare.deleteHyperdrive(hyperdrive.id), undefined);
  }

  if (config.database) {
    const project = config.database.neonProject;
    const branch = await ports.neon.findBranch(project, n.neonBranch!);
    if (branch) {
      await run.mutate(`delete Neon branch ${branch.name}`, () => ports.neon.deleteBranch(project, branch.id), undefined);
    }
  }

  if (config.files && (await ports.cloudflare.findBucket(n.bucket))) {
    await run.mutate(`delete files under ${n.filesPrefix} in ${n.bucket}`, () => ports.cloudflare.deleteObjects(n.bucket, n.filesPrefix), 0);
  }
}

// Deletes everything the platform made for the app. Without `data` it keeps what holds the app's
// data: prod tables, backups, the dev branch and the prod file bucket.
export async function destroy(ctx: Context, { data }: { data: boolean }): Promise<void> {
  const { config, ports, run } = ctx;
  const prod = names(config, { kind: "prod" });
  const previews = `${config.name}-pr-`;

  const workers = [...((await ports.cloudflare.findWorker(prod.worker)) ? [prod.worker] : []), ...(await ports.cloudflare.listWorkers(previews))];
  for (const worker of workers) await run.mutate(`delete Worker ${worker}`, () => ports.cloudflare.deleteWorker(worker), undefined);

  const prodHyperdrive = await ports.cloudflare.findHyperdrive(prod.hyperdrive);
  for (const h of [...(prodHyperdrive ? [prodHyperdrive] : []), ...(await ports.cloudflare.listHyperdrives(previews))]) {
    await run.mutate(`delete Hyperdrive config ${h.name}`, () => ports.cloudflare.deleteHyperdrive(h.id), undefined);
  }

  if (config.database) {
    const project = config.database.neonProject;
    const doomed = [...(await ports.neon.listBranches(project, "pr-"))];
    if (data) doomed.push(...(await ports.neon.listBranches(project, BACKUP_PREFIX)), ...[await ports.neon.findBranch(project, DEV_BRANCH)].filter((b) => b !== undefined));
    for (const branch of doomed) await run.mutate(`delete Neon branch ${branch.name}`, () => ports.neon.deleteBranch(project, branch.id), undefined);
    if (data) {
      const main = await ports.neon.defaultBranch(project);
      const uri = await ports.neon.connectionUri(project, main.id);
      await run.mutate(`drop every table on ${main.name}`, () => ports.migrator.dropAll(uri), undefined);
    }
  }

  if (config.files) {
    for (const bucket of [names(config, { kind: "preview", pr: 0 }).bucket, ...(data ? [prod.bucket] : [])]) {
      if (!(await ports.cloudflare.findBucket(bucket))) continue;
      await run.mutate(`empty and delete R2 bucket ${bucket}`, async () => {
        await ports.cloudflare.deleteObjects(bucket, "");
        await ports.cloudflare.deleteBucket(bucket);
      }, undefined);
    }
  }

  if (config.email) {
    const domain = await ports.mail.findDomain(config.hostname);
    if (domain) await run.mutate(`delete Resend sending domain ${config.hostname}`, () => ports.mail.deleteDomain(domain.id), undefined);
    const key = await ports.mail.findApiKey(sendKeyName(config.hostname));
    if (key) await run.mutate(`delete Resend sending key for ${config.hostname}`, () => ports.mail.deleteApiKey(key), undefined);
    const zone = await ports.cloudflare.findZone(config.hostname);
    const records = zone ? (await ports.cloudflare.managedDnsRecords(zone.id)).filter((r) => r.name.endsWith(`.${config.hostname}`)) : [];
    for (const record of records) {
      await run.mutate(`delete ${record.type} record ${record.name}`, () => ports.cloudflare.deleteDnsRecord(zone!.id, record.id), undefined);
    }
  }
}

export const BACKUP_PREFIX = "backup-";
export const BACKUPS_KEPT = 3;

// Neon includes 10 branches per project, so only the newest few backups are kept.
async function backup({ ports, run, now }: Context, project: string, prod: Branch): Promise<void> {
  const name = `${BACKUP_PREFIX}${(now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
  await run.mutate(`create Neon backup branch ${name}`, () => ports.neon.createBranch(project, name, prod.id, false), undefined);

  const backups = (await ports.neon.listBranches(project, BACKUP_PREFIX)).sort((a, b) => b.name.localeCompare(a.name));
  for (const old of backups.slice(BACKUPS_KEPT)) {
    await run.mutate(`delete old Neon backup branch ${old.name}`, () => ports.neon.deleteBranch(project, old.id), undefined);
  }
}

async function ensureHyperdrive({ ports, run }: Context, name: string, uri: string | undefined): Promise<string> {
  const existing = await ports.cloudflare.findHyperdrive(name);
  if (!uri) {
    run.note(existing ? `would check Hyperdrive config ${name}` : `would create Hyperdrive config ${name}`);
    return existing?.id ?? "(new)";
  }
  if (!existing) {
    return (await run.mutate(`create Hyperdrive config ${name}`, () => ports.cloudflare.createHyperdrive(name, uri), { id: "(new)", name, origin: "", cached: false })).id;
  }
  if (existing.origin !== originOf(uri) || existing.cached) {
    await run.mutate(`update Hyperdrive config ${name} (new origin or caching on)`, () => ports.cloudflare.updateHyperdrive(existing.id, uri), existing);
  } else {
    run.note(`✓ Hyperdrive config ${name}`);
  }
  return existing.id;
}

function requireSecrets(config: Config, available: Record<string, string>): Record<string, string> {
  const missing = config.secrets.filter((name) => !available[name]);
  if (missing.length > 0) {
    throw new PreflightError(`missing secrets: ${missing.join(", ")}; add them to the GitHub Environment, or to .env.secrets for local runs`);
  }
  return Object.fromEntries(config.secrets.map((name) => [name, available[name]!]));
}
