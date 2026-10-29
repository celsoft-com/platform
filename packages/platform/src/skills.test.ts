import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTS_BLOCK, installSkills, SKILLS_DIR, writeAgentsBlock } from "./skills.js";

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

describe("installSkills", () => {
  it("copies every skill the package ships, ignores the copies, and changes nothing on a second run", async () => {
    const d = await dir();
    const names = await readdir(SKILLS_DIR);
    expect(names).toEqual(expect.arrayContaining(["celsoft-platform", "celsoft-platform-setup"]));
    expect(await installSkills(d)).toEqual([...names.map((name) => `.claude/skills/${name}/SKILL.md`), ".gitignore", "AGENTS.md"]);
    for (const name of names) expect(await readFile(join(d, ".claude/skills", name, "SKILL.md"), "utf8")).toBe(await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8"));
    expect(await readFile(join(d, ".gitignore"), "utf8")).toBe(".claude/skills/celsoft-platform*/\n");
    expect(await installSkills(d)).toEqual([]);
  });
});
