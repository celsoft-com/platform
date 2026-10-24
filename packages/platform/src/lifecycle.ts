import type { Config } from "./config.js";
import type { Branch, Ports } from "./ports.js";
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
            () => ports.neon.createBranch(project, n.neonBranch!, prod.id),
            { id: "(new)", name: n.neonBranch! },
          );

    if (target.kind === "prod") {
      const stamp = (ctx.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").slice(0, 15);
      await run.mutate(`create Neon backup branch backup-${stamp}`, () => ports.neon.createBranch(project, `backup-${stamp}`, prod.id), undefined);
    }

    const uri = run.dryRun && branch.id === "(new)" ? undefined : await ports.neon.connectionUri(project, branch.id);

    if (uri) {
      await run.mutate(`run migrations on ${branch.name}`, () => ports.migrator.migrate(config.database!.migrate, uri), undefined);
    } else {
      run.note(`would run migrations on ${branch.name}`);
    }

    hyperdriveId = await ensureHyperdrive(ctx, n.hyperdrive, uri);
  }

  const wrangler = wranglerConfig({ config, worker: n.worker, hostname, accountId, hyperdriveId });
  await run.mutate(`deploy Worker ${n.worker} at https://${hostname}`, () => ports.wrangler.deploy(wrangler, secrets), undefined);
  return { hostname };
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

async function ensureHyperdrive({ ports, run }: Context, name: string, uri: string | undefined): Promise<string> {
  const existing = await ports.cloudflare.findHyperdrive(name);
  if (!uri) {
    run.note(existing ? `would check Hyperdrive config ${name}` : `would create Hyperdrive config ${name}`);
    return existing?.id ?? "(new)";
  }
  if (!existing) {
    return (await run.mutate(`create Hyperdrive config ${name}`, () => ports.cloudflare.createHyperdrive(name, uri), { id: "(new)", name, origin: "" })).id;
  }
  if (existing.origin !== originOf(uri)) {
    await run.mutate(`point Hyperdrive config ${name} at ${originOf(uri)}`, () => ports.cloudflare.updateHyperdrive(existing.id, uri), existing);
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
