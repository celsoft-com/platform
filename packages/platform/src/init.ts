import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { Config } from "./config.js";
import { neonProject, PreflightError, requirePostgres, requireProjectKey } from "./lifecycle.js";
import type { Cloudflare, GitHub, Mail, Neon } from "./ports.js";
import type { Run } from "./run.js";
import { parseDotenv, SECRETS_FILE, VARS_FILE } from "./secrets.js";
import { packageManager } from "./scripts.js";
import { ensureIgnored } from "./skills.js";
import { renderWorkflow, WORKFLOW_PATH } from "./workflow.js";

export const TOKEN_HELP: Record<string, string> = {
  CLOUDFLARE_API_TOKEN: "Cloudflare API token; see SETUP.md or the platform README for its permissions",
  NEON_API_KEY: "Neon API key scoped to the app's Neon project",
  NEON_PROJECT_ID: "The app's Neon project id, such as quiet-meadow-12345678, from the project's Settings",
  RESEND_API_KEY: "Resend API key with full access, so the platform can add sending domains",
};

export interface InitInput {
  repoRoot: string;
  appDir: string;
  config: Config;
  variables: Record<string, string>;
  run: Run;
  connect: (tokens: Record<string, string>) => { cloudflare: Cloudflare; neon: Neon; mail: Mail; github: GitHub };
}

export function tokenNames(config: Config): string[] {
  return ["CLOUDFLARE_API_TOKEN", ...(config.database ? ["NEON_API_KEY", "NEON_PROJECT_ID"] : []), ...(config.email ? ["RESEND_API_KEY"] : [])];
}

export async function init({ repoRoot, appDir, config, variables, run, connect }: InitInput): Promise<void> {
  const names = tokenNames(config);

  const tokens = await prepareSecretsFile(repoRoot, names, run);
  if (Object.keys(variables).length > 0) await ensureIgnored(repoRoot, VARS_FILE, run);
  const { cloudflare, neon, mail, github } = connect(tokens);

  await cloudflare.accountId();
  const zone = await cloudflare.findZone(config.hostname);
  if (!zone) throw new PreflightError(`the Cloudflare token cannot see a zone for ${config.hostname}; check its Zone Resources`);
  run.note(`✓ Cloudflare account and zone ${zone.name}`);
  if (config.database) {
    await requireProjectKey(neon);
    await requirePostgres(neon, neonProject(tokens));
    run.note("✓ Neon project, on Postgres 18 or later");
  }
  if (config.email) {
    // Listing domains needs the same full access that adding the app's sending domain does.
    await mail.findDomain(config.hostname).catch((error: Error) => {
      throw new PreflightError(`the Resend API key cannot manage domains (${error.message}); create one with Full access`);
    });
    run.note("✓ Resend API key can manage sending domains");
  }

  run.note(`storing secrets in ${await github.target()}`);
  for (const name of names) {
    await run.mutate(`store ${name} as a GitHub secret`, () => github.setSecret(name, tokens[name]!), undefined);
  }
  for (const [name, value] of Object.entries(variables)) {
    await run.mutate(`store ${name} as a GitHub secret, so logs hide it`, () => github.setSecret(name, value), undefined);
  }
  for (const environment of ["production", "preview"]) {
    await run.mutate(`ensure GitHub Environment ${environment}`, () => github.ensureEnvironment(environment), undefined);
  }

  const workflow = await expectedWorkflow(repoRoot, appDir, config, Object.keys(variables));
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

export async function checkWorkflow(repoRoot: string, appDir: string, config: Config, variables: string[]): Promise<void> {
  const expected = await expectedWorkflow(repoRoot, appDir, config, variables);
  if ((await readOptional(join(repoRoot, WORKFLOW_PATH))) !== expected) {
    throw new PreflightError(`${WORKFLOW_PATH} differs from what this platform version writes; run \`npx @celsoft/platform init\` and commit the result`);
  }
}

async function prepareSecretsFile(repoRoot: string, names: string[], run: Run): Promise<Record<string, string>> {
  await ensureIgnored(repoRoot, SECRETS_FILE, run);

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
    throw new PreflightError(`fill ${empty.join(" and ")} in ${path}, then rerun \`npx @celsoft/platform init\``);
  }
  return values;
}

async function expectedWorkflow(repoRoot: string, appDir: string, config: Config, variables: string[]): Promise<string> {
  return renderWorkflow({
    appDir: relative(repoRoot, appDir) || ".",
    packageManager: await packageManager(repoRoot),
    secrets: [...tokenNames(config), ...config.secrets],
    variables,
  });
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
