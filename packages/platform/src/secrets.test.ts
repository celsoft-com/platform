import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSecrets, parseDotenv } from "./secrets.js";

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
