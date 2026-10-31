import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { templateName } from "./testing.js";

const config = parseConfig(`{ "name": "demo", "hostname": "demo.test", "worker": "src/worker.ts", "compatibilityDate": "2026-01-01", "database": true }`);

describe("templateName", () => {
  let dir: string;
  const name = () => templateName(dir, config, {});

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "template-name-"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "drizzle"));
    await writeFile(join(dir, "src", "schema.ts"), `import { pgTable, text } from "drizzle-orm/pg-core";\nexport * from "./tables.js";\n`);
    await writeFile(join(dir, "src", "tables.ts"), `export const notes = 1;\n`);
    await writeFile(join(dir, "drizzle", "0000_init.sql"), `create table notes ();\n`);
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("stays the same while nothing it is built from changes", async () => {
    expect(await name()).toBe(await name());
  });

  it("changes when a file the schema imports changes", async () => {
    const before = await name();
    await writeFile(join(dir, "src", "tables.ts"), `export const notes = 2;\n`);
    expect(await name()).not.toBe(before);
  });

  it("changes when a migration is added", async () => {
    const before = await name();
    await writeFile(join(dir, "drizzle", "0001_more.sql"), `alter table notes add column body text;\n`);
    expect(await name()).not.toBe(before);
  });

  it("changes with the static points", async () => {
    expect(await templateName(dir, config, { everyone: { level: "read" } as never })).not.toBe(await name());
  });
});
