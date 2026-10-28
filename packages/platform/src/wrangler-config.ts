import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { SCREEN_PATHS, TOKENS_PATH } from "./runtime/screens.js";

export interface WranglerInput {
  config: Config;
  worker: string;
  hostname: string;
  accountId: string;
  hyperdriveId: string | undefined;
  vars: Record<string, string>;
  bucket?: string | undefined;
  // Paths the app's pages claim; each and everything below it reaches the Worker first.
  pages?: string[] | undefined;
  // Where Cloudflare should run the Worker: next to the database, as a placement hint.
  placement?: string | undefined;
}

const AZURE_REGIONS: Record<string, string> = { gwc: "germanywestcentral" };

// Cloudflare's placement hint for a Neon region, such as aws-us-east-2 to aws:us-east-2, or
// nothing for a provider Cloudflare does not take hints for.
export function placementRegion(neonRegion: string): string | undefined {
  const [, provider, region] = /^(aws|azure|gcp)-(.+)$/.exec(neonRegion) ?? [];
  if (!provider || !region) return undefined;
  return `${provider}:${provider === "azure" ? (AZURE_REGIONS[region] ?? region) : region}`;
}

export const AUTH_LIMIT = { limit: 10, period: 60 } as const;

// Wrangler deploys this generated module, which exports the app's handler and the live room
// class, so the app's own worker file never has to export platform code. It and the Wrangler
// config sit in .platform/, and Wrangler reads every path in the config relative to it.
export const ENTRY_FILE = "entry.ts";

const fromGenerated = (path: string) => `../${path.replace(/^\.\//, "")}`;

// Better Auth imports its Kysely adapter even when, as here, it is given a Drizzle one, and Kysely
// is an eighth of the bundle a Worker parses on every start; the deploy points both at this stub.
export const NO_KYSELY_FILE = "no-kysely.cjs";
export const NO_KYSELY_MODULE = `// Written by @celsoft/platform at deploy; never edit or commit it.\nmodule.exports = new Proxy(function () {}, { get: () => function kyselyIsNotBundled() { throw new Error("Kysely is not bundled; the platform reaches the database through Drizzle"); } });\n`;

export function entryModule(worker: string): string {
  return `// Written by @celsoft/platform at deploy; never edit or commit it.\nimport app from ${JSON.stringify(fromGenerated(worker))};\nexport default app;\nexport const LiveRoom = app.LiveRoom;\n`;
}

export function wranglerConfig({ config, worker, hostname, accountId, hyperdriveId, vars, bucket, pages = [], placement }: WranglerInput): object {
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
    // Its id keys cached pages, so a deploy never serves a page an older version rendered.
    version_metadata: { binding: "CF_VERSION_METADATA" },
    // A smaller script starts faster; the live room client is served from its own source, unnamed.
    minify: true,
    alias: { kysely: `./${NO_KYSELY_FILE}`, "@better-auth/kysely-adapter": `./${NO_KYSELY_FILE}` },
    // Every query is a round trip to the database, so the Worker runs next to it, not next to the visitor.
    ...(placement && { placement: { region: placement } }),
    vars: { ...vars, APP_NAME: config.name, LIVE_ROOMS: config.live ? "on" : "off", ...(auth && { AUTH_ORGANIZATIONS: auth.organizations ? "on" : "off", AUTH_API_TOKENS: auth.apiTokens ? "on" : "off", MCP: config.mcp ? "on" : "off", ACCESS: config.access ? "on" : "off" }) },
    ...(config.frontend && {
      assets: { directory: fromGenerated(config.frontend), not_found_handling: "single-page-application", run_worker_first: ["/api/*", ...(auth ? SCREEN_PATHS : []), ...(auth && auth.apiTokens ? [TOKENS_PATH] : []), ...(config.mcp ? ["/mcp", "/.well-known/*"] : []), ...pages.flatMap((p) => [p, `${p}/*`])] },
    }),
    ...(hyperdriveId && { hyperdrive: [{ binding: "DB", id: hyperdriveId }] }),
    ...(bucket && { r2_buckets: [{ binding: "FILES", bucket_name: bucket }] }),
    // The room class is always deployed, so turning live off and on never needs a Durable Object migration.
    durable_objects: { bindings: [{ name: "LIVE", class_name: "LiveRoom" }] },
    migrations: [{ tag: "live-rooms-v1", new_sqlite_classes: ["LiveRoom"] }],
    ratelimits: [
      ...(auth ? [{ name: "AUTH_LIMIT", namespace_id: namespaceId(worker), simple: AUTH_LIMIT }] : []),
      { name: "API_LIMIT", namespace_id: namespaceId(`${worker}:api`), simple: { limit: config.rateLimit, period: 60 } },
    ],
  };
}

// Rate limit namespaces are account-wide integers, so each Worker gets its own from its name.
export function namespaceId(worker: string): string {
  return String(1000 + (createHash("sha256").update(worker).digest().readUInt32BE(0) % 2_000_000_000));
}
