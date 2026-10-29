import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import { invalid, scaffold } from "./scaffold.js";

const answers = { name: "shop", hostname: "shop.example.com", neonProject: "quiet-meadow-12345678" };

describe("scaffold", () => {
  it("writes an app whose platform.jsonc the platform accepts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-"));
    await scaffold(dir, answers, "1.2.3");

    const config = parseConfig(await readFile(join(dir, "platform.jsonc"), "utf8"));
    expect(config).toMatchObject({ name: "shop", hostname: "shop.example.com", database: { neonProject: "quiet-meadow-12345678" } });

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

  it("refuses an app that already has a platform.jsonc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-"));
    await writeFile(join(dir, "platform.jsonc"), "{}");
    await expect(scaffold(dir, answers, "1.0.0")).rejects.toThrow(/already set up/);
  });
});

describe("invalid", () => {
  it("names each bad answer", () => {
    expect(invalid({ name: "Shop", hostname: "shop.example.com", neonProject: "br-quiet-meadow-abcdefgh" })).toEqual(["name", "neonProject"]);
  });
});
