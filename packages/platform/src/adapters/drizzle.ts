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
import type { Migrator } from "../ports.js";
import { applyStaticPoints as writeStaticPoints, type StaticPoint } from "../runtime/access.js";
import { prepareAccess } from "../runtime/access-sql.js";

export const APP_SCHEMA = "src/schema.ts";
export const MIGRATIONS_DIR = "drizzle";
const PLATFORM_SCHEMA = fileURLToPath(new URL("../schema.js", import.meta.url));

// One flow for the platform's tables and the app's: drizzle-kit reads both and writes one
// migration history into the app's drizzle/ folder, which every deploy applies.
export class DrizzleMigrator implements Migrator {
  constructor(
    private readonly appDir: string,
    private readonly config: Config,
  ) {}

  // With `custom`, an empty migration of that name for the app's own SQL, such as moving data.
  async generate(custom?: string): Promise<void> {
    const schema = await this.schemaFiles();
    if (schema.length === 0) return;
    await this.drizzleKit(schema, this.appDir, "inherit", custom ? ["--custom", "--name", custom] : []);
  }

  // Generates into a scratch copy of drizzle/; any new file means the schema changed without one.
  async upToDate(): Promise<boolean> {
    const schema = await this.schemaFiles();
    if (schema.length === 0) return true;
    const scratch = await mkdtemp(join(tmpdir(), "platform-drizzle-"));
    try {
      const committed = join(this.appDir, MIGRATIONS_DIR);
      const copy = join(scratch, MIGRATIONS_DIR);
      if (await exists(committed)) await cp(committed, copy, { recursive: true });
      const before = await sqlFiles(copy);
      try {
        await this.drizzleKit(schema, scratch, "pipe");
      } catch {
        return false;
      }
      return (await sqlFiles(copy)).length === before.length;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async prepareAccess(databaseUrl: string, points: Record<string, StaticPoint>): Promise<void> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const db = drizzle(client) as never;
      await prepareAccess(db);
      await writeStaticPoints(db, points);
    } finally {
      await client.end();
    }
  }

  async migrate(databaseUrl: string): Promise<void> {
    const folder = join(this.appDir, MIGRATIONS_DIR);
    if (!(await exists(join(folder, "meta", "_journal.json")))) return;
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
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

  async forgetSigningKeys(databaseUrl: string): Promise<void> {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query("delete from jwks");
    } finally {
      await client.end();
    }
  }

  private async schemaFiles(): Promise<string[]> {
    const app = join(this.appDir, APP_SCHEMA);
    return [...(this.config.auth ? [PLATFORM_SCHEMA] : []), ...((await exists(app)) ? [app] : [])];
  }

  // drizzle-kit reads its earlier snapshots back through a path built from `out`, which only
  // works when `out` is relative, so it runs from the folder that holds drizzle/.
  private async drizzleKit(schema: string[], root: string, stdio: "inherit" | "pipe", extra: string[] = []): Promise<void> {
    const configFile = join(root, ".platform-drizzle.json");
    await writeFile(configFile, JSON.stringify({ dialect: "postgresql", schema, out: `./${MIGRATIONS_DIR}`, migrations: { prefix: "timestamp" } }, null, 2));
    try {
      await run(process.execPath, [drizzleKitBin(), "generate", "--config", configFile, ...extra], root, stdio);
    } finally {
      await rm(configFile, { force: true });
    }
  }
}

function drizzleKitBin(): string {
  return join(dirname(createRequire(import.meta.url).resolve("drizzle-kit")), "bin.cjs");
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
