import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installedMismatch } from "./installed.js";

const app = async (installed?: string, where: "app" | "parent" = "app") => {
  const root = await mkdtemp(join(tmpdir(), "installed-"));
  const dir = join(root, "app");
  await mkdir(dir);
  await writeFile(join(dir, "package.json"), JSON.stringify({ dependencies: { "@celsoft/platform": "^0.55.0" } }));
  if (installed) {
    const pkg = join(where === "app" ? dir : root, "node_modules", "@celsoft", "platform");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ version: installed }));
  }
  return dir;
};

describe("the app's own copy", () => {
  it("runs when the running version is the one installed, here or hoisted above", async () => {
    expect(await installedMismatch(await app("0.55.0"), "0.55.0")).toBeUndefined();
    expect(await installedMismatch(await app("0.55.0", "parent"), "0.55.0")).toBeUndefined();
  });

  it("refuses another version, and a dependency that is not installed, saying to npm install", async () => {
    expect(await installedMismatch(await app("0.55.0"), "0.32.0")).toMatch(/this is @celsoft\/platform 0\.32\.0, but the app has 0\.55\.0 installed; run `npm install`/);
    expect(await installedMismatch(await app(), "0.32.0")).toMatch(/not installed; run `npm install`/);
  });

  it("leaves a folder that does not depend on the package alone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "installed-"));
    expect(await installedMismatch(dir, "0.55.0")).toBeUndefined();
  });
});
