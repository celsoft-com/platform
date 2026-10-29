import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addSecret, loadSecrets, parseDotenv } from "./secrets.js";

describe("parseDotenv", () => {
  it("reads names and values, skipping comments, blanks and empty values", () => {
    expect(parseDotenv(`# comment\nA=1\nexport B="two"\nC=\n\nD='x=y'`)).toEqual({ A: "1", B: "two", D: "x=y" });
  });
});

describe("loadSecrets", () => {
  it("finds the nearest .env.secrets above the app and lets named environment variables win", async () => {
    const root = await mkdtemp(join(tmpdir(), "secrets-"));
    const app = join(root, "apps", "demo");
    await mkdir(app, { recursive: true });
    await writeFile(join(root, ".env.secrets"), "A=file\nB=file\n");

    expect(await loadSecrets(app, ["B"], { B: "ci", C: "not named" })).toEqual({ A: "file", B: "ci" });
  });
});

describe("addSecret", () => {
  it("fills a blank entry in place, appends a missing one, and never replaces a value", async () => {
    const root = await mkdtemp(join(tmpdir(), "secrets-"));
    const file = join(root, ".env.secrets");
    await writeFile(file, "# the key\nA=\nB=kept");

    expect(await addSecret(root, "A", "one")).toBe(true);
    expect(await addSecret(root, "C", "three")).toBe(true);
    expect(await addSecret(root, "B", "other")).toBe(false);
    expect(await readFile(file, "utf8")).toBe("# the key\nA=one\nB=kept\nC=three\n");
  });
});
