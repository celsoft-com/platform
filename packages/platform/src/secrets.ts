import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SECRETS_FILE = ".env.secrets";
export const VARS_FILE = ".env";

export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const [, name, raw] = match;
    const value = /^(['"])(.*)\1$/.exec(raw!)?.[2] ?? raw!;
    if (value) values[name!] = value;
  }
  return values;
}

// Locally secrets come from the nearest .env.secrets; in CI the workflow passes each named
// secret as an environment variable. The environment wins.
export async function loadSecrets(startDir: string, names: string[], env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  return { ...(await findEnvFile(startDir, SECRETS_FILE)), ...pick(env, names) };
}

// Non-secret values platform.jsonc references as ${NAME}: the nearest .env locally,
// GitHub secrets passed by name in CI.
export async function loadVars(startDir: string, names: string[], env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  return { ...(await findEnvFile(startDir, VARS_FILE)), ...pick(env, names) };
}

// Sets name in dir's .env.secrets unless it already has a value, filling a blank entry in place.
// True when it wrote.
export async function addSecret(dir: string, name: string, value: string): Promise<boolean> {
  const path = join(dir, SECRETS_FILE);
  const text = await readFile(path, "utf8").catch(() => "");
  if (parseDotenv(text)[name]) return false;
  const blank = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=).*$`, "m");
  const next = blank.test(text) ? text.replace(blank, `$1${value}`) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${name}=${value}\n`;
  await writeFile(path, next, { mode: 0o600 });
  return true;
}

function pick(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  return Object.fromEntries(names.filter((name) => env[name]).map((name) => [name, env[name]!]));
}

async function findEnvFile(dir: string, name: string): Promise<Record<string, string>> {
  for (let current = dir; ; current = dirname(current)) {
    try {
      return parseDotenv(await readFile(join(current, name), "utf8"));
    } catch {
      if (dirname(current) === current) return {};
    }
  }
}
