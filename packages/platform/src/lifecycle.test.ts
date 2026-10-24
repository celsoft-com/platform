import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "./config.js";
import { fakePorts } from "./fakes.js";
import { cleanup, deploy, destroy, PreflightError, type Context } from "./lifecycle.js";
import { Run } from "./run.js";

const config: Config = parseConfig(`{
  "version": 1,
  "name": "demo",
  "hostname": "demo.example.com",
  "worker": "src/worker.ts",
  "compatibilityDate": "2026-10-01",
  "frontend": "dist",
  "database": { "neonProject": "quiet-meadow-12345678" },
  "secrets": ["SESSION_SECRET"]
}`);

let ports: ReturnType<typeof fakePorts>;
let log: string[];

function ctx(dryRun = false): Context {
  return {
    config,
    ports,
    run: new Run(dryRun, (line) => log.push(line)),
    secrets: { SESSION_SECRET: "s3cret", UNRELATED: "x" },
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
      assets: { directory: "dist" },
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

    expect(hostname).toBe("demo-pr-7.example.com");
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production", "pr-7"]);
    expect(ports.cloudflare.hyperdrives.map((h) => h.name)).toEqual(["demo-pr-7"]);
    expect(ports.wrangler.deploys[0]?.config).toMatchObject({ name: "demo-pr-7" });
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
    expect(log.join("\n")).toMatch(/would deploy Worker demo-pr-7/);
  });

  it("cleanup deletes the Worker, Hyperdrive and branch, and is safe to repeat", async () => {
    await deploy(ctx(), { kind: "preview", pr: 7 });
    await cleanup(ctx(), 7);
    await cleanup(ctx(), 7);

    expect(ports.cloudflare.workers.has("demo-pr-7")).toBe(false);
    expect(ports.cloudflare.hyperdrives).toEqual([]);
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production"]);
  });
});

describe("auth and email", () => {
  const authConfig: Config = { ...config, auth: { organizations: false }, email: true };
  const authCtx = (dryRun = false): Context => ({ ...ctx(dryRun), config: authConfig });

  it("sets up sending from the prod hostname and hands the Worker its keys once", async () => {
    await deploy(authCtx(), { kind: "prod" });

    expect(ports.mail.domains).toMatchObject([{ name: "demo.example.com", verified: true }]);
    expect(ports.cloudflare.records.map((r) => `${r.type} ${r.name}`)).toEqual(["TXT resend._domainkey.demo.example.com", "MX send.demo.example.com"]);
    const first = ports.wrangler.deploys[0]!;
    expect(Object.keys(first.secrets).sort()).toEqual(["BETTER_AUTH_SECRET", "EMAIL_API_KEY", "SESSION_SECRET"]);
    expect(first.config.vars).toEqual({
      APP_URL: "https://demo.example.com",
      APP_NAME: "demo",
      AUTH_ORGANIZATIONS: "off",
      EMAIL_MODE: "send",
      EMAIL_FROM: "noreply@demo.example.com",
    });
    expect(first.config.ratelimits).toEqual([{ name: "AUTH_LIMIT", namespace_id: expect.stringMatching(/^\d+$/), simple: { limit: 10, period: 60 } }]);
    expect((first.config.assets as { run_worker_first: string[] }).run_worker_first).toContain("/login");

    await deploy(authCtx(), { kind: "prod" });
    expect(Object.keys(ports.wrangler.deploys[1]!.secrets)).toEqual(["SESSION_SECRET"]);
    expect(ports.mail.keys).toHaveLength(1);
    expect(ports.cloudflare.records).toHaveLength(2);
  });

  it("deletes its own records Resend no longer asks for, and leaves others alone", async () => {
    ports.cloudflare.records.push(
      { id: "stale", type: "TXT", name: "resend._domainkey.demo.demo.example.com", content: "old", managed: true },
      { id: "theirs", type: "TXT", name: "other.demo.example.com", content: "keep", managed: false },
    );
    await deploy(authCtx(), { kind: "prod" });
    expect(ports.cloudflare.records.map((r) => r.id)).not.toContain("stale");
    expect(ports.cloudflare.records.map((r) => r.id)).toContain("theirs");
  });

  it("refuses to overwrite a record the platform did not create", async () => {
    ports.cloudflare.records.push({ id: "theirs", type: "MX", name: "send.demo.example.com", content: "someone.else", priority: 5, managed: false });
    await expect(deploy(authCtx(), { kind: "prod" })).rejects.toThrow(/did not create/);
  });

  it("captures email in previews and never touches Resend", async () => {
    await deploy(authCtx(), { kind: "preview", pr: 7 });
    expect(ports.mail.domains).toEqual([]);
    expect(ports.wrangler.deploys[0]!.config.vars).toMatchObject({ EMAIL_MODE: "capture", APP_URL: "https://demo-pr-7.example.com" });
    expect(ports.wrangler.deploys[0]!.secrets).not.toHaveProperty("EMAIL_API_KEY");
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
    expect([...ports.cloudflare.buckets.keys()]).toEqual(["demo-files"]);
    const d = ports.wrangler.deploys[0]!.config;
    expect(d.r2_buckets).toEqual([{ binding: "FILES", bucket_name: "demo-files" }]);
    expect(d.vars).not.toHaveProperty("FILES_PREFIX");
  });

  it("puts previews in a shared, expiring bucket under the PR's folder", async () => {
    await deploy(filesCtx(), { kind: "preview", pr: 7 });
    await deploy(filesCtx(), { kind: "preview", pr: 8 });
    expect(ports.cloudflare.buckets.get("demo-previews")).toMatchObject({ expiryDays: 14 });
    expect(ports.wrangler.deploys[0]!.config.vars).toMatchObject({ FILES_PREFIX: "pr-7/" });
    expect(log.filter((l) => l.includes("expire files"))).toHaveLength(1);
  });

  it("cleanup deletes only that PR's files", async () => {
    await deploy(filesCtx(), { kind: "preview", pr: 7 });
    ports.cloudflare.buckets.get("demo-previews")!.keys = ["pr-7/a.txt", "pr-7/b/c.json", "pr-8/a.txt"];
    await cleanup(filesCtx(), 7);
    expect(ports.cloudflare.buckets.get("demo-previews")!.keys).toEqual(["pr-8/a.txt"]);
  });
});

describe("destroy", () => {
  const full: Config = { ...config, auth: { organizations: false }, email: true, files: true };

  async function deployEverything() {
    const c = { ...ctx(), config: full };
    await deploy(c, { kind: "prod" });
    await deploy(c, { kind: "preview", pr: 7 });
    await ports.neon.createBranch("p", "dev", "br-prod", true);
    ports.cloudflare.buckets.get("demo-previews")!.keys.push("pr-7/a.txt");
    ports.cloudflare.buckets.get("demo-files")!.keys.push("notes/a.txt");
    return c;
  }

  it("deletes what serves the app and keeps what holds its data", async () => {
    const c = await deployEverything();
    await destroy(c, { data: false });

    expect(ports.cloudflare.workers.size).toBe(0);
    expect(ports.cloudflare.hyperdrives).toEqual([]);
    expect(ports.neon.branches.map((b) => b.name)).toEqual(["production", "backup-20261024T123456", "dev"]);
    expect(ports.migrator.dropped).toEqual([]);
    expect([...ports.cloudflare.buckets.keys()]).toEqual(["demo-files"]);
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

  it("changes nothing on a dry run", async () => {
    const c = await deployEverything();
    await destroy({ ...c, run: new Run(true, (line) => log.push(line)) }, { data: true });

    expect(ports.cloudflare.workers.size).toBe(2);
    expect(ports.migrator.dropped).toEqual([]);
    expect(log).toContain("~ would delete Worker demo-pr-7");
  });
});

describe("postgres version", () => {
  it("stops before touching anything on a project older than Postgres 18", async () => {
    ports.neon.pgVersion = 17;
    await expect(deploy(ctx(), { kind: "prod" })).rejects.toThrow(/Postgres 17/);
    expect(ports.neon.branches).toHaveLength(1);
  });
});
