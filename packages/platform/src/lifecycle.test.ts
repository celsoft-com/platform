import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "./config.js";
import { fakePorts } from "./fakes.js";
import { cleanup, deploy, PreflightError, type Context } from "./lifecycle.js";
import { Run } from "./run.js";

const config: Config = parseConfig(`{
  "version": 1,
  "name": "demo",
  "hostname": "demo.example.com",
  "worker": "src/worker.ts",
  "compatibilityDate": "2026-10-01",
  "frontend": "dist",
  "database": { "neonProject": "quiet-meadow-12345678", "migrate": "pnpm migrate" },
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
  const authConfig: Config = { ...config, auth: true, email: { replyTo: "help@example.com" } };
  const authCtx = (dryRun = false): Context => ({ ...ctx(dryRun), config: authConfig });

  it("creates auth tables before the app's migrations", async () => {
    await deploy(authCtx(), { kind: "prod" });
    expect(ports.migrator.authRuns).toEqual(ports.migrator.runs);
    expect(log.findIndex((l) => l.includes("update auth tables"))).toBeLessThan(log.findIndex((l) => l.includes("run migrations")));
  });

  it("sets up sending from the prod hostname and hands the Worker its keys once", async () => {
    await deploy(authCtx(), { kind: "prod" });

    expect(ports.mail.domains).toMatchObject([{ name: "demo.example.com", verified: true }]);
    expect(ports.cloudflare.records.map((r) => `${r.type} ${r.name}`)).toEqual(["TXT resend._domainkey.demo.example.com", "MX send.demo.example.com"]);
    const first = ports.wrangler.deploys[0]!;
    expect(Object.keys(first.secrets).sort()).toEqual(["BETTER_AUTH_SECRET", "EMAIL_API_KEY", "SESSION_SECRET"]);
    expect(first.config.vars).toEqual({
      APP_URL: "https://demo.example.com",
      EMAIL_MODE: "send",
      EMAIL_FROM: "noreply@demo.example.com",
      EMAIL_REPLY_TO: "help@example.com",
    });

    await deploy(authCtx(), { kind: "prod" });
    expect(Object.keys(ports.wrangler.deploys[1]!.secrets)).toEqual(["SESSION_SECRET"]);
    expect(ports.mail.keys).toHaveLength(1);
    expect(ports.cloudflare.records).toHaveLength(2);
  });

  it("refuses to overwrite a record the platform did not create", async () => {
    ports.cloudflare.records.push({ type: "MX", name: "send.demo.example.com", content: "someone.else", priority: 5, managed: false });
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
