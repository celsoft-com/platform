import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import { LEGACY_BUCKET_MARKER, LEGACY_DNS_COMMENT, legacyNames } from "./legacy.js";
import type { Branch, Hyperdrive, MailDomain, Ports, Repo, Zone } from "./ports.js";
import type { Run } from "./run.js";
import { names, originOf, previewHostname, previewPattern, type Target } from "./target.js";
import { wranglerConfig } from "./wrangler-config.js";

export interface Context {
  config: Config;
  ports: Ports;
  run: Run;
  secrets: Record<string, string>;
  // The repo running this, which must be the one the app's name is claimed for.
  repo: () => Promise<Repo>;
  // Which optional providers have keys; destroy skips one without.
  providers?: { neon: boolean; mail: boolean };
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
  const hostname = target.kind === "prod" ? config.hostname : previewHostname(target.pr, config.hostname);
  await checkClaim(ctx, true);

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
  const oldBucket = config.files && target.kind === "prod" ? await legacyFilesBucket(ctx) : undefined;
  if (oldBucket) await copyFiles(ctx, oldBucket, n.bucket, false);

  const vars: Record<string, string> = { APP_URL: `https://${hostname}` };
  if (config.email) {
    Object.assign(vars, { EMAIL_MODE: sending ? "send" : "capture", EMAIL_FROM: `noreply@${hostname}` });
  }
  if (config.files && n.filesPrefix) vars.FILES_PREFIX = n.filesPrefix;

  const wrangler = wranglerConfig({ config, worker: n.worker, hostname, accountId, hyperdriveId, vars, bucket: config.files ? n.bucket : undefined });
  await run.mutate(`deploy Worker ${n.worker} at https://${hostname}`, () => ports.wrangler.deploy(wrangler, { ...secrets, ...generated }), undefined);

  // The old Worker kept writing to the old bucket until now, so what it added is copied before the old bucket goes.
  if (oldBucket && run.dryRun) run.note(`would copy files added since, then delete ${oldBucket}`);
  if (oldBucket && !run.dryRun) {
    await copyFiles(ctx, oldBucket, n.bucket, true);
    await run.mutate(`delete R2 bucket ${oldBucket}, now copied to ${n.bucket}`, async () => {
      await ports.cloudflare.deleteObjects(oldBucket, "");
      await ports.cloudflare.deleteBucket(oldBucket);
    }, undefined);
  }
  return { hostname };
}

// The app's name belongs to one repo per Cloudflare account; the first deploy claims it.
async function checkClaim(ctx: Context, claimIfFree: boolean): Promise<void> {
  const { config, ports, run } = ctx;
  const repo = await ctx.repo();
  let claim = await ports.registry.get(config.name);
  if (!claim && claimIfFree) {
    const won = await run.mutate(`claim the app name ${config.name} for ${repo.name}`, () => ports.registry.claim(config.name, repo), true);
    if (won) return;
    claim = await ports.registry.get(config.name);
  }
  if (!claim) return;
  if (claim.id !== repo.id) {
    throw new PreflightError(
      `the app name ${config.name} belongs to ${claim.name} in this Cloudflare account, so nothing was changed; if ${repo.name} is meant to take it over, run \`npx @celsoft/platform apps move\` from ${repo.name}`,
    );
  }
  if (claim.name !== repo.name) {
    await run.mutate(`record that ${claim.name} is now ${repo.name}`, () => ports.registry.set(config.name, repo), undefined);
  } else {
    run.note(`✓ app name ${config.name} belongs to ${repo.name}`);
  }
}

// Hands the app's name to the repo running this, for when a different repo takes the app over.
export async function moveApp(ctx: Context): Promise<void> {
  const { config, ports, run } = ctx;
  const repo = await ctx.repo();
  const claim = await ports.registry.get(config.name);
  if (claim?.id === repo.id) return run.note(`✓ app name ${config.name} already belongs to ${repo.name}`);
  await run.mutate(`give the app name ${config.name} to ${repo.name}${claim ? `, taking it from ${claim.name}` : ""}`, () => ports.registry.set(config.name, repo), undefined);
}

// The prod bucket before the `--` names, proven by its old marker.
async function legacyFilesBucket({ config, ports }: Context): Promise<string | undefined> {
  const name = legacyNames(config.name).filesBucket;
  return (await ports.cloudflare.legacyBucketApp(name)) === config.name ? name : undefined;
}

async function copyFiles({ ports, run }: Context, from: string, to: string, onlyMissing: boolean): Promise<void> {
  const present = new Set(onlyMissing ? await ports.cloudflare.listObjects(to, "") : []);
  const keys = (await ports.cloudflare.listObjects(from, "")).filter((key) => key !== LEGACY_BUCKET_MARKER && !present.has(key));
  if (keys.length === 0) return;
  await run.mutate(`copy ${keys.length} files from ${from} to ${to}`, async () => {
    for (const key of keys) await ports.cloudflare.copyObject(from, key, to);
  }, undefined);
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

// Resend chooses these records' names, so the comment is what ties each one to its app.
export const dnsComment = (app: string) => `managed by @celsoft/platform for ${app}`;

// The app sends from its own hostname: Resend's DKIM and bounce records sit on names below it,
// so the zone's existing mail records are never touched.
async function ensureMailDomain({ config, ports, run }: Context, hostname: string, zone: Zone): Promise<MailDomain> {
  const domain = await run.ensure(
    `Resend sending domain ${hostname}`,
    () => ports.mail.findDomain(hostname),
    () => ports.mail.createDomain(hostname),
    { id: "(new)", name: hostname, verified: false, records: [] },
  );

  const comment = dnsComment(config.name);
  const wanted = mailRecords(domain, zone);
  const label = (name: string) => name.slice(0, -(hostname.length + 1)) || name;

  for (const record of wanted) {
    const existing = (await ports.cloudflare.dnsRecords(zone.id, record.name)).filter((e) => e.type === record.type);
    // At a name Resend asked for, a record with the old comment can only be this app's.
    const ours = existing.filter((e) => e.comment === comment || e.comment === LEGACY_DNS_COMMENT);
    const match = existing.find((e) => unquote(e.content) === unquote(record.content));
    if (match) {
      if (match.comment === LEGACY_DNS_COMMENT) {
        await run.mutate(`mark ${record.type} record ${label(record.name)} as ${config.name}'s`, () => ports.cloudflare.setDnsRecordComment(zone.id, match.id, comment), undefined);
      } else {
        run.note(`✓ ${record.type} record ${label(record.name)}`);
      }
      continue;
    }
    if (ours.length < existing.length) {
      throw new PreflightError(`${label(record.name)} below the app hostname already has a ${record.type} record the platform did not create; remove it or send email from another hostname`);
    }
    for (const old of ours) {
      await run.mutate(`delete outdated ${record.type} record ${label(record.name)}`, () => ports.cloudflare.deleteDnsRecord(zone.id, old.id), undefined);
    }
    await run.mutate(`create ${record.type} record ${label(record.name)}`, () => ports.cloudflare.createDnsRecord(zone.id, record, comment), undefined);
  }

  const stale = (await ports.cloudflare.commentedDnsRecords(zone.id, comment)).filter((e) => !wanted.some((w) => w.type === e.type && w.name === e.name));
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

// Resend names records relative to the zone, not to the sending hostname.
function mailRecords(domain: MailDomain, zone: Zone) {
  return domain.records.map((record) => ({ ...record, name: `${record.name}.${zone.name}` }));
}

function unquote(value: string): string {
  return value.replace(/^"|"$/g, "");
}

export async function cleanup(ctx: Context, pr: number): Promise<void> {
  const { config, ports, run } = ctx;
  const n = names(config, { kind: "preview", pr });
  await checkClaim(ctx, false);

  // Found by what exists, not by platform.jsonc, so a preview made with a feature on is still
  // cleaned after that feature is turned off.
  if (await ports.cloudflare.findWorker(n.worker)) await run.mutate(`delete Worker ${n.worker}`, () => ports.cloudflare.deleteWorker(n.worker), undefined);
  const hyperdrive = await ports.cloudflare.findHyperdrive(n.hyperdrive);
  if (hyperdrive) await run.mutate(`delete Hyperdrive config ${n.hyperdrive}`, () => ports.cloudflare.deleteHyperdrive(hyperdrive.id), undefined);

  if (config.database) {
    const project = config.database.neonProject;
    const branch = await ports.neon.findBranch(project, n.neonBranch!);
    if (branch) await run.mutate(`delete Neon branch ${branch.name}`, () => ports.neon.deleteBranch(project, branch.id), undefined);
  }

  if (await ports.cloudflare.findBucket(n.bucket)) {
    await run.mutate(`delete files under ${n.filesPrefix} in ${n.bucket}`, () => ports.cloudflare.deleteObjects(n.bucket, n.filesPrefix), 0);
  }
  await cleanupLegacyPreview(ctx, pr);
}

// A preview made before the `--` names, removed only when its old tags or marker name this app.
async function cleanupLegacyPreview(ctx: Context, pr: number): Promise<void> {
  const { config, ports, run } = ctx;
  const legacy = legacyNames(config.name);
  const name = legacy.preview(pr);

  const worker = await ports.cloudflare.legacyWorker(name);
  const hyperdrive = await ports.cloudflare.findHyperdrive(name);
  const ours = worker?.app === config.name;
  if (ours) await run.mutate(`delete old Worker ${name}`, () => ports.cloudflare.deleteWorker(name), undefined);
  if (hyperdrive && (await legacyHyperdriveIsOurs(ctx, hyperdrive, ours ? worker.hyperdriveIds : []))) {
    await run.mutate(`delete old Hyperdrive config ${name}`, () => ports.cloudflare.deleteHyperdrive(hyperdrive.id), undefined);
  }
  if ((await ports.cloudflare.legacyBucketApp(legacy.previewsBucket)) === config.name) {
    await run.mutate(`delete old files under pr-${pr}/ in ${legacy.previewsBucket}`, () => ports.cloudflare.deleteObjects(legacy.previewsBucket, `pr-${pr}/`), 0);
  }
}

async function legacyHyperdriveIsOurs({ config, ports }: Context, hyperdrive: Hyperdrive, boundIds: string[]): Promise<boolean> {
  if (boundIds.includes(hyperdrive.id)) return true;
  const host = hyperdrive.origin.split("@")[1]?.split("/")[0];
  return Boolean(config.database && host && (await ports.neon.endpointHosts(config.database.neonProject)).includes(host));
}

export interface PreviewPieces {
  pr: number;
  pieces: string[];
}

// Every preview that exists in Cloudflare and Neon, whatever made it, with the pieces found.
export async function findPreviews(ctx: Context): Promise<PreviewPieces[]> {
  const { config, ports } = ctx;
  const legacy = legacyNames(config.name);
  const found = new Map<number, string[]>();
  const add = (pattern: RegExp, name: string, piece: string) => {
    const pr = pattern.exec(name)?.[1];
    if (pr !== undefined) found.set(Number(pr), [...(found.get(Number(pr)) ?? []), piece]);
  };
  const folders = async (bucket: string) => new Set((await ports.cloudflare.listObjects(bucket, "pr-")).map((key) => key.split("/")[0]!));

  for (const [prefix, pattern, old] of [[`${config.name}--pr-`, previewPattern(config.name), ""], [legacy.previewPrefix, legacy.previewPattern, "old "]] as const) {
    for (const worker of await ports.cloudflare.listWorkers(prefix)) add(pattern, worker, `${old}Worker`);
    for (const hyperdrive of await ports.cloudflare.listHyperdrives(prefix)) add(pattern, hyperdrive.name, `${old}Hyperdrive config`);
  }
  if (config.database) {
    for (const branch of await ports.neon.listBranches(config.database.neonProject, "pr-")) add(/^pr-(\d+)$/, branch.name, "Neon branch");
  }
  const bucket = names(config, { kind: "preview", pr: 0 }).bucket;
  if (await ports.cloudflare.findBucket(bucket)) {
    for (const folder of await folders(bucket)) add(/^pr-(\d+)$/, folder, "files");
  }
  if ((await ports.cloudflare.legacyBucketApp(legacy.previewsBucket)) === config.name) {
    for (const folder of await folders(legacy.previewsBucket)) add(/^pr-(\d+)$/, folder, "old files");
  }
  return [...found].map(([pr, pieces]) => ({ pr, pieces })).sort((a, b) => a.pr - b.pr);
}

// Removes every preview whose pull request is no longer open: the backstop for a close whose
// cleanup never ran. Previews are found by what exists in Cloudflare and Neon.
export async function sweep(ctx: Context, open: number[]): Promise<number[]> {
  const { run } = ctx;
  const stale = (await findPreviews(ctx)).map((p) => p.pr).filter((pr) => !open.includes(pr));
  if (stale.length === 0) run.note("✓ no previews left behind");
  for (const pr of stale) {
    run.note(`pull request ${pr} is closed; cleaning up its preview`);
    await cleanup(ctx, pr);
  }
  await removeEmptyLegacyPreviewsBucket(ctx);
  return stale;
}

async function removeEmptyLegacyPreviewsBucket({ config, ports, run }: Context): Promise<void> {
  const bucket = legacyNames(config.name).previewsBucket;
  if ((await ports.cloudflare.legacyBucketApp(bucket)) !== config.name) return;
  if ((await ports.cloudflare.listObjects(bucket, "")).some((key) => key !== LEGACY_BUCKET_MARKER)) return;
  await run.mutate(`delete old R2 bucket ${bucket}, now empty`, async () => {
    await ports.cloudflare.deleteObjects(bucket, "");
    await ports.cloudflare.deleteBucket(bucket);
  }, undefined);
}

// Deletes everything the platform made for the app, found by name whatever platform.jsonc turns on
// now. Without `data` it keeps what holds the app's data: prod tables, backups, the dev branch and
// the prod file bucket. The app's name is released last.
export async function destroy(ctx: Context, { data }: { data: boolean }): Promise<void> {
  const { config, ports, run } = ctx;
  const providers = ctx.providers ?? { neon: true, mail: true };
  const prod = names(config, { kind: "prod" });
  const preview = names(config, { kind: "preview", pr: 0 });
  const legacy = legacyNames(config.name);
  await checkClaim(ctx, false);

  const workers = [
    ...((await ports.cloudflare.findWorker(prod.worker)) ? [prod.worker] : []),
    ...(await ports.cloudflare.listWorkers(`${config.name}--pr-`)).filter((w) => previewPattern(config.name).test(w)),
  ];
  const hyperdrives = [
    ...[await ports.cloudflare.findHyperdrive(prod.hyperdrive)].filter((h) => h !== undefined),
    ...(await ports.cloudflare.listHyperdrives(`${config.name}--pr-`)).filter((h) => previewPattern(config.name).test(h.name)),
  ];
  const buckets = [preview.bucket, ...(data ? [prod.bucket] : [])];

  // What versions before the `--` names left, taken only where their old proof names this app.
  const legacyBound: string[] = [];
  for (const name of (await ports.cloudflare.listWorkers(legacy.previewPrefix)).filter((w) => legacy.previewPattern.test(w))) {
    const worker = await ports.cloudflare.legacyWorker(name);
    if (worker?.app !== config.name) continue;
    workers.push(name);
    legacyBound.push(...worker.hyperdriveIds);
  }
  for (const h of (await ports.cloudflare.listHyperdrives(legacy.previewPrefix)).filter((h) => legacy.previewPattern.test(h.name))) {
    if (await legacyHyperdriveIsOurs(ctx, h, legacyBound)) hyperdrives.push(h);
  }
  for (const bucket of [legacy.previewsBucket, ...(data ? [legacy.filesBucket] : [])]) {
    if ((await ports.cloudflare.legacyBucketApp(bucket)) === config.name) buckets.push(bucket);
  }

  for (const w of workers) await run.mutate(`delete Worker ${w}`, () => ports.cloudflare.deleteWorker(w), undefined);
  for (const h of hyperdrives) await run.mutate(`delete Hyperdrive config ${h.name}`, () => ports.cloudflare.deleteHyperdrive(h.id), undefined);

  if (!config.database) {
    run.note("platform.jsonc names no Neon project, so Neon was not checked");
  } else if (!providers.neon) {
    run.note("! no Neon key is set, so Neon branches were left alone");
  } else {
    const project = config.database.neonProject;
    const doomed = (await ports.neon.listBranches(project, "pr-")).filter((b) => /^pr-\d+$/.test(b.name));
    if (data) doomed.push(...(await ports.neon.listBranches(project, BACKUP_PREFIX)), ...[await ports.neon.findBranch(project, DEV_BRANCH)].filter((b) => b !== undefined));
    for (const branch of doomed) await run.mutate(`delete Neon branch ${branch.name}`, () => ports.neon.deleteBranch(project, branch.id), undefined);
    if (data) {
      const main = await ports.neon.defaultBranch(project);
      const uri = await ports.neon.connectionUri(project, main.id);
      await run.mutate(`drop every table on ${main.name}`, () => ports.migrator.dropAll(uri), undefined);
    }
  }

  for (const bucket of buckets) {
    if (!(await ports.cloudflare.findBucket(bucket))) continue;
    await run.mutate(`empty and delete R2 bucket ${bucket}`, async () => {
      await ports.cloudflare.deleteObjects(bucket, "");
      await ports.cloudflare.deleteBucket(bucket);
    }, undefined);
  }

  const zone = await ports.cloudflare.findZone(config.hostname);
  const records = zone ? await ports.cloudflare.commentedDnsRecords(zone.id, dnsComment(config.name)) : [];
  if (!providers.mail) {
    run.note("! no Resend key is set, so the Resend sending domain and key were left alone");
  } else {
    const domain = await ports.mail.findDomain(config.hostname);
    if (domain && zone) {
      const wanted = new Set(mailRecords(domain, zone).map((r) => r.name));
      records.push(...(await ports.cloudflare.commentedDnsRecords(zone.id, LEGACY_DNS_COMMENT)).filter((r) => wanted.has(r.name)));
    }
    if (domain) await run.mutate(`delete Resend sending domain ${config.hostname}`, () => ports.mail.deleteDomain(domain.id), undefined);
    const key = await ports.mail.findApiKey(sendKeyName(config.hostname));
    if (key) await run.mutate(`delete Resend sending key for ${config.hostname}`, () => ports.mail.deleteApiKey(key), undefined);
  }
  for (const record of records) {
    await run.mutate(`delete ${record.type} record ${record.name}`, () => ports.cloudflare.deleteDnsRecord(zone!.id, record.id), undefined);
  }

  if (await ports.registry.get(config.name)) await run.mutate(`release the app name ${config.name}`, () => ports.registry.release(config.name), undefined);
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
