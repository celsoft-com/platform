import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Config } from "./config.js";
import { PreflightError } from "./lifecycle.js";
import type { Cloudflare, GitHub, Neon } from "./ports.js";
import type { Run } from "./run.js";
import { parseDotenv, SECRETS_FILE } from "./secrets.js";
import { renderWorkflow, WORKFLOW_PATH, type PackageManager } from "./workflow.js";

export const TOKEN_HELP: Record<string, string> = {
  CLOUDFLARE_API_TOKEN: "Cloudflare API token; see SETUP.md or the platform README for its permissions",
  NEON_API_KEY: "Neon API key scoped to the app's Neon project",
};

export interface InitInput {
  repoRoot: string;
  appDir: string;
  config: Config;
  run: Run;
  connect: (tokens: Record<string, string>) => { cloudflare: Cloudflare; neon: Neon; github: GitHub };
}

export async function init({ repoRoot, appDir, config, run, connect }: InitInput): Promise<void> {
  const names = config.database ? ["CLOUDFLARE_API_TOKEN", "NEON_API_KEY"] : ["CLOUDFLARE_API_TOKEN"];

  const tokens = await prepareSecretsFile(repoRoot, names, run);
  const { cloudflare, neon, github } = connect(tokens);

  await cloudflare.accountId();
  const zone = await cloudflare.findZone(config.hostname);
  if (!zone) throw new PreflightError(`the Cloudflare token cannot see a zone for ${config.hostname}; check its Zone Resources`);
  run.note(`✓ Cloudflare account and zone ${zone.name}`);
  if (config.database) {
    await neon.defaultBranch(config.database.neonProject);
    run.note(`✓ Neon project ${config.database.neonProject}`);
  }

  for (const name of names) {
    await run.mutate(`store ${name} as a GitHub secret`, () => github.setSecret(name, tokens[name]!), undefined);
  }
  for (const environment of ["production", "preview"]) {
    await run.mutate(`ensure GitHub Environment ${environment}`, () => github.ensureEnvironment(environment), undefined);
  }

  const workflow = renderWorkflow({ appDir: relative(repoRoot, appDir) || ".", packageManager: await packageManager(repoRoot) });
  const path = join(repoRoot, WORKFLOW_PATH);
  if ((await readOptional(path)) !== workflow) {
    await run.mutate(`write ${WORKFLOW_PATH}`, async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, workflow);
    }, undefined);
  } else {
    run.note(`✓ ${WORKFLOW_PATH}`);
  }
}

export async function checkWorkflow(repoRoot: string, appDir: string): Promise<void> {
  const expected = renderWorkflow({ appDir: relative(repoRoot, appDir) || ".", packageManager: await packageManager(repoRoot) });
  if ((await readOptional(join(repoRoot, WORKFLOW_PATH))) !== expected) {
    throw new PreflightError(`${WORKFLOW_PATH} differs from what this platform version writes; run \`platform init\` and commit the result`);
  }
}

async function prepareSecretsFile(repoRoot: string, names: string[], run: Run): Promise<Record<string, string>> {
  const gitignore = join(repoRoot, ".gitignore");
  const ignored = (await readOptional(gitignore))?.split(/\r?\n/).some((line) => line.trim() === SECRETS_FILE || line.trim() === `/${SECRETS_FILE}`);
  if (!ignored) await run.mutate(`add ${SECRETS_FILE} to .gitignore`, () => appendFile(gitignore, `\n${SECRETS_FILE}\n`), undefined);

  const path = join(repoRoot, SECRETS_FILE);
  const text = (await readOptional(path)) ?? "";
  const declared = new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)].map((m) => m[1]));
  const additions = names.filter((name) => !declared.has(name)).map((name) => `\n# ${TOKEN_HELP[name]}\n${name}=\n`);
  if (additions.length > 0) {
    await run.mutate(`add blank entries to ${SECRETS_FILE}`, () => writeFile(path, text + additions.join(""), { mode: 0o600 }), undefined);
  }

  const values = parseDotenv(text);
  const empty = names.filter((name) => !values[name]);
  if (empty.length > 0) {
    throw new PreflightError(`fill ${empty.join(" and ")} in ${path}, then rerun \`platform init\``);
  }
  return values;
}

async function packageManager(repoRoot: string): Promise<PackageManager> {
  return (await readOptional(join(repoRoot, "pnpm-lock.yaml"))) !== undefined ? "pnpm" : "npm";
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
