import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SECRETS_FILE = ".env.secrets";

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

// Locally secrets come from the nearest .env.secrets; in CI the workflow passes the
// Environment's secrets as PLATFORM_SECRETS JSON. Later sources win.
export async function loadSecrets(startDir: string, env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
  const fromFile = await findSecretsFile(startDir);
  const fromJson = env.PLATFORM_SECRETS ? (JSON.parse(env.PLATFORM_SECRETS) as Record<string, string>) : {};
  return { ...fromFile, ...fromJson };
}

async function findSecretsFile(dir: string): Promise<Record<string, string>> {
  for (let current = dir; ; current = dirname(current)) {
    try {
      return parseDotenv(await readFile(join(current, SECRETS_FILE), "utf8"));
    } catch {
      if (dirname(current) === current) return {};
    }
  }
}
