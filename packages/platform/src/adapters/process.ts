import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { generatedPath } from "../generate.js";
import type { Wrangler } from "../ports.js";
import { ENTRY_FILE, entryModule, NO_KYSELY_FILE, NO_KYSELY_MODULE } from "../wrangler-config.js";

export class WranglerCli implements Wrangler {
  constructor(
    private readonly appDir: string,
    private readonly env: { CLOUDFLARE_API_TOKEN: string },
    private readonly worker: string,
  ) {}

  async deploy(config: object, secrets: Record<string, string>): Promise<void> {
    const configFile = generatedPath(this.appDir, "wrangler.json");
    const secretsFile = generatedPath(this.appDir, "secrets.json");
    const entryFiles = await this.writeEntry();
    await writeFile(configFile, JSON.stringify(config, null, 2));
    await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    try {
      await run("wrangler deploy", process.execPath, [wranglerBin(), "deploy", "--config", configFile, "--secrets-file", secretsFile], {
        cwd: this.appDir,
        env: { ...process.env, ...this.env },
      });
    } finally {
      await rm(secretsFile, { force: true });
      await rm(configFile, { force: true });
      for (const file of entryFiles) await rm(file, { force: true });
    }
  }

  private async writeEntry(): Promise<string[]> {
    await mkdir(generatedPath(this.appDir, ""), { recursive: true });
    const entry = generatedPath(this.appDir, ENTRY_FILE);
    const stub = generatedPath(this.appDir, NO_KYSELY_FILE);
    await writeFile(entry, entryModule(this.worker));
    await writeFile(stub, NO_KYSELY_MODULE);
    return [entry, stub];
  }

  // wrangler dev reads secrets from a .dev.vars file beside its config, and takes the local
  // database through an environment variable in place of the Hyperdrive binding.
  async dev(config: object, secrets: Record<string, string>, databaseUrl: string | undefined): Promise<void> {
    const configFile = generatedPath(this.appDir, "wrangler.json");
    const devVars = generatedPath(this.appDir, ".dev.vars");
    const entryFiles = await this.writeEntry();
    await writeFile(configFile, JSON.stringify(config, null, 2));
    await writeFile(devVars, Object.entries(secrets).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("\n") + "\n", { mode: 0o600 });
    try {
      await run("wrangler dev", process.execPath, [wranglerBin(), "dev", "--config", configFile], {
        cwd: this.appDir,
        env: { ...process.env, ...this.env, ...(databaseUrl && { CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_DB: databaseUrl }) },
      });
    } finally {
      await rm(devVars, { force: true });
      await rm(configFile, { force: true });
      for (const file of entryFiles) await rm(file, { force: true });
    }
  }
}

function wranglerBin(): string {
  return join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
}

function run(label: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`))));
  });
}
