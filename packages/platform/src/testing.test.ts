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

describe("testApp's frontend files", () => {
  it("redirects a folder's bare path to its slash and serves its index there, as Cloudflare does", async () => {
    const { mkdtemp, mkdir: makeDir, writeFile: write } = await import("node:fs/promises");
    const { tmpdir: temp } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const { defineApp } = await import("./runtime/index.js");
    const { testApp } = await import("./testing.js");
    const dir = await mkdtemp(joinPath(temp(), "frontend-"));
    await makeDir(joinPath(dir, "public/admin"), { recursive: true });
    await write(joinPath(dir, "platform.jsonc"), JSON.stringify({ name: "probe", hostname: "probe.example", worker: "src/worker.ts", frontend: { dir: "public" }, compatibilityDate: "2026-10-01" }));
    await write(joinPath(dir, "public/admin/index.html"), "<h1>admin</h1>");
    await write(joinPath(dir, "public/about.html"), "<h1>about</h1>");
    const t = await testApp(defineApp(() => new Response("worker")), { dir });
    const bare = await t.fetch("/admin?x=1", { redirect: "manual" });
    expect(bare.status).toBe(307);
    expect(bare.headers.get("location")).toBe("/admin/?x=1");
    expect(await (await t.fetch("/admin/")).text()).toBe("<h1>admin</h1>");
    expect(await (await t.fetch("/about")).text()).toBe("<h1>about</h1>");
    await t.close();
  });
});
