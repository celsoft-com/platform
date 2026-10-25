#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { CloudflareApi } from "./adapters/cloudflare.js";
import { commentPreviewLink, GhCli } from "./adapters/github.js";
import { NeonApi } from "./adapters/neon.js";
import { R2Registry } from "./adapters/registry.js";
import { ResendApi } from "./adapters/resend.js";
import { DrizzleMigrator } from "./adapters/drizzle.js";
import { resetOwner } from "./adapters/owner.js";
import { WranglerCli } from "./adapters/process.js";
import { CONFIG_FILE, ConfigError, configVariables, parseConfig, readConfigText, upgradeConfigText, type Config } from "./config.js";
import { generate } from "./generate.js";
import { checkWorkflow, init, tokenNames } from "./init.js";
import { cleanup, deploy, destroy, dev, findPreviews, moveApp, PreflightError, requireProjectKey, sweep, type Context } from "./lifecycle.js";
import type { Repo } from "./ports.js";
import { Run } from "./run.js";
import { loadSecrets, loadVars } from "./secrets.js";

const usage = `usage: npx @celsoft/platform <command> [--dry-run] [--dir <app dir>]

commands:
  init             set up GitHub secrets, Environments and the deploy workflow
  dev              run the app locally against its own Neon branch
  db generate      write migrations for changes to the platform's tables and src/schema.ts
  generate         write the .platform/ files the app's code imports, such as the browser client
  upgrade          rewrite an older platform.jsonc to the current shape
  deploy           deploy prod
  preview <pr>     create or update the preview for a pull request
  cleanup <pr>     delete the preview for a pull request
  previews         list the previews that exist, with their pull request's state
  sweep            delete previews whose pull request is closed
  owner reset <email> [--pr <n>]
                   make that account the owner and set its password, for an owner locked out
  destroy [--data] delete everything the platform made for the app; --data also deletes its data
  apps move        give the app's name to this repo, when it takes the app over from another
  ci               run the command for the current GitHub Actions event`;

type Command = { name: "generate" } | { name: "previews" } | { name: "apps move" } | { name: "db generate" } | { name: "sweep" } | { name: "owner reset"; email: string } | { name: "upgrade" } | { name: "init" } | { name: "dev" } | { name: "deploy" } | { name: "destroy" } | { name: "preview"; pr: number; sha?: string } | { name: "cleanup"; pr: number };

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, data: { type: "boolean", default: false }, pr: { type: "string" }, dir: { type: "string", default: "." }, help: { type: "boolean", short: "h" } },
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

  // On install a failure only warns: install must never be blocked by the app's own code.
  if (command.name === "generate") {
    try {
      for (const file of await generate(appDir)) console.log(`✓ ${file}`);
    } catch (error) {
      if (process.env.npm_lifecycle_event !== "postinstall") throw error;
      console.warn(`! could not generate .platform/: ${error instanceof Error ? error.message : String(error)}`);
    }
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
  // The app's code imports these, so they are fresh for every run that builds or serves it.
  if (command.name === "dev" || command.name === "deploy" || command.name === "preview") await generate(appDir);
  if (inCi) await checkWorkflow(repoRoot(appDir), appDir, app.config, Object.keys(app.variables));
  const ctx = await context(appDir, app.config, dryRun);
  if (ctx.providers?.neon) await requireProjectKey(ctx.ports.neon);

  if (command.name === "cleanup") {
    await cleanup(ctx, command.pr);
    return;
  }
  if (command.name === "dev") {
    await dev(ctx);
    return;
  }
  if (command.name === "owner reset") {
    await ownerReset(ctx, app.config, command.email, values.pr === undefined ? undefined : prNumber(values.pr));
    return;
  }
  if (command.name === "previews") {
    await listPreviews(ctx, appDir);
    return;
  }
  if (command.name === "sweep") {
    await sweep(ctx, await new GhCli(repoRoot(appDir)).openPullRequests());
    return;
  }
  if (command.name === "destroy") {
    await confirmDestroy(ctx, app.config.name, values.data);
    return;
  }
  if (command.name === "apps move") {
    await moveApp(ctx);
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

function parseCommand([name, pr, extra]: string[]): Command {
  if (name === "owner" && pr === "reset") {
    if (!extra?.includes("@")) throw new UsageError(`expected the owner's email\n\n${usage}`);
    return { name: "owner reset", email: extra };
  }
  if (name === "db" && pr === "generate") return { name: "db generate" };
  if (name === "apps" && pr === "move") return { name: "apps move" };
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

async function loadApp(appDir: string): Promise<{ config: Config; variables: Record<string, string> }> {
  const text = await readConfigText(appDir);
  const names = configVariables(text);
  const vars = await loadVars(appDir, names);
  const variables = Object.fromEntries(names.filter((name) => vars[name]).map((name) => [name, vars[name]!]));
  maskInCi(Object.values(variables));
  return { config: parseConfig(text, join(appDir, CONFIG_FILE), variables), variables };
}

async function context(appDir: string, config: Config, dryRun: boolean): Promise<Context> {
  // Every provider key is read whatever platform.jsonc turns on, so destroy can find what an
  // earlier configuration made.
  const secrets = await loadSecrets(appDir, [...tokenNames({ ...config, email: true }), ...(config.database ? [] : ["NEON_API_KEY"]), ...config.secrets]);
  const cloudflareToken = requireToken(secrets, "CLOUDFLARE_API_TOKEN");
  const neonKey = config.database ? requireToken(secrets, "NEON_API_KEY") : (secrets.NEON_API_KEY ?? "");
  const resendKey = config.email ? requireToken(secrets, "RESEND_API_KEY") : (secrets.RESEND_API_KEY ?? "");
  const cloudflare = new CloudflareApi(cloudflareToken);
  let repo: Promise<Repo> | undefined;
  return {
    config,
    secrets,
    run: new Run(dryRun, (line) => console.log(line)),
    repo: () => (repo ??= currentRepo(appDir)),
    providers: { neon: Boolean(neonKey), mail: Boolean(resendKey) },
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

// Read-only: what exists for each preview, so leftovers a cleanup missed stand out.
async function listPreviews(ctx: Context, appDir: string): Promise<void> {
  const previews = await findPreviews(ctx);
  if (previews.length === 0) return console.log("no previews");
  const open = await new GhCli(repoRoot(appDir)).openPullRequests();
  for (const { pr, pieces } of previews) {
    const state = open.includes(pr) ? "open" : "closed, the next sweep removes it";
    console.log(`PR ${String(pr).padEnd(6)} ${state}\n           ${pieces.join(", ")}`);
  }
}

// Recovery for an owner who lost their password or email: whoever holds the project's tokens can
// already reach everything, so the new password is typed here, never passed as an argument.
async function ownerReset(ctx: Context, config: Config, email: string, pr: number | undefined): Promise<void> {
  if (!config.auth || !config.database) throw new UsageError("this app has no auth");
  const project = config.database.neonProject;
  const branch = pr === undefined ? await ctx.ports.neon.defaultBranch(project) : await ctx.ports.neon.findBranch(project, `pr-${pr}`);
  if (!branch) throw new PreflightError(`pull request ${pr} has no preview database`);
  const password = await newPassword();
  if (ctx.run.dryRun) return console.log(`~ would make ${email} the owner on ${branch.name} and set its password`);
  if (!(await resetOwner(await ctx.ports.neon.connectionUri(project, branch.id), email, password))) {
    throw new PreflightError(`no account uses ${email} on ${branch.name}; sign up with it first`);
  }
  console.log(`+ ${email} is the owner on ${branch.name}, with the new password; its sessions are signed out`);
}

// Typed twice in a terminal with nothing echoed; read from standard input otherwise.
async function newPassword(): Promise<string> {
  let password: string;
  if (process.stdin.isTTY) {
    let muted = false;
    const output = new Writable({ write: (chunk, _encoding, done) => (muted || process.stdout.write(chunk), done()) });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    const ask = async (prompt: string) => {
      process.stdout.write(prompt);
      muted = true;
      const answer = await rl.question("");
      muted = false;
      process.stdout.write("\n");
      return answer;
    };
    try {
      password = await ask("New password: ");
      if ((await ask("Same password again: ")) !== password) throw new UsageError("the passwords did not match");
    } finally {
      rl.close();
    }
  } else {
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    password = input.split(/\r?\n/)[0] ?? "";
  }
  if (password.length < 8) throw new UsageError("the password needs at least 8 characters");
  return password;
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
  const known = error instanceof ConfigError || error instanceof PreflightError || error instanceof UsageError;
  console.error(`✗ ${known ? (error as Error).message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
