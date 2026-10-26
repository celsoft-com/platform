import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { freshDatabase } from "../../test/database.js";
import { DrizzleMigrator } from "./drizzle.js";

// Runs the real drizzle-kit inside the package, so the scratch app can resolve drizzle-orm.
const base = fileURLToPath(new URL("../../.test-apps/", import.meta.url));
const config = parseConfig(`{ "name": "test", "hostname": "test.example.com", "worker": "src/worker.ts", "compatibilityDate": "2026-10-01",
  "database": { "neonProject": "quiet-meadow-12345678" } }`);
const table = (columns: string) =>
  `import { pgTable, text, uuid } from "drizzle-orm/pg-core";\nexport const items = pgTable("items", { id: uuid("id").primaryKey()${columns} });\n`;

const { pool, url } = await freshDatabase();
let app: string;
let migrator: DrizzleMigrator;
const migrations = async () => (await readdir(join(app, "drizzle"))).filter((f) => f.endsWith(".sql"));

beforeAll(async () => {
  await mkdir(base, { recursive: true });
  app = await mkdtemp(join(base, "app-"));
  await mkdir(join(app, "src"));
  await writeFile(join(app, "src", "schema.ts"), table(""));
  migrator = new DrizzleMigrator(app, config);
});
afterAll(() => rm(base, { recursive: true, force: true }));

describe("DrizzleMigrator", () => {
  it("generates, then reports up to date, then catches each later change", async () => {
    await migrator.generate();
    expect(await migrations()).toHaveLength(1);
    expect(await migrator.upToDate()).toBe(true);

    await writeFile(join(app, "src", "schema.ts"), table(`, name: text("name")`));
    expect(await migrator.upToDate()).toBe(false);

    await migrator.generate();
    expect(await migrations()).toHaveLength(2);
    expect(await migrator.upToDate()).toBe(true);
  }, 60_000);

  it("writes an empty, named migration for the app's own SQL, which keeps the schema up to date", async () => {
    await migrator.generate("move-data");
    const all = await migrations();
    expect(all).toHaveLength(3);
    expect(all.filter((name) => name.endsWith("_move-data.sql"))).toHaveLength(1);
    expect(await migrator.upToDate()).toBe(true);
  }, 60_000);

  it("forgets every signing key in a database, keeping everything else", async () => {
    await pool.query(`insert into jwks (public_key, private_key) values ('pub', 'encrypted with another secret')`);
    await pool.query(`insert into "user" (name, email) values ('A', 'a@example.com')`);
    await migrator.forgetSigningKeys(url);
    expect((await pool.query("select count(*) from jwks")).rows[0].count).toBe("0");
    expect((await pool.query(`select count(*) from "user"`)).rows[0].count).toBe("1");
  });
});
