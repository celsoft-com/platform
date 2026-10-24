import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { fakePorts } from "./fakes.js";
import { checkWorkflow, init, type InitInput } from "./init.js";
import { PreflightError } from "./lifecycle.js";
import type { GitHub } from "./ports.js";
import { Run } from "./run.js";
import { WORKFLOW_PATH } from "./workflow.js";

const config = parseConfig(`{
  "version": 1, "name": "demo", "hostname": "demo.example.com", "worker": "src/worker.ts", "compatibilityDate": "2026-10-01",
  "database": { "neonProject": "quiet-meadow-12345678", "migrate": "node migrate.js" }
}`);

class FakeGitHub implements GitHub {
  secrets: Record<string, string> = {};
  environments = new Set<string>();
  variables: Record<string, string> = {};
  async setVariable(name: string, value: string) {
    this.variables[name] = value;
  }
  async setSecret(name: string, value: string) {
    this.secrets[name] = value;
  }
  async ensureEnvironment(name: string) {
    this.environments.add(name);
  }
}

let root: string;
let github: FakeGitHub;

function input(): InitInput {
  const ports = fakePorts();
  return { repoRoot: root, appDir: join(root, "apps", "demo"), config, variables: { APP_HOSTNAME: "demo.example.com" }, run: new Run(false, () => {}), connect: () => ({ ...ports, github }) };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "init-"));
  github = new FakeGitHub();
});

describe("init", () => {
  it("adds blank token entries, gitignores them, and stops until they are filled", async () => {
    await expect(init(input())).rejects.toThrow(/fill CLOUDFLARE_API_TOKEN and NEON_API_KEY/);
    expect(await readFile(join(root, ".env.secrets"), "utf8")).toMatch(/^CLOUDFLARE_API_TOKEN=$/m);
    expect(await readFile(join(root, ".gitignore"), "utf8")).toMatch(/^\.env\.secrets$/m);
    expect(github.secrets).toEqual({});
  });

  it("stores tokens, creates Environments and writes a workflow that ci accepts", async () => {
    await writeFile(join(root, ".env.secrets"), "CLOUDFLARE_API_TOKEN=cf\nNEON_API_KEY=neon\n");
    await writeFile(join(root, "pnpm-lock.yaml"), "");

    await init(input());

    expect(github.secrets).toEqual({ CLOUDFLARE_API_TOKEN: "cf", NEON_API_KEY: "neon" });
    expect([...github.environments]).toEqual(["production", "preview"]);
    expect(github.variables).toEqual({ APP_HOSTNAME: "demo.example.com" });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toMatch(/^\.env$/m);
    const workflow = await readFile(join(root, WORKFLOW_PATH), "utf8");
    expect(workflow).toMatch(/working-directory: apps\/demo/);
    expect(workflow).toMatch(/pnpm exec platform ci/);
    await expect(checkWorkflow(root, join(root, "apps", "demo"))).resolves.toBeUndefined();
  });

  it("makes ci stop when the workflow drifts", async () => {
    await expect(checkWorkflow(root, join(root, "apps", "demo"))).rejects.toThrow(PreflightError);
  });
});
