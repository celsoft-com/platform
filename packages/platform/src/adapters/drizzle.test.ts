import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { DrizzleMigrator } from "./drizzle.js";

// Runs the real drizzle-kit inside the package, so the scratch app can resolve drizzle-orm.
const base = fileURLToPath(new URL("../../.test-apps/", import.meta.url));
const config = parseConfig(`{ "name": "t", "hostname": "t.example.com", "worker": "src/worker.ts", "compatibilityDate": "2026-10-01",
  "database": { "neonProject": "quiet-meadow-12345678" } }`);
const table = (columns: string) =>
  `import { pgTable, text, uuid } from "drizzle-orm/pg-core";\nexport const items = pgTable("items", { id: uuid("id").primaryKey()${columns} });\n`;

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
});
