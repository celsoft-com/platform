import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "./config.js";
import { fakePorts } from "./fakes.js";
import { cleanup, deploy, destroy, dnsComment, findPreviews, moveApp, neonProject, PreflightError, requireProjectKey, sweep, type Context } from "./lifecycle.js";
import { Run } from "./run.js";

const config: Config = parseConfig(`{
  "name": "demo",
  "hostname": "demo.example.com",
  "worker": "src/worker.ts",
  "compatibilityDate": "2026-10-01",
  "frontend": { "dir": "dist" },
  "database": true,
  "secrets": ["SESSION_SECRET"]
}`);

let ports: ReturnType<typeof fakePorts>;
let log: string[];

function ctx(dryRun = false): Context {
  return {
    config,
    ports,
    run: new Run(dryRun, (line) => log.push(line)),
    secrets: { SESSION_SECRET: "s3cret", UNRELATED: "x", NEON_PROJECT_ID: "quiet-meadow-12345678" },
    repo: async () => ({ id: 101, name: "acme/demo" }),
    now: () => new Date("2026-10-24T12:34:56Z"),
  };
}

beforeEach(() => {
  ports = fakePorts();
  log = [];
});

describe("deploy prod", () => {
  it("backs up, migrates prod, creates Hyperdrive and deploys on the prod hostname", async () => {
    const { hostname } = await deploy(ctx(), { kind: "prod" });

    expect(hostname).toBe("demo.example.com");
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production", "backup-20261024T123456"]);
    expect(ports.migrator.runs).toEqual(["postgresql://owner:secret@br-prod.neon.test/app"]);
    expect(ports.cloudflare.hyperdrives).toMatchObject([{ name: "demo" }]);

    const [d] = ports.wrangler.deploys;
    expect(d?.config).toMatchObject({
      name: "demo",
      routes: [{ pattern: "demo.example.com", custom_domain: true }],
      hyperdrive: [{ binding: "DB", id: ports.cloudflare.hyperdrives[0]!.id }],
      assets: { directory: "../dist" },
    });
    expect(d?.secrets).toEqual({ SESSION_SECRET: "s3cret" });
  });

  it("turns off query caching on an existing Hyperdrive config", async () => {
    await deploy(ctx(), { kind: "prod" });
    ports.cloudflare.hyperdrives[0]!.cached = true;
    await deploy(ctx(), { kind: "prod" });
    expect(ports.cloudflare.hyperdrives[0]!.cached).toBe(false);
  });

  it("keeps only the newest backups", async () => {
    for (const day of ["01", "02", "03", "04", "05"]) {
      const c = ctx();
      c.now = () => new Date(`2026-10-${day}T00:00:00Z`);
      await deploy(c, { kind: "prod" });
    }
    expect(ports.neon.branches.map((b) => b.name)).toEqual([
      "production",
      "backup-20261003T000000",
      "backup-20261004T000000",
      "backup-20261005T000000",
    ]);
  });

  it("stops before touching anything when the schema has ungenerated changes", async () => {
    ports.migrator.current = false;
    await expect(deploy(ctx(), { kind: "prod" })).rejects.toThrow(/db generate/);
    expect(ports.neon.branches).toHaveLength(1);
    expect(ports.wrangler.deploys).toEqual([]);
  });

  it("stops before deploying when migrations fail", async () => {
    ports.migrator.failWith = new Error("migration failed");
    await expect(deploy(ctx(), { kind: "prod" })).rejects.toThrow("migration failed");
    expect(ports.wrangler.deploys).toEqual([]);
  });

  it("stops before touching anything when a secret is missing", async () => {
    const c = ctx();
    c.secrets = {};
    await expect(deploy(c, { kind: "prod" })).rejects.toThrow(PreflightError);
    expect(ports.neon.branches).toHaveLength(1);
  });
});

describe("preview", () => {
  it("creates a branch, Hyperdrive and Worker named for the PR", async () => {
    const { hostname } = await deploy(ctx(), { kind: "preview", pr: 7 });

    expect(hostname).toBe("pr-7.demo.example.com");
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production", "pr-7"]);
    expect(ports.cloudflare.hyperdrives.map((h) => h.name)).toEqual(["demo--pr-7"]);
    expect(ports.wrangler.deploys[0]?.config).toMatchObject({ name: "demo--pr-7", routes: [{ pattern: "pr-7.demo.example.com", custom_domain: true }] });
  });

  it("reuses everything on a second push", async () => {
    await deploy(ctx(), { kind: "preview", pr: 7 });
    await deploy(ctx(), { kind: "preview", pr: 7 });

    expect(ports.neon.branches).toHaveLength(2);
    expect(ports.cloudflare.hyperdrives).toHaveLength(1);
    expect(ports.wrangler.deploys).toHaveLength(2);
  });

  it("changes nothing on a dry run", async () => {
    await deploy(ctx(true), { kind: "preview", pr: 7 });

    expect(ports.neon.branches).toHaveLength(1);
    expect(ports.cloudflare.hyperdrives).toEqual([]);
    expect(ports.wrangler.deploys).toEqual([]);
    expect(log.join("\n")).toMatch(/would create Neon branch pr-7/);
    expect(log.join("\n")).toMatch(/would deploy Worker demo--pr-7/);
  });

  it("cleanup deletes the Worker, Hyperdrive and branch, and is safe to repeat", async () => {
    await deploy(ctx(), { kind: "preview", pr: 7 });
    await cleanup(ctx(), 7);
    await cleanup(ctx(), 7);

    expect(ports.cloudflare.workers.has("demo--pr-7")).toBe(false);
    expect(ports.cloudflare.hyperdrives).toEqual([]);
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production"]);
  });
});

describe("auth and email", () => {
  const authConfig: Config = { ...config, auth: { organizations: false, apiTokens: false, signup: "invite" }, email: true };
  const authCtx = (dryRun = false): Context => ({ ...ctx(dryRun), config: authConfig });

  it("runs the Worker next to the database: the Neon project's region becomes the placement hint", async () => {
    await deploy(ctx(), { kind: "prod" });
    expect(ports.wrangler.deploys[0]!.config.placement).toEqual({ region: "aws:us-east-2" });
    ports.neon.regionId = "azure-gwc";
    await deploy(ctx(), { kind: "preview", pr: 3 });
    expect(ports.wrangler.deploys[1]!.config.placement).toEqual({ region: "azure:germanywestcentral" });
    ports.neon.regionId = "elsewhere-1";
    await deploy(ctx(), { kind: "prod" });
    expect(ports.wrangler.deploys[2]!.config.placement).toBeUndefined();
  });

  it("writes the access triggers and the app's static points after migrations, on prod and previews, and never without auth", async () => {
    const points = { about: { grants: [{ to: { everyone: true as const }, level: "read" as const }] } };
    await deploy({ ...authCtx(), staticPoints: points }, { kind: "prod" });
    expect(ports.migrator.points).toEqual([{ databaseUrl: ports.migrator.runs.at(-1), points }]);
    expect(log.some((line) => line.includes("write access triggers and static control points about"))).toBe(true);
    await deploy({ ...authCtx(), staticPoints: points }, { kind: "preview", pr: 7 });
    expect(ports.migrator.points).toHaveLength(2);
    expect(ports.migrator.points[1]!.databaseUrl).toBe(ports.migrator.runs.at(-1));
    await deploy({ ...ctx(), staticPoints: points }, { kind: "prod" });
    expect(ports.migrator.points).toHaveLength(2);
    await deploy({ ...authCtx(), staticPoints: {} }, { kind: "prod" });
    expect(ports.migrator.points.at(-1)!.points).toEqual({});
  });

  it("routes each path the app's pages claim, and everything below it, to the Worker before static files", async () => {
    await deploy({ ...ctx(), pages: ["/notes", "/docs/guide"] }, { kind: "prod" });
    const routed = (ports.wrangler.deploys[0]!.config.assets as { run_worker_first: string[] }).run_worker_first;
    expect(routed).toEqual(expect.arrayContaining(["/notes", "/notes/*", "/docs/guide", "/docs/guide/*"]));
    await deploy(ctx(), { kind: "prod" });
    expect((ports.wrangler.deploys[1]!.config.assets as { run_worker_first: string[] }).run_worker_first).toEqual(["/api/*"]);
  });

  it("routes only / itself to the Worker for a root page, leaving every path below it static", async () => {
    await deploy({ ...ctx(), pages: ["/"] }, { kind: "prod" });
    expect((ports.wrangler.deploys[0]!.config.assets as { run_worker_first: string[] }).run_worker_first).toEqual(["/api/*", "/"]);
  });

  it("sets up sending from the prod hostname and hands the Worker its keys once", async () => {
    await deploy(authCtx(), { kind: "prod" });

    expect(ports.mail.domains).toMatchObject([{ name: "demo.example.com", verified: true }]);
    expect(ports.cloudflare.records.map((r) => `${r.type} ${r.name}`)).toEqual(["TXT resend._domainkey.demo.example.com", "MX send.demo.example.com"]);
    const first = ports.wrangler.deploys[0]!;
    expect(Object.keys(first.secrets).sort()).toEqual(["BETTER_AUTH_SECRET", "EMAIL_API_KEY", "SESSION_SECRET"]);
    expect(first.config.vars).toEqual({
      APP_URL: "https://demo.example.com",
      TRACE: "sample",
      APP_NAME: "demo",
      LIVE_ROOMS: "off",
      FRONTEND: "files",
      AUTH_ORGANIZATIONS: "off",
      AUTH_API_TOKENS: "off",
      AUTH_SIGNUP: "invite",
      MCP: "off",
      ACCESS: "off",
      EMAIL_MODE: "send",
      EMAIL_FROM: "noreply@demo.example.com",
    });
    expect(first.config.ratelimits).toEqual([
      { name: "AUTH_LIMIT", namespace_id: expect.stringMatching(/^\d+$/), simple: { limit: 10, period: 60 } },
      { name: "API_LIMIT", namespace_id: expect.stringMatching(/^\d+$/), simple: { limit: 1200, period: 60 } },
    ]);
    const [authLimit, apiLimit] = first.config.ratelimits as { namespace_id: string }[];
    expect(authLimit!.namespace_id).not.toBe(apiLimit!.namespace_id);
    expect(first.config.minify).toBe(true);
    expect(first.config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(first.config.alias).toEqual({ kysely: "./no-kysely.cjs", "@better-auth/kysely-adapter": "./no-kysely.cjs" });
    expect((first.config.assets as { run_worker_first: string[] }).run_worker_first).toContain("/login");
    expect(first.config.main).toBe("entry.ts");
    expect(first.config.durable_objects).toEqual({ bindings: [{ name: "LIVE", class_name: "LiveRoom" }] });
    expect(first.config.migrations).toEqual([{ tag: "live-rooms-v1", new_sqlite_classes: ["LiveRoom"] }]);

    await deploy(authCtx(), { kind: "prod" });
    expect(Object.keys(ports.wrangler.deploys[1]!.secrets)).toEqual(["SESSION_SECRET"]);
    expect(ports.mail.keys).toHaveLength(1);
    expect(ports.cloudflare.records).toHaveLength(2);
  });

  it("drops copied signing keys from a new preview branch, and never again", async () => {
    await deploy(authCtx(), { kind: "prod" });
    expect(ports.migrator.forgotKeys).toEqual(["postgresql://owner:secret@br-prod.neon.test/app"]);
    await deploy(authCtx(), { kind: "prod" });
    await deploy(authCtx(), { kind: "preview", pr: 7 });
    expect(ports.migrator.forgotKeys).toHaveLength(2);
    expect(ports.migrator.forgotKeys[1]).not.toBe(ports.migrator.forgotKeys[0]);
    await deploy(authCtx(), { kind: "preview", pr: 7 });
    expect(ports.migrator.forgotKeys).toHaveLength(2);
  });

  it("leaves signing keys alone without auth", async () => {
    await deploy(ctx(), { kind: "preview", pr: 7 });
    expect(ports.migrator.forgotKeys).toEqual([]);
  });

  it("comments each record with the app's name", async () => {
    await deploy(authCtx(), { kind: "prod" });
    expect(ports.cloudflare.records.map((r) => r.comment)).toEqual([dnsComment("demo"), dnsComment("demo")]);
  });

  it("deletes its own records Resend no longer asks for, and leaves others alone", async () => {
    ports.cloudflare.records.push(
      { id: "stale", type: "TXT", name: "resend._domainkey.demo.demo.example.com", content: "old", comment: dnsComment("demo") },
      { id: "theirs", type: "TXT", name: "other.demo.example.com", content: "keep", comment: undefined },
    );
    await deploy(authCtx(), { kind: "prod" });
    expect(ports.cloudflare.records.map((r) => r.id)).not.toContain("stale");
    expect(ports.cloudflare.records.map((r) => r.id)).toContain("theirs");
  });

  it("never touches another app's records below its hostname", async () => {
    const apex: Config = { ...authConfig, name: "shop", hostname: "example.com" };
    ports.cloudflare.records.push({ id: "blog", type: "TXT", name: "resend._domainkey.blog.example.com", content: "p=BLOG", comment: dnsComment("blog") });
    await deploy({ ...authCtx(), config: apex }, { kind: "prod" });
    await destroy({ ...authCtx(), config: apex }, { data: false });
    expect(ports.cloudflare.records.map((r) => r.id)).toEqual(["blog"]);
  });

  it("adopts its records from before the app's name was in the comment", async () => {
    ports.mail.domains.push({ id: "dom-old", name: "demo.example.com", verified: true, records: [{ type: "TXT", name: "resend._domainkey.demo", content: "p=KEY" }] });
    ports.cloudflare.records.push({ id: "old", type: "TXT", name: "resend._domainkey.demo.example.com", content: "p=KEY", comment: "managed by @celsoft/platform" });
    await deploy(authCtx(), { kind: "prod" });
    expect(ports.cloudflare.records).toMatchObject([{ id: "old", comment: dnsComment("demo") }]);
  });

  it("refuses to overwrite a record the platform did not create", async () => {
    ports.cloudflare.records.push({ id: "theirs", type: "MX", name: "send.demo.example.com", content: "someone.else", priority: 5, comment: undefined });
    await expect(deploy(authCtx(), { kind: "prod" })).rejects.toThrow(/did not create/);
  });

  it("lets a preview email only the listed addresses, from prod's domain, with its own key that cleanup deletes", async () => {
    const listed: Config = { ...authConfig, previews: { sendEmailTo: ["*@team.example"] } };
    const c = (): Context => ({ ...ctx(), config: listed });
    await deploy(c(), { kind: "preview", pr: 7 });
    expect(ports.wrangler.deploys[0]!.secrets.EMAIL_API_KEY).toBeUndefined();
    expect(log.join("\n")).toMatch(/email nobody until prod has deployed/);

    await deploy(c(), { kind: "prod" });
    await deploy(c(), { kind: "preview", pr: 7 });
    const preview = ports.wrangler.deploys.at(-1)!;
    expect(preview.secrets.EMAIL_API_KEY).toMatch(/^re_/);
    expect(preview.config.vars).toMatchObject({ EMAIL_MODE: "capture", EMAIL_FROM: "noreply@demo.example.com", EMAIL_SEND_TO: "*@team.example" });
    expect(ports.mail.keys.map((k) => k.name)).toEqual(["platform demo.example.com", "platform pr-7.demo.example.com"]);
    expect(ports.mail.keys[1]!.domainId).toBe(ports.mail.domains[0]!.id);

    await deploy(c(), { kind: "preview", pr: 7 });
    expect(ports.mail.keys).toHaveLength(2);
    await cleanup(c(), 7);
    expect(ports.mail.keys.map((k) => k.name)).toEqual(["platform demo.example.com"]);
  });

  it("captures email in previews and never touches Resend", async () => {
    await deploy(authCtx(), { kind: "preview", pr: 7 });
    expect(ports.mail.domains).toEqual([]);
    expect(ports.wrangler.deploys[0]!.config.vars).toMatchObject({ EMAIL_MODE: "capture", APP_URL: "https://pr-7.demo.example.com" });
    expect(ports.wrangler.deploys[0]!.secrets).not.toHaveProperty("EMAIL_API_KEY");
  });

  it("stamps the Worker with what was built", async () => {
    const build = { commit: "abc123", branch: "feat/x", builtAt: "2026-10-31T00:00:00.000Z", target: "preview" as const };
    await deploy({ ...authCtx(), build }, { kind: "preview", pr: 7 });
    expect(ports.wrangler.deploys[0]!.config.vars).toMatchObject({ PLATFORM_COMMIT: "abc123", PLATFORM_BRANCH: "feat/x", PLATFORM_BUILT_AT: "2026-10-31T00:00:00.000Z", PLATFORM_TARGET: "preview" });
  });

  it("logs no secret values", async () => {
    await deploy(authCtx(), { kind: "prod" });
    const values = Object.values(ports.wrangler.deploys[0]!.secrets);
    for (const value of values) expect(log.join("\n")).not.toContain(value);
  });
});

describe("files", () => {
  const filesCtx = (): Context => ({ ...ctx(), config: { ...config, files: true } });

  it("gives prod its own bucket with no prefix", async () => {
    await deploy(filesCtx(), { kind: "prod" });
    expect([...ports.cloudflare.buckets.keys()]).toEqual(["demo--files"]);
    const d = ports.wrangler.deploys[0]!.config;
    expect(d.r2_buckets).toEqual([{ binding: "FILES", bucket_name: "demo--files" }]);
    expect(d.vars).not.toHaveProperty("FILES_PREFIX");
  });

  it("puts previews in a shared, expiring bucket under the PR's folder", async () => {
    await deploy(filesCtx(), { kind: "preview", pr: 7 });
    await deploy(filesCtx(), { kind: "preview", pr: 8 });
    expect(ports.cloudflare.buckets.get("demo--previews")).toMatchObject({ expiryDays: 14 });
    expect(ports.wrangler.deploys[0]!.config.vars).toMatchObject({ FILES_PREFIX: "pr-7/" });
    expect(log.filter((l) => l.includes("expire files"))).toHaveLength(1);
  });

  it("cleanup deletes only that PR's files", async () => {
    await deploy(filesCtx(), { kind: "preview", pr: 7 });
    ports.cloudflare.buckets.get("demo--previews")!.keys = ["pr-7/a.txt", "pr-7/b/c.json", "pr-8/a.txt"];
    await cleanup(filesCtx(), 7);
    expect(ports.cloudflare.buckets.get("demo--previews")!.keys).toEqual(["pr-8/a.txt"]);
  });
});

describe("destroy", () => {
  const full: Config = { ...config, auth: { organizations: false, apiTokens: false, signup: "invite" }, email: true, files: true };

  async function deployEverything() {
    const c = { ...ctx(), config: full };
    await deploy(c, { kind: "prod" });
    await deploy(c, { kind: "preview", pr: 7 });
    await ports.neon.createBranch("p", "dev", "br-prod", true);
    ports.cloudflare.buckets.get("demo--previews")!.keys.push("pr-7/a.txt");
    ports.cloudflare.buckets.get("demo--files")!.keys.push("notes/a.txt");
    return c;
  }

  it("deletes what serves the app and keeps what holds its data", async () => {
    const c = await deployEverything();
    await destroy(c, { data: false });

    expect(ports.cloudflare.workers.size).toBe(0);
    expect(ports.cloudflare.hyperdrives).toEqual([]);
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production", "backup-20261024T123456", "dev"]);
    expect(ports.migrator.dropped).toEqual([]);
    expect([...ports.cloudflare.buckets.keys()]).toEqual(["demo--files"]);
    expect(ports.mail.domains).toEqual([]);
    expect(ports.mail.keys).toEqual([]);
    expect(ports.cloudflare.records).toEqual([]);
  });

  it("with data, also drops prod tables, backups, the dev branch and prod files", async () => {
    const c = await deployEverything();
    await destroy(c, { data: true });

    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production"]);
    expect(ports.migrator.dropped).toEqual(["postgresql://owner:secret@br-prod.neon.test/app"]);
    expect(ports.cloudflare.buckets.size).toBe(0);
  });

  it("leaves nothing that stops the next deploy from setting everything up again", async () => {
    const c = await deployEverything();
    await destroy(c, { data: true });
    ports.wrangler.deploys = [];
    await deploy(c, { kind: "prod" });

    expect(ports.mail.domains).toMatchObject([{ name: "demo.example.com", verified: true }]);
    expect(ports.mail.keys).toHaveLength(1);
    expect(ports.cloudflare.records.map((r) => `${r.type} ${r.name}`)).toEqual(["TXT resend._domainkey.demo.example.com", "MX send.demo.example.com"]);
    expect(Object.keys(ports.wrangler.deploys[0]!.secrets).sort()).toEqual(["BETTER_AUTH_SECRET", "EMAIL_API_KEY", "SESSION_SECRET"]);
    expect(ports.cloudflare.hyperdrives).toMatchObject([{ name: "demo" }]);
    expect(ports.cloudflare.buckets.has("demo--files")).toBe(true);
    expect(ports.migrator.runs.at(-1)).toBe("postgresql://owner:secret@br-prod.neon.test/app");
  });

  it("leaves another app whose name starts with this one's alone", async () => {
    const c = await deployEverything();
    ports.cloudflare.workers.add("demo-pr--pr-3");
    ports.cloudflare.hyperdrives.push({ id: "other", name: "demo-pr--pr-3", origin: "", cached: false });
    await destroy(c, { data: false });
    expect([...ports.cloudflare.workers]).toEqual(["demo-pr--pr-3"]);
    expect(ports.cloudflare.hyperdrives.map((h) => h.id)).toEqual(["other"]);
  });

  it("finds what an earlier platform.jsonc turned on", async () => {
    await deployEverything();
    await destroy(ctx(), { data: true });
    expect(ports.cloudflare.buckets.size).toBe(0);
    expect(ports.mail.domains).toEqual([]);
    expect(ports.cloudflare.records).toEqual([]);
  });

  it("leaves a provider alone when its key is missing", async () => {
    const c = await deployEverything();
    await destroy({ ...c, providers: { neon: false, mail: false } }, { data: true });
    expect(ports.neon.branches.map((b) => b.name)).toContain("pr-7");
    expect(ports.mail.domains).toHaveLength(1);
    expect(log.join("\n")).toMatch(/NEON_API_KEY or NEON_PROJECT_ID is not set/);
  });

  it("releases the app's name last", async () => {
    const c = await deployEverything();
    await destroy(c, { data: false });
    expect(ports.registry.claims.size).toBe(0);
    expect(log.at(-1)).toBe("+ release the app name demo");
  });

  it("changes nothing on a dry run", async () => {
    const c = await deployEverything();
    await destroy({ ...c, run: new Run(true, (line) => log.push(line)) }, { data: true });

    expect(ports.cloudflare.workers.size).toBe(2);
    expect(ports.migrator.dropped).toEqual([]);
    expect(log).toContain("~ would delete Worker demo--pr-7");
  });
});

describe("neon project", () => {
  it("needs NEON_PROJECT_ID, and a project id rather than a branch id", () => {
    expect(() => neonProject({})).toThrow(/NEON_PROJECT_ID is not set/);
    expect(() => neonProject({ NEON_PROJECT_ID: "br-quiet-meadow-abcdefgh" })).toThrow(/not a branch id/);
    expect(neonProject({ NEON_PROJECT_ID: "quiet-meadow-12345678" })).toBe("quiet-meadow-12345678");
  });
});

describe("neon key scope", () => {
  it("accepts a project-scoped key and refuses one that can list projects", async () => {
    await expect(requireProjectKey(ports.neon)).resolves.toBeUndefined();
    ports.neon.projectScoped = false;
    await expect(requireProjectKey(ports.neon)).rejects.toThrow(/project-scoped/);
  });
});

describe("postgres version", () => {
  it("stops before touching anything on a project older than Postgres 18", async () => {
    ports.neon.pgVersion = 17;
    await expect(deploy(ctx(), { kind: "prod" })).rejects.toThrow(/Postgres 17/);
    expect(ports.neon.branches).toHaveLength(1);
  });
});

describe("app name claims", () => {
  const other = async () => ({ id: 202, name: "rival/demo" });

  it("claims the app's name for the repo on the first deploy", async () => {
    await deploy(ctx(), { kind: "prod" });
    expect(ports.registry.claims.get("demo")).toEqual({ id: 101, name: "acme/demo" });
  });

  it("stops before any change when another repo holds the name", async () => {
    await deploy(ctx(), { kind: "prod" });
    ports.wrangler.deploys = [];
    const c = { ...ctx(), repo: other };
    await expect(deploy(c, { kind: "prod" })).rejects.toThrow(/belongs to acme\/demo.*apps move/);
    await expect(cleanup(c, 7)).rejects.toThrow(PreflightError);
    await expect(destroy(c, { data: true })).rejects.toThrow(PreflightError);
    expect(ports.wrangler.deploys).toEqual([]);
    expect(ports.cloudflare.workers.has("demo")).toBe(true);
  });

  it("follows a renamed repo, which keeps its id", async () => {
    await deploy(ctx(), { kind: "prod" });
    await deploy({ ...ctx(), repo: async () => ({ id: 101, name: "acme/renamed" }) }, { kind: "prod" });
    expect(ports.registry.claims.get("demo")).toEqual({ id: 101, name: "acme/renamed" });
  });

  it("hands the name to another repo with apps move", async () => {
    await deploy(ctx(), { kind: "prod" });
    await moveApp({ ...ctx(), repo: other });
    await deploy({ ...ctx(), repo: other }, { kind: "prod" });
    expect(ports.registry.claims.get("demo")).toEqual({ id: 202, name: "rival/demo" });
  });

  it("loses a race for the name to the first repo's claim", async () => {
    ports.registry.claim = async () => {
      ports.registry.claims.set("demo", { id: 202, name: "rival/demo" });
      return false;
    };
    await expect(deploy(ctx(), { kind: "prod" })).rejects.toThrow(/belongs to rival\/demo/);
    expect(ports.wrangler.deploys).toEqual([]);
  });
});

describe("earlier names", () => {
  const filesCtx = (): Context => ({ ...ctx(), config: { ...config, files: true } });
  const oldPreview = (pr: number, app = "demo") => {
    ports.cloudflare.workers.add(`demo-pr-${pr}`);
    ports.cloudflare.legacyTags.set(`demo-pr-${pr}`, ["celsoft-platform", `app:${app}`, `pr:${pr}`]);
    ports.cloudflare.hyperdrives.push({ id: `hd-old-${pr}`, name: `demo-pr-${pr}`, origin: "owner@br-prod.neon.test/app", cached: false });
    ports.cloudflare.workerHyperdrives.set(`demo-pr-${pr}`, [`hd-old-${pr}`]);
  };

  it("copies the old prod bucket into the new one, then deletes it", async () => {
    ports.cloudflare.buckets.set("demo-files", { keys: [".celsoft-platform", "notes/a.txt", "notes/b.txt"], legacyOwner: "demo" });
    await deploy(filesCtx(), { kind: "prod" });
    expect(ports.cloudflare.buckets.has("demo-files")).toBe(false);
    expect(ports.cloudflare.buckets.get("demo--files")!.keys).toEqual(["notes/a.txt", "notes/b.txt"]);
    expect(ports.wrangler.deploys[0]!.config.r2_buckets).toEqual([{ binding: "FILES", bucket_name: "demo--files" }]);
  });

  it("copies files the old Worker added during the deploy", async () => {
    ports.cloudflare.buckets.set("demo-files", { keys: ["notes/a.txt"], legacyOwner: "demo" });
    const deployWorker = ports.wrangler.deploy.bind(ports.wrangler);
    ports.wrangler.deploy = async (c, secrets) => {
      ports.cloudflare.buckets.get("demo-files")!.keys.push("notes/late.txt");
      await deployWorker(c, secrets);
    };
    await deploy(filesCtx(), { kind: "prod" });
    expect(ports.cloudflare.buckets.get("demo--files")!.keys).toEqual(["notes/a.txt", "notes/late.txt"]);
  });

  it("leaves an old-named bucket alone unless its marker names the app", async () => {
    ports.cloudflare.buckets.set("demo-files", { keys: ["x"], legacyOwner: "other" });
    await deploy(filesCtx(), { kind: "prod" });
    expect(ports.cloudflare.buckets.get("demo-files")!.keys).toEqual(["x"]);
  });

  it("cleans up an old-named preview whose tags name the app", async () => {
    oldPreview(5);
    ports.cloudflare.buckets.set("demo-previews", { keys: [".celsoft-platform", "pr-5/a.txt"], legacyOwner: "demo" });
    expect(await sweep(ctx(), [])).toEqual([5]);
    expect(ports.cloudflare.workers.size).toBe(0);
    expect(ports.cloudflare.hyperdrives).toEqual([]);
    expect(ports.cloudflare.buckets.has("demo-previews")).toBe(false);
  });

  it("leaves an old-named Worker alone when its tags name another app", async () => {
    oldPreview(5, "demo-pr-5");
    ports.cloudflare.hyperdrives[0]!.origin = "owner@elsewhere.example/app";
    await cleanup(ctx(), 5);
    expect([...ports.cloudflare.workers]).toEqual(["demo-pr-5"]);
    expect(ports.cloudflare.hyperdrives).toHaveLength(1);
  });

  it("destroy removes old-named previews too", async () => {
    oldPreview(5);
    await destroy(ctx(), { data: false });
    expect(ports.cloudflare.workers.size).toBe(0);
    expect(ports.cloudflare.hyperdrives).toEqual([]);
  });
});

describe("sweep", () => {
  const filesCtx = (): Context => ({ ...ctx(), config: { ...config, files: true } });

  it("cleans up previews whose pull request is closed and keeps open ones", async () => {
    await deploy(filesCtx(), { kind: "preview", pr: 7 });
    await deploy(filesCtx(), { kind: "preview", pr: 8 });
    ports.cloudflare.buckets.get("demo--previews")!.keys = ["pr-7/a.txt", "pr-8/a.txt"];

    expect(await sweep(filesCtx(), [8])).toEqual([7]);
    expect([...ports.cloudflare.workers]).toEqual(["demo--pr-8"]);
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production", "pr-8"]);
    expect(ports.cloudflare.buckets.get("demo--previews")!.keys).toEqual(["pr-8/a.txt"]);
  });

  it("lists each preview with the pieces that exist, old names included", async () => {
    await deploy({ ...ctx(), config: { ...config, files: true } }, { kind: "preview", pr: 7 });
    ports.cloudflare.buckets.get("demo--previews")!.keys = ["pr-7/a.txt", "pr-9/b.txt"];
    ports.cloudflare.workers.add("demo-pr-5");
    expect(await findPreviews(ctx())).toEqual([
      { pr: 5, pieces: ["old Worker"] },
      { pr: 7, pieces: ["Worker", "Hyperdrive config", "Neon branch", "files"] },
      { pr: 9, pieces: ["files"] },
    ]);
  });

  it("finds a preview from any piece left behind", async () => {
    await ports.neon.createBranch("p", "pr-9", "br-prod", true);
    expect(await sweep(ctx(), [])).toEqual([9]);
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production"]);
  });
});

describe("cleanup by what exists", () => {
  it("removes a preview's files even after platform.jsonc turned files off", async () => {
    await deploy({ ...ctx(), config: { ...config, files: true } }, { kind: "preview", pr: 7 });
    ports.cloudflare.buckets.get("demo--previews")!.keys = ["pr-7/a.txt"];
    await cleanup(ctx(), 7);
    expect(ports.cloudflare.buckets.get("demo--previews")!.keys).toEqual([]);
  });
});
