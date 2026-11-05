#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { CloudflareApi } from "./adapters/cloudflare.js";
import { GhCli } from "./adapters/github.js";
import { NeonApi } from "./adapters/neon.js";
import { R2Registry } from "./adapters/registry.js";
import { ResendApi } from "./adapters/resend.js";
import { DrizzleMigrator, MigrationQuestions } from "./adapters/drizzle.js";
import { WranglerCli } from "./adapters/process.js";
import { COMMANDS, NO_DRY_RUN, prNumber, repoRoot, UsageError, type Command, type Spec } from "./commands.js";
import { ConfigError, loadApp, type Config } from "./config.js";
import { generate } from "./generate.js";
import { HttpsError } from "./https.js";
import { installedMismatch } from "./installed.js";
import { checkWorkflow, tokenNames } from "./init.js";
import { PreflightError, requireProjectKey, type Context, type Source } from "./lifecycle.js";
import type { Repo } from "./ports.js";
import { Run } from "./run.js";
import { loadSecrets } from "./secrets.js";
import { processTerminal, type Terminal } from "./terminal.js";

// The CLI's entry point: argv becomes a Command, and this composes what the command needs, from the
// app's config up to the Context of real adapters; commands.ts says what each one does.

const usage = `usage: npx @celsoft/platform <command> [--dry-run] [--dir <app dir>]

commands:
  skills           copy the package's skills into .claude/skills/ and point AGENTS.md at them
  new              write a new app's files into this folder, then install its dependencies;
                   --name and --hostname answer its questions
  init             set up GitHub secrets, Environments and the deploy workflow
  dev              run the app locally against its own Neon branch
  db generate      write migrations for changes to the platform's tables and src/schema.ts
                   --custom <name> writes an empty one for SQL of your own, such as moving data
                   --rename <old>=<new> and --create <new> answer drizzle-kit's "created or renamed?"
                   questions, such as --rename users=accounts or --rename accounts.full_name=accounts.name
  generate         write the .platform/ files the app's code imports, such as the browser client
  upgrade          rewrite an older platform.jsonc to the current shape, and add what new now writes
  deploy           deploy prod
  preview <pr>     create or update the preview for a pull request
  cleanup <pr>     delete the preview for a pull request
  previews         list the previews that exist, with their pull request's state
  sweep            delete previews whose pull request is closed
  db run <file.sql> --pr <n>
                   run a file of SQL on a preview's database, such as load test data
  db stats [--pr <n>] [--reset]
                   the database's costliest queries since the counts were cleared; --reset clears them
  owner reset <email> [--pr <n>]
                   make that account the owner and set its password, for an owner locked out
  destroy [--data] delete everything the platform made for the app; --data also deletes its data
  apps move        give the app's name to this repo, when it takes the app over from another
  ci               run the command for the current GitHub Actions event`;

async function main(argv: string[], terminal: Terminal): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) < MIN_NODE) throw new UsageError(`@celsoft/platform needs Node ${MIN_NODE} or later, as its package.json says; this is Node ${process.versions.node}`);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, custom: { type: "string" }, rename: { type: "string", multiple: true }, create: { type: "string", multiple: true }, data: { type: "boolean", default: false }, pr: { type: "string" }, reset: { type: "boolean", default: false }, dir: { type: "string", default: "." }, name: { type: "string" }, hostname: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  if (values.help || positionals.length === 0) return terminal.log(usage);

  const appDir = resolve(values.dir);
  const dryRun = values["dry-run"];
  const inCi = positionals[0] === "ci";
  const command = inCi ? await commandForGitHubEvent() : parseCommand(positionals);
  if (!command) return terminal.log("nothing to do for this event");
  if (dryRun && (NO_DRY_RUN.has(command.name) || (command.name === "db stats" && values.reset))) throw new UsageError(`${command.name}${values.reset ? " --reset" : ""} has no dry run; run it without --dry-run`);

  const spec = COMMANDS[command.name] as Spec<Command["name"]>;
  const input = { appDir, dryRun, inCi, flags: values, terminal };
  if (spec.needs === "dir") return spec.run(command as never, input);
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const mismatch = await installedMismatch(appDir, version);
  if (mismatch) throw new UsageError(mismatch);
  const { config, variables } = await loadApp(appDir);
  maskInCi(Object.values(variables));
  if (spec.needs === "app") return spec.run(command as never, { ...input, config, variables });
  // The app's code imports these, so they are fresh for every run that builds or serves it.
  const declared = spec.generates ? await generate(appDir) : { pages: [], staticPoints: {} };
  if (inCi) await checkWorkflow(repoRoot(appDir), appDir, config, Object.keys(variables));
  const ctx = { ...(await context(appDir, config, dryRun, terminal)), pages: declared.pages, staticPoints: declared.staticPoints };
  if (ctx.providers?.neon) await requireProjectKey(ctx.ports.neon);
  await spec.run(command as never, { ...input, config, variables, ctx });
}

function parseCommand([name, pr, extra]: string[]): Command {
  if (name === "owner" && pr === "reset") {
    if (!extra?.includes("@")) throw new UsageError(`expected the owner's email\n\n${usage}`);
    return { name: "owner reset", email: extra };
  }
  if (name === "db" && pr === "generate") return { name: "db generate" };
  if (name === "db" && pr === "run") {
    if (!extra) throw new UsageError(`expected a .sql file\n\n${usage}`);
    return { name: "db run", file: extra };
  }
  if (name === "db" && pr === "stats") return { name: "db stats" };
  if (name === "apps" && pr === "move") return { name: "apps move" };
  if (name === "skills" || name === "new") return { name };
  if (name === "upgrade" || name === "sweep" || name === "previews" || name === "generate") return { name };
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
  if (name === "pull_request_target" && event.action === "closed") return { name: "cleanup", pr: event.number! };
  if (name === "pull_request") return event.action === "closed" ? { name: "cleanup", pr: event.number! } : { name: "preview", pr: event.number!, sha: event.pull_request?.head?.sha };
  if (name === "schedule") return { name: "sweep" };
  return undefined;
}

async function context(appDir: string, config: Config, dryRun: boolean, terminal: Terminal): Promise<Context> {
  // Every provider key is read whatever platform.jsonc turns on, so destroy can find what an
  // earlier configuration made.
  const secrets = await loadSecrets(appDir, [...tokenNames({ ...config, database: true, email: true }), ...config.secrets]);
  const cloudflareToken = requireToken(secrets, "CLOUDFLARE_API_TOKEN");
  const neonKey = config.database ? requireToken(secrets, "NEON_API_KEY") : (secrets.NEON_API_KEY ?? "");
  const resendKey = config.email ? requireToken(secrets, "RESEND_API_KEY") : (secrets.RESEND_API_KEY ?? "");
  const cloudflare = new CloudflareApi(cloudflareToken);
  let repo: Promise<Repo> | undefined;
  return {
    config,
    secrets,
    run: new Run(dryRun, (line) => terminal.log(line)),
    repo: () => (repo ??= currentRepo(appDir)),
    source: () => currentSource(appDir),
    providers: { neon: Boolean(neonKey && secrets.NEON_PROJECT_ID), mail: Boolean(resendKey) },
    ports: {
      cloudflare,
      neon: new NeonApi(neonKey),
      mail: new ResendApi(resendKey),
      registry: new R2Registry(cloudflare.s3, cloudflare),
      wrangler: new WranglerCli(appDir, { CLOUDFLARE_API_TOKEN: cloudflareToken }, config.worker),
      migrator: new DrizzleMigrator(appDir, config),
    },
  };
}

// Actions names the repo it runs in; locally the GitHub CLI looks it up from the git remote.
async function currentRepo(appDir: string): Promise<Repo> {
  const { GITHUB_REPOSITORY_ID: id, GITHUB_REPOSITORY: name } = process.env;
  if (id && name) return { id: Number(id), name };
  return new GhCli(repoRoot(appDir)).repository();
}

// In Actions, a pull request's own head commit and branch, not the merge commit it is checked out at.
async function currentSource(appDir: string): Promise<Source> {
  const { GITHUB_SHA, GITHUB_HEAD_REF, GITHUB_REF_NAME, GITHUB_EVENT_PATH } = process.env;
  if (GITHUB_SHA) {
    const event = GITHUB_EVENT_PATH ? (JSON.parse(await readFile(GITHUB_EVENT_PATH, "utf8")) as { pull_request?: { head?: { sha?: string } } }) : {};
    return { commit: event.pull_request?.head?.sha ?? GITHUB_SHA, branch: GITHUB_HEAD_REF || GITHUB_REF_NAME || "" };
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: appDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  return { commit: git("rev-parse", "HEAD"), branch: git("branch", "--show-current") };
}

function requireToken(secrets: Record<string, string>, name: string): string {
  const value = secrets[name];
  if (!value) throw new PreflightError(`${name} is not set; add it to .env.secrets, or to the repo's GitHub secrets in CI`);
  return value;
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

const MIN_NODE = 24;

const terminal = processTerminal();
main(process.argv.slice(2), terminal).catch((error: unknown) => {
  const known = error instanceof ConfigError || error instanceof PreflightError || error instanceof UsageError || error instanceof HttpsError || error instanceof MigrationQuestions;
  console.error(`✗ ${known ? (error as Error).message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
