import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getMigrations } from "better-auth/db/migration";
import postgres from "postgres";
import type { Migrator, Wrangler } from "../ports.js";
import { authOptions } from "../runtime/auth.js";

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
      const wrangler = join(dirname(createRequire(import.meta.url).resolve("wrangler/package.json")), "bin", "wrangler.js");
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

  async migrateAuth(databaseUrl: string): Promise<void> {
    const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    try {
      const options = authOptions({ sql, secret: "migrations-only", baseURL: "http://localhost", email: { send: async () => {} }, requireVerification: false });
      const { runMigrations } = await getMigrations(options);
      await runMigrations();
    } finally {
      await sql.end();
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
