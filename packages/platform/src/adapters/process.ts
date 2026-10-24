import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Migrator, Wrangler } from "../ports.js";

export class WranglerCli implements Wrangler {
  constructor(
    private readonly appDir: string,
    private readonly env: { CLOUDFLARE_API_TOKEN: string },
  ) {}

  async deploy(config: object, secrets: Record<string, string>): Promise<void> {
    const configFile = join(this.appDir, ".platform-wrangler.json");
    const secretsFile = join(this.appDir, ".platform-secrets.json");
    await writeFile(configFile, JSON.stringify(config, null, 2));
    await writeFile(secretsFile, JSON.stringify(secrets), { mode: 0o600 });
    try {
      const wrangler = createRequire(import.meta.url).resolve("wrangler/bin/wrangler.js");
      await run("wrangler deploy", process.execPath, [wrangler, "deploy", "--config", configFile, "--secrets-file", secretsFile], {
        cwd: this.appDir,
        env: { ...process.env, ...this.env },
      });
    } finally {
      await rm(secretsFile, { force: true });
      await rm(configFile, { force: true });
    }
  }
}

export class ShellMigrator implements Migrator {
  constructor(private readonly appDir: string) {}

  async migrate(command: string, databaseUrl: string): Promise<void> {
    await run(`migrations (${command})`, command, [], { cwd: this.appDir, env: { ...process.env, DATABASE_URL: databaseUrl }, shell: true });
  }
}

function run(label: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`))));
  });
}
