import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../platform/src/config.js";
import { invalid, scaffold } from "./scaffold.js";

const answers = { name: "shop", hostname: "shop.example.com", neonProject: "quiet-meadow-12345678" };

describe("scaffold", () => {
  it("writes an app whose platform.jsonc the platform accepts", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "create-")), "shop");
    await scaffold(dir, answers, "1.2.3");

    const config = parseConfig(await readFile(join(dir, "platform.jsonc"), "utf8"));
    expect(config).toMatchObject({ name: "shop", hostname: "shop.example.com", database: { neonProject: "quiet-meadow-12345678" } });

    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@celsoft/platform"]).toBe("^1.2.3");
    expect(await readdir(dir)).toContain(".gitignore");
    expect(await readFile(join(dir, "README.md"), "utf8")).not.toMatch(/\{\{/);
  });

  it("refuses a non-empty directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "create-"));
    await writeFile(join(dir, "x"), "");
    await expect(scaffold(dir, answers, "1.0.0")).rejects.toThrow(/not empty/);
  });
});

describe("invalid", () => {
  it("names each bad answer", () => {
    expect(invalid({ name: "Shop", hostname: "shop.example.com", neonProject: "br-quiet-meadow-abcdefgh" })).toEqual(["name", "neonProject"]);
  });
});
