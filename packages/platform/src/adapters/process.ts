import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import type { Migrator, Wrangler } from "../ports.js";
import { authOptions, authPool } from "../runtime/auth.js";

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
      await run("wrangler deploy", process.execPath, [wranglerBin(), "deploy", "--config", configFile, "--secrets-file", secretsFile], {
        cwd: this.appDir,
        env: { ...process.env, ...this.env },
      });
    } finally {
      await rm(secretsFile, { force: true });
      await rm(configFile, { force: true });
    }
  }

  // wrangler dev reads secrets from a .dev.vars file beside its config, and takes the local
  // database through an environment variable in place of the Hyperdrive binding.
  async dev(config: object, secrets: Record<string, string>, databaseUrl: string | undefined): Promise<void> {
    const configFile = join(this.appDir, ".platform-wrangler.json");
    const devVars = join(this.appDir, ".dev.vars");
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
    }
  }
}

function wranglerBin(): string {
  return join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
}

export class ShellMigrator implements Migrator {
  constructor(private readonly appDir: string) {}

  async migrate(command: string, databaseUrl: string): Promise<void> {
    await run(`migrations (${command})`, command, [], { cwd: this.appDir, env: { ...process.env, DATABASE_URL: databaseUrl }, shell: true });
  }

  async migrateAuth(databaseUrl: string): Promise<void> {
    const pool = authPool(databaseUrl);
    try {
      const options = authOptions({ pool, secret: "migrations-only", baseURL: "http://localhost", email: { send: async () => {} }, requireVerification: false });
      const { runMigrations } = await getMigrations(options);
      await runMigrations();
    } finally {
      await pool.end();
    }
  }
}

function run(label: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${label} exited with code ${code}`))));
  });
}
