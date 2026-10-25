import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS_BLOCK, writeAgentsBlock } from "./generate.js";

const dir = () => mkdtemp(join(tmpdir(), "agents-"));

describe("AGENTS.md block", () => {
  it("creates AGENTS.md when there is none", async () => {
    const d = await dir();
    expect(await writeAgentsBlock(d)).toBe(true);
    expect(await readFile(join(d, "AGENTS.md"), "utf8")).toBe(`${AGENTS_BLOCK}\n`);
  });

  it("appends to an existing AGENTS.md and changes nothing on a second run", async () => {
    const d = await dir();
    await writeFile(join(d, "AGENTS.md"), "# My app\n\nOur rules.\n");
    await writeAgentsBlock(d);
    expect(await writeAgentsBlock(d)).toBe(false);
    expect(await readFile(join(d, "AGENTS.md"), "utf8")).toBe(`# My app\n\nOur rules.\n\n${AGENTS_BLOCK}\n`);
  });

  it("replaces only its own block, keeping the app's text around it", async () => {
    const d = await dir();
    await writeFile(join(d, "AGENTS.md"), "Before\n<!-- @celsoft/platform:start -->\nold\n<!-- @celsoft/platform:end -->\nAfter\n");
    expect(await writeAgentsBlock(d)).toBe(true);
    expect(await readFile(join(d, "AGENTS.md"), "utf8")).toBe(`Before\n${AGENTS_BLOCK}\nAfter\n`);
  });
});
