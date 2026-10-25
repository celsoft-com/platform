#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { CloudflareApi } from "./adapters/cloudflare.js";
import { commentPreviewLink, GhCli } from "./adapters/github.js";
import { NeonApi } from "./adapters/neon.js";
import { ResendApi } from "./adapters/resend.js";
import { DrizzleMigrator } from "./adapters/drizzle.js";
import { WranglerCli } from "./adapters/process.js";
import { CONFIG_FILE, ConfigError, configVariables, parseConfig, readConfigText, upgradeConfigText, type Config } from "./config.js";
import { checkWorkflow, init, tokenNames } from "./init.js";
import { cleanup, deploy, destroy, dev, PreflightError, type Context } from "./lifecycle.js";
import { UnprovenError } from "./ownership.js";
import { Run } from "./run.js";
import { loadSecrets, loadVars } from "./secrets.js";

const usage = `usage: npx @celsoft/platform <command> [--dry-run] [--dir <app dir>]

commands:
  init             set up GitHub secrets, Environments and the deploy workflow
  dev              run the app locally against its own Neon branch
  db generate      write migrations for changes to the platform's tables and src/schema.ts
  upgrade          rewrite an older platform.jsonc to the current shape
  deploy           deploy prod
  preview <pr>     create or update the preview for a pull request
  cleanup <pr>     delete the preview for a pull request
  destroy [--data] delete everything the platform made for the app; --data also deletes its data
  ci               run the command for the current GitHub Actions event`;

type Command = { name: "db generate" } | { name: "upgrade" } | { name: "init" } | { name: "dev" } | { name: "deploy" } | { name: "destroy" } | { name: "preview"; pr: number; sha?: string } | { name: "cleanup"; pr: number };

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, data: { type: "boolean", default: false }, dir: { type: "string", default: "." }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals.length === 0) {
    console.log(usage);
    return;
  }

  const appDir = resolve(values.dir);
  const dryRun = values["dry-run"];
  const inCi = positionals[0] === "ci";
  const command = inCi ? await commandForGitHubEvent() : parseCommand(positionals);
  if (!command) {
    console.log("nothing to do for this event");
    return;
  }

  if (command.name === "upgrade") {
    const { text, changes } = upgradeConfigText(await readConfigText(appDir));
    if (changes.length === 0) return console.log(`✓ ${CONFIG_FILE} already has the current shape`);
    await writeFile(join(appDir, CONFIG_FILE), text);
    console.log(`updated ${CONFIG_FILE}: ${changes.join(", ")}; review and commit it`);
    return;
  }

  if (command.name === "init") {
    const { config, variables } = await loadApp(appDir);
    await init({
      repoRoot: repoRoot(appDir),
      appDir,
      config,
      variables,
      run: new Run(dryRun, (line) => console.log(line)),
      connect: (tokens) => ({
        cloudflare: new CloudflareApi(tokens.CLOUDFLARE_API_TOKEN!),
        neon: new NeonApi(tokens.NEON_API_KEY ?? ""),
        mail: new ResendApi(tokens.RESEND_API_KEY ?? ""),
        github: new GhCli(repoRoot(appDir)),
      }),
    });
    return;
  }

  const app = await loadApp(appDir);
  if (command.name === "db generate") {
    await new DrizzleMigrator(appDir, app.config).generate();
    return;
  }
  if (inCi) await checkWorkflow(repoRoot(appDir), appDir, app.config, Object.keys(app.variables));
  const ctx = await context(appDir, app.config, dryRun);

  if (command.name === "cleanup") {
    await cleanup(ctx, command.pr);
    return;
  }
  if (command.name === "dev") {
    await dev(ctx);
    return;
  }
  if (command.name === "destroy") {
    await confirmDestroy(ctx, app.config.name, values.data);
    return;
  }

  const { hostname } = await deploy(ctx, command.name === "deploy" ? { kind: "prod" } : { kind: "preview", pr: command.pr });
  if (dryRun) return;
  console.log(`\nlive at https://${hostname}`);

  if (inCi && command.name === "preview") {
    await commentPreviewLink(process.env, command.pr, `https://${hostname}`, command.sha);
    console.log("\nprod dry run with this change:");
    await deploy({ ...ctx, run: new Run(true, (line) => console.log(line)) }, { kind: "prod" });
  }
}

function parseCommand([name, pr]: string[]): Command {
  if (name === "db" && pr === "generate") return { name: "db generate" };
  if (name === "upgrade") return { name };
  if (name === "init" || name === "dev" || name === "deploy" || name === "destroy") return { name };
  if (name === "preview" || name === "cleanup") return { name, pr: prNumber(pr) };
  throw new UsageError(`unknown command ${name}\n\n${usage}`);
}

async function commandForGitHubEvent(): Promise<Command | undefined> {
  const name = process.env.GITHUB_EVENT_NAME;
  const path = process.env.GITHUB_EVENT_PATH;
  if (!name || !path) throw new UsageError("`platform ci` runs only inside GitHub Actions");
  const event = JSON.parse(await readFile(path, "utf8")) as { action?: string; number?: number; pull_request?: { head?: { sha?: string } } };
  if (name === "push") return { name: "deploy" };
  if (name === "pull_request") return event.action === "closed" ? { name: "cleanup", pr: event.number! } : { name: "preview", pr: event.number!, sha: event.pull_request?.head?.sha };
  return undefined;
}

async function loadApp(appDir: string): Promise<{ config: Config; variables: Record<string, string> }> {
  const text = await readConfigText(appDir);
  const names = configVariables(text);
  const vars = await loadVars(appDir, names);
  const variables = Object.fromEntries(names.filter((name) => vars[name]).map((name) => [name, vars[name]!]));
  maskInCi(Object.values(variables));
  return { config: parseConfig(text, join(appDir, CONFIG_FILE), variables), variables };
}

async function context(appDir: string, config: Config, dryRun: boolean): Promise<Context> {
  const secrets = await loadSecrets(appDir, [...tokenNames(config), ...config.secrets]);
  const cloudflareToken = requireToken(secrets, "CLOUDFLARE_API_TOKEN");
  const neonKey = config.database ? requireToken(secrets, "NEON_API_KEY") : "";
  const resendKey = config.email ? requireToken(secrets, "RESEND_API_KEY") : "";
  return {
    config,
    secrets,
    run: new Run(dryRun, (line) => console.log(line)),
    ports: {
      cloudflare: new CloudflareApi(cloudflareToken),
      neon: new NeonApi(neonKey),
      mail: new ResendApi(resendKey),
      wrangler: new WranglerCli(appDir, { CLOUDFLARE_API_TOKEN: cloudflareToken }),
      migrator: new DrizzleMigrator(appDir, config),
    },
  };
}

// Destroy lists what it will delete, then needs the app's name typed and a final yes, so a
// slip of the keyboard can never start it.
async function confirmDestroy(ctx: Context, appName: string, data: boolean): Promise<void> {
  if (!process.stdin.isTTY || process.env.CI) throw new UsageError("destroy asks for confirmation, so it runs only in a terminal");
  console.log(`destroy ${appName}${data ? ", including its data" : ""}:\n`);
  await destroy({ ...ctx, run: new Run(true, (line) => console.log(line)) }, { data });
  if (ctx.run.dryRun) return;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${data ? "This deletes the app's database tables, backups and files. They cannot be recovered." : "The app goes offline until its next deploy."}`);
    if ((await rl.question(`Type the app's name (${appName}) to continue: `)).trim() !== appName) {
      console.log("Name did not match; nothing was deleted.");
      return;
    }
    if (!/^y(es)?$/i.test((await rl.question("Last chance. Delete all of the above? [y/N] ")).trim())) {
      console.log("Nothing was deleted.");
      return;
    }
  } finally {
    rl.close();
  }
  await destroy(ctx, { data });
  console.log(`\n${appName} destroyed; the next deploy sets it up from scratch.`);
}

function repoRoot(dir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    throw new PreflightError(`${dir} is not inside a git repository`);
  }
}

function requireToken(secrets: Record<string, string>, name: string): string {
  const value = secrets[name];
  if (!value) throw new PreflightError(`${name} is not set; add it to .env.secrets, or to the repo's GitHub secrets in CI`);
  return value;
}

function prNumber(value: string | undefined): number {
  const pr = Number(value);
  if (!Number.isInteger(pr) || pr <= 0) throw new UsageError(`expected a pull request number, got ${value ?? "nothing"}`);
  return pr;
}

// GitHub only hides secrets in logs; variables keep values out of the repo, so keep them out of
// public logs too, along with each parent domain of a hostname so preview hostnames are hidden.
function maskInCi(values: string[]): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  for (const value of values) {
    const labels = value.split(".");
    const parents = labels.slice(1, -1).map((_, i) => labels.slice(i + 1).join("."));
    for (const masked of [value, ...parents]) console.log(`::add-mask::${masked}`);
  }
}

class UsageError extends Error {}

main(process.argv.slice(2)).catch((error: unknown) => {
  const known = error instanceof ConfigError || error instanceof PreflightError || error instanceof UnprovenError || error instanceof UsageError;
  console.error(`✗ ${known ? (error as Error).message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
