import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "./config.js";
import { ensureIgnored } from "./skills.js";

export const TEMPLATE_DIR = fileURLToPath(new URL("../template/", import.meta.url));
export const COMPATIBILITY_DATE = "2026-10-01";

export interface Answers {
  name: string;
  hostname: string;
}

export const rules: Record<keyof Answers, { pattern: RegExp; hint: string }> = {
  name: { pattern: /^(?=.{3,50}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/, hint: "3 to 50 lowercase letters, digits and single hyphens, starting with a letter" },
  hostname: { pattern: /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, hint: "a lowercase hostname in your Cloudflare zone, such as app.example.com" },
};

export function invalid(answers: Partial<Answers>): (keyof Answers)[] {
  return (Object.keys(rules) as (keyof Answers)[]).filter((key) => !rules[key].pattern.test(answers[key] ?? ""));
}

// Writes a new app's files into appDir, which already has the package installed. Files already
// there are kept, except package.json, which gains the app's name, scripts and dependencies, and
// .gitignore, which gains the template's lines. Returns what it wrote, or on a dry run what it
// would write, touching nothing.
export async function scaffold(appDir: string, answers: Answers, platformVersion: string, dryRun = false): Promise<{ written: string[]; kept: string[] }> {
  if (await exists(join(appDir, CONFIG_FILE))) throw new Error(`${CONFIG_FILE} already exists, so this app is already set up`);
  const vars: Record<string, string> = { ...answers, platformVersion, compatibilityDate: COMPATIBILITY_DATE };
  const result = { written: [] as string[], kept: [] as string[] };
  for (const file of await files(TEMPLATE_DIR)) {
    const text = (await readFile(join(TEMPLATE_DIR, file), "utf8")).replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
    // npm drops .gitignore from published packages, so the template stores it without the dot.
    const target = file === "gitignore" ? ".gitignore" : file;
    if (dryRun) {
      (target !== ".gitignore" && target !== "package.json" && (await exists(join(appDir, target))) ? result.kept : result.written).push(target);
    } else if (target === ".gitignore") {
      for (const line of text.split("\n").filter(Boolean)) await ensureIgnored(appDir, line);
      result.written.push(target);
    } else if (target === "package.json") {
      await mergePackageJson(appDir, JSON.parse(text) as PackageJson);
      result.written.push(target);
    } else if (await exists(join(appDir, target))) {
      result.kept.push(target);
    } else {
      await mkdir(join(appDir, target, ".."), { recursive: true });
      await writeFile(join(appDir, target), text);
      result.written.push(target);
    }
  }
  return result;
}

// What `new` writes that an app made by an older version lacks, added without touching what the
// app has: a test script and vitest when it has no test script, and a Postgres pin for tests when
// no mise.toml from the app's folder up to `root` has one. Returns what it changed.
export async function upgradeScaffold(appDir: string, root: string): Promise<string[]> {
  const changes: string[] = [];
  const template = JSON.parse(await readFile(join(TEMPLATE_DIR, "package.json"), "utf8")) as PackageJson;
  const file = join(appDir, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8")) as PackageJson;
  if (!pkg.scripts?.test) {
    pkg.scripts = { ...pkg.scripts, test: template.scripts!.test! };
    pkg.devDependencies = Object.fromEntries(Object.entries({ vitest: template.devDependencies!.vitest!, ...pkg.devDependencies }).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
    changes.push("package.json gained a test script and vitest; install, then run it");
  }
  const pin = (await readFile(join(TEMPLATE_DIR, MISE_FILE), "utf8")).split("\n").find((line) => line.includes(POSTGRES_TOOL))!;
  if (!(await pinnedAbove(appDir, root))) {
    const mise = join(appDir, MISE_FILE);
    const text = await readFile(mise, "utf8").catch(() => undefined);
    if (text === undefined) await writeFile(mise, await readFile(join(TEMPLATE_DIR, MISE_FILE), "utf8"));
    else if (/^\[tools\]\s*$/m.test(text)) await writeFile(mise, text.replace(/^\[tools\]\s*$/m, (header) => `${header}\n${pin}`));
    else await writeFile(mise, `${text.trimEnd()}\n\n[tools]\n${pin}\n`.trimStart());
    changes.push(`${MISE_FILE} pins Postgres for tests; run mise install`);
  }
  return changes;
}

const MISE_FILE = "mise.toml";
const POSTGRES_TOOL = "postgresql";

async function pinnedAbove(dir: string, root: string): Promise<boolean> {
  for (let at = dir; ; at = dirname(at)) {
    for (const name of [MISE_FILE, ".mise.toml"]) {
      if ((await readFile(join(at, name), "utf8").catch(() => "")).includes(POSTGRES_TOOL)) return true;
    }
    if (at === root || dirname(at) === at) return false;
  }
}

type PackageJson = Record<string, unknown> & { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

async function mergePackageJson(appDir: string, template: PackageJson): Promise<void> {
  const file = join(appDir, "package.json");
  const pkg = JSON.parse(await readFile(file, "utf8").catch(() => "{}")) as PackageJson;
  for (const key of ["name", "private", "type"]) pkg[key] ??= template[key];
  for (const key of ["scripts", "dependencies", "devDependencies"] as const) pkg[key] = { ...template[key], ...pkg[key] };
  await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

async function files(dir: string, root = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await files(path, root)));
    else out.push(relative(root, path));
  }
  return out;
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
