import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Config } from "../config.js";
import type { Answers, GenerateOptions, Migrator } from "../ports.js";
import { withClient } from "./database.js";
import { applyStaticPoints as writeStaticPoints, type StaticPoint } from "../runtime/access.js";
import { prepareAccess } from "../runtime/access-sql.js";
import { prepareCache } from "../runtime/cache.js";
import type { Question, Report } from "./drizzle-answers.js";

export const APP_SCHEMA = "src/schema.ts";
export const MIGRATIONS_DIR = "drizzle";
const PLATFORM_SCHEMA = fileURLToPath(new URL("../schema.js", import.meta.url));
// Run from src/ by the tests, where Node strips the types itself.
const ANSWERS = fileURLToPath(new URL(`./drizzle-answers.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url));

// drizzle-kit asked whether something was created or renamed, and no flag answered it.
export class MigrationQuestions extends Error {
  constructor(questions: Question[], unused: string[]) {
    const lines = questions.map((q) => `  ${q.kind} ${q.name}: --create ${q.name}${q.from.map((from) => `, or --rename ${from}=${q.name}`).join("")}`);
    const extra = unused.map((flag) => `  ${flag} answers no question drizzle-kit asked`);
    super(
      [
        ...(lines.length > 0 ? ["drizzle-kit needs to know whether each of these was created or renamed; answer each with one of its flags to `npx @celsoft/platform db generate`:", ...lines] : []),
        ...(extra.length > 0 ? [lines.length > 0 ? "and these flags matched nothing:" : "these flags matched nothing; drop or fix them and run `npx @celsoft/platform db generate` again:", ...extra] : []),
        "nothing was written to drizzle/",
      ].join("\n"),
    );
  }
}

// One flow for the platform's tables and the app's: drizzle-kit reads both and writes one
// migration history into the app's drizzle/ folder, which every deploy applies.
export class DrizzleMigrator implements Migrator {
  constructor(
    private readonly appDir: string,
    private readonly config: Config,
  ) {}

  // With `custom`, an empty migration of that name for the app's own SQL, such as moving data.
  // Otherwise it generates into a scratch copy of drizzle/, kept only when every question
  // drizzle-kit asked was answered and every answer was used.
  async generate({ custom, answers = { renames: {}, creates: [] } }: GenerateOptions = {}): Promise<void> {
    const schema = await this.schemaFiles();
    if (schema.length === 0) return;
    if (custom) {
      await this.drizzleKit(schema, this.appDir, "inherit", answers, ["--custom", "--name", custom]);
      return;
    }
    const scratch = await mkdtemp(join(tmpdir(), "platform-drizzle-"));
    try {
      const committed = join(this.appDir, MIGRATIONS_DIR);
      if (await exists(committed)) await cp(committed, join(scratch, MIGRATIONS_DIR), { recursive: true });
      const { report, output } = await this.drizzleKit(schema, scratch, "pipe", answers);
      const given = [...Object.entries(answers.renames).map(([to, from]) => `--rename ${from}=${to}`), ...answers.creates.map((name) => `--create ${name}`)];
      const unused = given.filter((flag) => !report.used.includes(flag));
      if (report.questions.length > 0 || unused.length > 0) throw new MigrationQuestions(report.questions, unused);
      process.stdout.write(output);
      if (await exists(join(scratch, MIGRATIONS_DIR))) await cp(join(scratch, MIGRATIONS_DIR), committed, { recursive: true });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
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
        await this.drizzleKit(schema, scratch, "pipe", { renames: {}, creates: [] });
      } catch {
        return false;
      }
      return (await sqlFiles(copy)).length === before.length;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async prepareCache(databaseUrl: string): Promise<void> {
    await withClient(databaseUrl, async (client) => {
      await prepareCache(drizzle(client) as never);
    });
  }

  async prepareAccess(databaseUrl: string, points: Record<string, StaticPoint>): Promise<void> {
    await withClient(databaseUrl, async (client) => {
      const db = drizzle(client) as never;
      await prepareAccess(db);
      await writeStaticPoints(db, points);
    });
  }

  async migrate(databaseUrl: string): Promise<void> {
    const folder = join(this.appDir, MIGRATIONS_DIR);
    if (!(await exists(join(folder, "meta", "_journal.json")))) return;
    await withClient(databaseUrl, async (client) => {
      // Two runs against one database wait their turn instead of applying the same file twice.
      await client.query("select pg_advisory_lock(hashtext('@celsoft/platform migrate'))");
      await migrate(drizzle(client), { migrationsFolder: folder });
    });
  }

  async dropAll(databaseUrl: string): Promise<void> {
    await withClient(databaseUrl, async (client) => {
      await client.query("drop schema if exists drizzle cascade; drop schema public cascade; create schema public;");
    });
  }

  async forgetSigningKeys(databaseUrl: string): Promise<void> {
    await withClient(databaseUrl, async (client) => {
      await client.query("delete from jwks");
    });
  }

  private async schemaFiles(): Promise<string[]> {
    const app = join(this.appDir, APP_SCHEMA);
    return [...(this.config.auth ? [PLATFORM_SCHEMA] : []), ...((await exists(app)) ? [app] : [])];
  }

  // drizzle-kit reads its earlier snapshots back through a path built from `out`, which only
  // works when `out` is relative, so it runs from the folder that holds drizzle/.
  private async drizzleKit(schema: string[], root: string, stdio: "inherit" | "pipe", answers: Answers, extra: string[] = []): Promise<{ report: Report; output: string }> {
    const configFile = join(root, ".platform-drizzle.json");
    const reportFile = join(root, ".platform-drizzle-report.json");
    await writeFile(configFile, JSON.stringify({ dialect: "postgresql", schema, out: `./${MIGRATIONS_DIR}`, migrations: { prefix: "timestamp" } }, null, 2));
    try {
      const env = { ...process.env, PLATFORM_DRIZZLE_ANSWERS: JSON.stringify(answers), PLATFORM_DRIZZLE_REPORT: reportFile };
      const output = await run(process.execPath, ["--import", pathToFileURL(ANSWERS).href, drizzleKitBin(), "generate", "--config", configFile, ...extra], root, stdio, env);
      return { report: JSON.parse(await readFile(reportFile, "utf8")), output };
    } finally {
      await rm(configFile, { force: true });
      await rm(reportFile, { force: true });
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

// stdin is closed, so drizzle-kit never waits on a terminal; its questions go to drizzle-answers.
function run(command: string, args: string[], cwd: string, stdio: "inherit" | "pipe", env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", stdio, stdio] });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(`drizzle-kit generate exited with code ${code}\n${output}`))));
  });
}
