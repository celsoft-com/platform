import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { invalid, scaffold, upgradeScaffold } from "./scaffold.js";

const answers = { name: "shop", hostname: "shop.example.com" };

describe("upgradeScaffold", () => {
  it("adds a test script, vitest and embedded-postgres to an app made by an older version, once, and writes no other file", async () => {
    const app = await mkdtemp(join(tmpdir(), "upgrade-"));
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "shop", scripts: { postinstall: "platform generate" }, devDependencies: { typescript: "^7" } }));
    expect(await upgradeScaffold(app)).toHaveLength(3);
    const pkg = JSON.parse(await readFile(join(app, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ scripts: { postinstall: "platform generate", test: "vitest run" } });
    expect(Object.keys(pkg.devDependencies)).toEqual(["embedded-postgres", "typescript", "vitest"]);
    expect(await upgradeScaffold(app)).toEqual([]);
    expect(await readdir(app)).toEqual(["package.json"]);
  });

  it("keeps the app's own test script and its own Postgres package", async () => {
    const app = await mkdtemp(join(tmpdir(), "upgrade-"));
    await writeFile(join(app, "package.json"), JSON.stringify({ scripts: { test: "jest" }, devDependencies: { "embedded-postgres": "18.1.0-beta.16" } }));
    expect(await upgradeScaffold(app)).toEqual([]);
    expect(JSON.parse(await readFile(join(app, "package.json"), "utf8"))).toMatchObject({ scripts: { test: "jest" }, devDependencies: { "embedded-postgres": "18.1.0-beta.16" } });
  });
});

describe("scaffold", () => {
  it("writes an app whose platform.jsonc the platform accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-"));
    await scaffold(dir, answers, "1.2.3");

    const config = parseConfig(await readFile(join(dir, "platform.jsonc"), "utf8"));
    expect(config).toMatchObject({ name: "shop", hostname: "shop.example.com", database: true });

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "shop", type: "module", scripts: { postinstall: "platform generate" } });
    expect(pkg.dependencies["@celsoft/platform"]).toBe("^1.2.3");
    expect((await readFile(join(dir, ".gitignore"), "utf8")).split("\n")).toContain(".env.secrets");
    expect(await readFile(join(dir, "README.md"), "utf8")).not.toMatch(/\{\{/);
  });

  it("fills in the package.json npm wrote on install, keeping its version and the app's files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-"));
    await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "@celsoft/platform": "^9.0.0" } }));
    await writeFile(join(dir, ".gitignore"), ".claude/skills/celsoft-platform*/\n");
    await writeFile(join(dir, "README.md"), "# Mine\n");

    const { kept } = await scaffold(dir, answers, "1.2.3");

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg).toMatchObject({ name: "shop", dependencies: { "@celsoft/platform": "^9.0.0", zod: expect.any(String) } });
    expect(kept).toEqual(["README.md"]);
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("# Mine\n");
    expect((await readFile(join(dir, ".gitignore"), "utf8")).split("\n")).toEqual(expect.arrayContaining([".claude/skills/celsoft-platform*/", "node_modules", ".env.secrets"]));
  });

  it("changes nothing on a dry run, naming what it would write and keep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-"));
    await writeFile(join(dir, "README.md"), "# Mine\n");

    const { written, kept } = await scaffold(dir, answers, "1.2.3", true);

    expect(written).toEqual(expect.arrayContaining(["platform.jsonc", "package.json", ".gitignore"]));
    expect(kept).toEqual(["README.md"]);
    expect((await readdir(dir)).sort()).toEqual(["README.md"]);
  });

  it("refuses an app that already has a platform.jsonc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-"));
    await writeFile(join(dir, "platform.jsonc"), "{}");
    await expect(scaffold(dir, answers, "1.0.0")).rejects.toThrow(/already set up/);
  });
});

describe("invalid", () => {
  it("names each bad answer", () => {
    expect(invalid({ name: "Shop", hostname: "shop" })).toEqual(["name", "hostname"]);
  });
});
