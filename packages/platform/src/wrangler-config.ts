import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { SCREEN_PATHS } from "./runtime/screens.js";

export interface WranglerInput {
  config: Config;
  worker: string;
  hostname: string;
  accountId: string;
  hyperdriveId: string | undefined;
  vars: Record<string, string>;
  bucket?: string | undefined;
}

export const AUTH_LIMIT = { limit: 10, period: 60 } as const;

// Wrangler deploys this generated module, which exports the app's handler and the live room
// class, so the app's own worker file never has to export platform code. It and the Wrangler
// config sit in .platform/, and Wrangler reads every path in the config relative to it.
export const ENTRY_FILE = "entry.ts";

const fromGenerated = (path: string) => `../${path.replace(/^\.\//, "")}`;

export function entryModule(worker: string): string {
  return `// Written by @celsoft/platform at deploy; never edit or commit it.\nimport app from ${JSON.stringify(fromGenerated(worker))};\nexport default app;\nexport const LiveRoom = app.LiveRoom;\n`;
}

export function wranglerConfig({ config, worker, hostname, accountId, hyperdriveId, vars, bucket }: WranglerInput): object {
  const auth = config.auth;
  return {
    name: worker,
    account_id: accountId,
    main: ENTRY_FILE,
    compatibility_date: config.compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    routes: [{ pattern: hostname, custom_domain: true }],
    observability: { enabled: true },
    vars: { ...vars, APP_NAME: config.name, LIVE_ROOMS: config.live ? "on" : "off", ...(auth && { AUTH_ORGANIZATIONS: auth.organizations ? "on" : "off" }) },
    ...(config.frontend && {
      assets: { directory: fromGenerated(config.frontend), not_found_handling: "single-page-application", run_worker_first: ["/api/*", ...(auth ? SCREEN_PATHS : [])] },
    }),
    ...(hyperdriveId && { hyperdrive: [{ binding: "DB", id: hyperdriveId }] }),
    ...(bucket && { r2_buckets: [{ binding: "FILES", bucket_name: bucket }] }),
    // The room class is always deployed, so turning live off and on never needs a Durable Object migration.
    durable_objects: { bindings: [{ name: "LIVE", class_name: "LiveRoom" }] },
    migrations: [{ tag: "live-rooms-v1", new_sqlite_classes: ["LiveRoom"] }],
    ...(auth && { ratelimits: [{ name: "AUTH_LIMIT", namespace_id: namespaceId(worker), simple: AUTH_LIMIT }] }),
  };
}

// Rate limit namespaces are account-wide integers, so each Worker gets its own from its name.
export function namespaceId(worker: string): string {
  return String(1000 + (createHash("sha256").update(worker).digest().readUInt32BE(0) % 2_000_000_000));
}
