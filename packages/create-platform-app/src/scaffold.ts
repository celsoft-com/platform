import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

export async function scaffold(target: string, answers: Answers, platformVersion: string): Promise<void> {
  if ((await stat(target).catch(() => undefined)) && (await readdir(target)).length > 0) {
    throw new Error(`${target} already exists and is not empty`);
  }
  const vars: Record<string, string> = { ...answers, platformVersion, compatibilityDate: COMPATIBILITY_DATE };
  await copy(TEMPLATE_DIR, target, vars);
}

async function copy(from: string, to: string, vars: Record<string, string>): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    // npm drops .gitignore from published packages, so the template stores it without the dot.
    const name = entry.name === "gitignore" ? ".gitignore" : entry.name;
    if (entry.isDirectory()) {
      await copy(join(from, entry.name), join(to, name), vars);
    } else {
      const text = await readFile(join(from, entry.name), "utf8");
      await writeFile(join(to, name), text.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match));
    }
  }
}
