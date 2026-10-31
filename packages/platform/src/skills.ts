import { appendFile, cp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Run } from "./run.js";

export const SKILLS_DIR = fileURLToPath(new URL("../skills/", import.meta.url));

// Where Claude Code finds a project's skills; other agents follow the AGENTS.md block instead.
export const AGENT_SKILLS_DIR = join(".claude", "skills");

const BLOCK_START = "<!-- @celsoft/platform:start -->";
const BLOCK_END = "<!-- @celsoft/platform:end -->";

// Points the app's agents at the skills the installed package ships, so they always match the
// installed version. Only this block of AGENTS.md is the platform's.
export const AGENTS_BLOCK = `${BLOCK_START}
## @celsoft/platform

This app is built on @celsoft/platform. Before changing it, read the skills the installed version
ships, starting with \`node_modules/@celsoft/platform/skills/celsoft-platform/SKILL.md\`; every
skill is a \`SKILL.md\` under \`node_modules/@celsoft/platform/skills/\`, also copied to
\`.claude/skills/\`. To set the app up or deploy it for the first time, follow
\`celsoft-platform-setup\`. They match the installed version, so read them again after an
upgrade. This block is rewritten on install; edit outside it.
${BLOCK_END}`;

// Copies the package's skills into the app, gitignored since every install rewrites them, and
// writes the AGENTS.md block. Needs nothing but the installed package, so it runs before the app
// exists. Returns the files it changed.
export async function installSkills(appDir: string): Promise<string[]> {
  const changed: string[] = [];
  for (const name of await readdir(SKILLS_DIR)) {
    const target = join(AGENT_SKILLS_DIR, name);
    const before = await readFile(join(appDir, target, "SKILL.md"), "utf8").catch(() => undefined);
    await cp(join(SKILLS_DIR, name), join(appDir, target), { recursive: true });
    if (before !== (await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8"))) changed.push(join(target, "SKILL.md"));
  }
  if (await ensureIgnored(appDir, `${AGENT_SKILLS_DIR}/celsoft-platform*/`)) changed.push(".gitignore");
  if (await writeAgentsBlock(appDir)) changed.push("AGENTS.md");
  return changed;
}

// True when AGENTS.md changed.
export async function writeAgentsBlock(appDir: string): Promise<boolean> {
  const file = join(appDir, "AGENTS.md");
  const text = await readFile(file, "utf8").catch(() => "");
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  const next =
    start >= 0 && end > start
      ? text.slice(0, start) + AGENTS_BLOCK + text.slice(end + BLOCK_END.length)
      : text
        ? `${text.replace(/\n*$/, "")}\n\n${AGENTS_BLOCK}\n`
        : `${AGENTS_BLOCK}\n`;
  if (next === text) return false;
  await writeFile(file, next);
  return true;
}

// Adds `entry` to the folder's .gitignore unless a line already names it, with or without a
// leading or trailing slash; true when .gitignore changed. With `run`, a dry run only says so.
export async function ensureIgnored(dir: string, entry: string, run?: Run): Promise<boolean> {
  const gitignore = join(dir, ".gitignore");
  const text = await readFile(gitignore, "utf8").catch(() => "");
  const bare = entry.replace(/^\/|\/$/g, "");
  if (text.split(/\r?\n/).some((line) => line.trim().replace(/^\/|\/$/g, "") === bare)) return false;
  const append = () => appendFile(gitignore, `${text && !text.endsWith("\n") ? "\n" : ""}${entry}\n`);
  if (run) await run.mutate(`add ${entry} to .gitignore`, append, undefined);
  else await append();
  return true;
}
