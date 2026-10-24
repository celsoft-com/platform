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

export async function deploy(ctx: Context, target: Target): Promise<{ hostname: string }> {
  const { config, ports, run } = ctx;
  const secrets = requireSecrets(config, ctx.secrets);
  const n = names(config, target);

  const accountId = await ports.cloudflare.accountId();
  const zone = await ports.cloudflare.findZone(config.hostname);
  if (!zone) throw new PreflightError(`no Cloudflare zone for ${config.hostname}; add the apex domain to this account, or check the token's zone access`);
  const hostname = target.kind === "prod" ? config.hostname : previewHostname(n.worker, zone.name);

  let hyperdriveId: string | undefined;
  if (config.database) {
    const project = config.database.neonProject;
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
      // Auth tables first, so the app's own migrations can reference them.
      if (config.auth) await run.mutate(`update auth tables on ${branch.name}`, () => ports.migrator.migrateAuth(uri), undefined);
      await run.mutate(`run migrations on ${branch.name}`, () => ports.migrator.migrate(config.database!.migrate, uri), undefined);
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

  const vars: Record<string, string> = { APP_URL: `https://${hostname}` };
  if (config.email) {
    Object.assign(vars, { EMAIL_MODE: sending ? "send" : "capture", EMAIL_FROM: `noreply@${hostname}`, EMAIL_REPLY_TO: config.email.replyTo });
  }

  const wrangler = wranglerConfig({ config, worker: n.worker, hostname, accountId, hyperdriveId, vars });
  await run.mutate(`deploy Worker ${n.worker} at https://${hostname}`, () => ports.wrangler.deploy(wrangler, { ...secrets, ...generated }), undefined);
  return { hostname };
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

  for (const record of domain.records) {
    const name = `${record.name}.${hostname}`;
    const existing = await ports.cloudflare.dnsRecords(zone.id, name);
    if (existing.some((e) => e.type === record.type && unquote(e.content) === unquote(record.content))) {
      run.note(`✓ ${record.type} record ${name}`);
      continue;
    }
    if (existing.some((e) => e.type === record.type && !e.managed)) {
      throw new PreflightError(`${name} already has a ${record.type} record the platform did not create; remove it or send email from another hostname`);
    }
    await run.mutate(`create ${record.type} record ${name}`, () => ports.cloudflare.createDnsRecord(zone.id, { ...record, name }), undefined);
  }

  if (!domain.verified) {
    await run.mutate(`ask Resend to verify ${hostname}; email sends once it does, usually within minutes`, () => ports.mail.verifyDomain(domain.id), undefined);
  }
  return domain;
}

// A Resend key is only readable when created, so a Worker missing its key gets a fresh one.
async function sendKey({ ports, run }: Context, hostname: string, domainId: string): Promise<string | undefined> {
  const name = `platform ${hostname}`;
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
