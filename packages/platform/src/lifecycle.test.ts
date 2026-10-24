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
