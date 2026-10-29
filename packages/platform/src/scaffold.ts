import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_FILE } from "./config.js";
import { ensureIgnored } from "./skills.js";

export const TEMPLATE_DIR = fileURLToPath(new URL("../template/", import.meta.url));
export const COMPATIBILITY_DATE = "2026-10-01";

export interface Answers {
  name: string;
  hostname: string;
  neonProject: string;
}

export const rules: Record<keyof Answers, { pattern: RegExp; hint: string }> = {
  name: { pattern: /^(?=.{3,50}$)[a-z][a-z0-9]*(-[a-z0-9]+)*$/, hint: "3 to 50 lowercase letters, digits and single hyphens, starting with a letter" },
  hostname: { pattern: /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, hint: "a lowercase hostname in your Cloudflare zone, such as app.example.com" },
  neonProject: { pattern: /^[a-z]+-[a-z]+-\d+$/, hint: "a Neon project id such as quiet-meadow-12345678, from the project's Settings" },
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
