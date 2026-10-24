import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import type { Config } from "../config.js";
import { PreflightError } from "../lifecycle.js";
import type { Migrator } from "../ports.js";

export const APP_SCHEMA = "src/schema.ts";
export const MIGRATIONS_DIR = "drizzle";
const PLATFORM_SCHEMA = fileURLToPath(new URL("../schema.js", import.meta.url));
const MIN_POSTGRES = 180000;

// One flow for the platform's tables and the app's: drizzle-kit reads both and writes one
// migration history into the app's drizzle/ folder, which every deploy applies.
export class DrizzleMigrator implements Migrator {
  constructor(
    private readonly appDir: string,
    private readonly config: Config,
  ) {}

  async generate(): Promise<void> {
    const schema = await this.schemaFiles();
    if (schema.length === 0) return;
    await this.drizzleKit(schema, join(this.appDir, MIGRATIONS_DIR), "inherit");
  }

  // Generates into a scratch copy of drizzle/; any new file means the schema changed without one.
  async upToDate(): Promise<boolean> {
    const schema = await this.schemaFiles();
    if (schema.length === 0) return true;
    const scratch = await mkdtemp(join(tmpdir(), "platform-drizzle-"));
    try {
      const committed = join(this.appDir, MIGRATIONS_DIR);
      if (await exists(committed)) await cp(committed, scratch, { recursive: true });
      const before = await sqlFiles(scratch);
      try {
        await this.drizzleKit(schema, scratch, "pipe");
      } catch {
        return false;
      }
      return (await sqlFiles(scratch)).length === before.length;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async migrate(databaseUrl: string): Promise<void> {
    const folder = join(this.appDir, MIGRATIONS_DIR);
    if (!(await exists(join(folder, "meta", "_journal.json")))) return;
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const { rows } = await client.query<{ server_version_num: string }>("show server_version_num");
      if (Number(rows[0]!.server_version_num) < MIN_POSTGRES) {
        throw new PreflightError("the Neon project runs a Postgres older than 18; create the project again on Postgres 18");
      }
      // Two runs against one database wait their turn instead of applying the same file twice.
      await client.query("select pg_advisory_lock(hashtext('@celsoft/platform migrate'))");
      await migrate(drizzle(client), { migrationsFolder: folder });
    } finally {
      await client.end();
    }
  }

  async dropAll(databaseUrl: string): Promise<void> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("drop schema if exists drizzle cascade; drop schema public cascade; create schema public;");
    } finally {
      await client.end();
    }
  }

  private async schemaFiles(): Promise<string[]> {
    const app = join(this.appDir, APP_SCHEMA);
    return [...(this.config.auth ? [PLATFORM_SCHEMA] : []), ...((await exists(app)) ? [app] : [])];
  }

  private async drizzleKit(schema: string[], out: string, stdio: "inherit" | "pipe"): Promise<void> {
    const configFile = join(this.appDir, ".platform-drizzle.json");
    await writeFile(configFile, JSON.stringify({ dialect: "postgresql", schema, out, migrations: { prefix: "timestamp" } }, null, 2));
    try {
      await run(process.execPath, [drizzleKitBin(), "generate", "--config", configFile], this.appDir, stdio);
    } finally {
      await rm(configFile, { force: true });
    }
  }
}

function drizzleKitBin(): string {
  return join(dirname(createRequire(import.meta.url).resolve("drizzle-kit/package.json")), "bin.cjs");
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function sqlFiles(dir: string): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter((name) => name.endsWith(".sql"));
}

// stdin is closed, so a rename question fails the run instead of waiting for an answer nobody gives.
function run(command: string, args: string[], cwd: string, stdio: "inherit" | "pipe"): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: [stdio === "inherit" ? "inherit" : "ignore", stdio, stdio] });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`drizzle-kit generate exited with code ${code}\n${output}`))));
  });
}
