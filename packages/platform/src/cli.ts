#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { CloudflareApi } from "./adapters/cloudflare.js";
import { commentPreviewLink, GhCli } from "./adapters/github.js";
import { NeonApi } from "./adapters/neon.js";
import { R2Registry } from "./adapters/registry.js";
import { ResendApi } from "./adapters/resend.js";
import { DrizzleMigrator, MigrationQuestions } from "./adapters/drizzle.js";
import { queryStats, runSqlFile } from "./adapters/database.js";
import { resetOwner } from "./adapters/owner.js";
import { WranglerCli } from "./adapters/process.js";
import { CONFIG_FILE, ConfigError, loadApp, readConfigText, upgradeConfigText, type Config } from "./config.js";
import { generate } from "./generate.js";
import { HttpsError, waitForHttps } from "./https.js";
import { checkWorkflow, init, tokenNames } from "./init.js";
import { invalid, rules, scaffold, upgradeScaffold, type Answers } from "./scaffold.js";
import { packageManager, packageScripts, runScript, startScript } from "./scripts.js";
import { AGENT_SKILLS_DIR, installSkills } from "./skills.js";
import { cleanup, deploy, destroy, dev, DEV_URL, findPreviews, moveApp, neonProject, PreflightError, requireProjectKey, sweep, type Context } from "./lifecycle.js";
import type { Repo } from "./ports.js";
import { Run } from "./run.js";
import { addSecret, loadSecrets, loadVars, SECRETS_FILE } from "./secrets.js";

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

// Commands that would change something without saying so first; they refuse --dry-run rather
// than ignore it.
const NO_DRY_RUN = new Set(["skills", "generate", "upgrade", "db generate"]);

type Command = { name: "skills" } | { name: "new" } | { name: "generate" } | { name: "previews" } | { name: "apps move" } | { name: "db generate"; custom?: string } | { name: "sweep" } | { name: "owner reset"; email: string } | { name: "db run"; file: string } | { name: "db stats" } | { name: "upgrade" } | { name: "init" } | { name: "dev" } | { name: "deploy" } | { name: "destroy" } | { name: "preview"; pr: number; sha?: string } | { name: "cleanup"; pr: number };

async function main(argv: string[]): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) < MIN_NODE) throw new UsageError(`@celsoft/platform needs Node ${MIN_NODE} or later, as its package.json says; this is Node ${process.versions.node}`);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { "dry-run": { type: "boolean", default: false }, custom: { type: "string" }, rename: { type: "string", multiple: true }, create: { type: "string", multiple: true }, data: { type: "boolean", default: false }, pr: { type: "string" }, reset: { type: "boolean", default: false }, dir: { type: "string", default: "." }, name: { type: "string" }, hostname: { type: "string" }, help: { type: "boolean", short: "h" } },
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
  if (dryRun && (NO_DRY_RUN.has(command.name) || (command.name === "db stats" && values.reset))) throw new UsageError(`${command.name}${values.reset ? " --reset" : ""} has no dry run; run it without --dry-run`);

  if (command.name === "upgrade") {
    const { text, changes, neonProject: written } = upgradeConfigText(await readConfigText(appDir));
    if (written) await moveNeonProject(appDir, written);
    if (changes.length > 0) await writeFile(join(appDir, CONFIG_FILE), text);
    const scaffolded = await upgradeScaffold(appDir);
    if (changes.length === 0 && scaffolded.length === 0) return console.log("✓ this app already has the current shape");
    if (changes.length > 0) console.log(`✓ ${CONFIG_FILE}: ${changes.join(", ")}`);
    for (const change of scaffolded) console.log(`✓ ${change}`);
    console.log("review and commit the changes");
    return;
  }

  if (command.name === "skills") {
    const changed = await installSkills(appDir);
    for (const file of changed) console.log(`✓ ${file}`);
    console.log(`${changed.length === 0 ? "skills already current; " : ""}next: read ${SETUP_SKILL} and follow it`);
    return;
  }

  if (command.name === "new") {
    const name = values.name ?? (rules.name.pattern.test(basename(appDir)) ? basename(appDir) : undefined);
    await newApp(appDir, { name, hostname: values.hostname }, dryRun);
    return;
  }

  if (command.name === "generate") {
    for (const file of (await generate(appDir)).files) console.log(`✓ ${file}`);
    return;
  }

  if (command.name === "init") {
    const { config, variables } = await loadApp(appDir);
    maskInCi(Object.values(variables));
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
  maskInCi(Object.values(app.variables));
  if (command.name === "db generate") {
    const custom = values.custom;
    if (custom !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(custom)) throw new UsageError("--custom takes a name of lowercase letters, digits, - and _, such as place-notes");
    if (custom !== undefined && (values.rename || values.create)) throw new UsageError("--custom writes an empty migration, so drizzle-kit asks nothing; drop --rename and --create");
    const renames: Record<string, string> = {};
    for (const flag of values.rename ?? []) {
      const [from, to, more] = flag.split("=");
      if (!from || !to || more !== undefined) throw new UsageError(`--rename takes <old>=<new>, such as users=accounts or accounts.full_name=accounts.name; got ${flag}`);
      renames[to] = from;
    }
    await new DrizzleMigrator(appDir, app.config).generate({ custom, answers: { renames, creates: values.create ?? [] } });
    return;
  }
  // The app's code imports these, so they are fresh for every run that builds or serves it.
  const declared = command.name === "dev" || command.name === "deploy" || command.name === "preview" ? await generate(appDir) : { pages: [], staticPoints: {} };
  if (inCi) await checkWorkflow(repoRoot(appDir), appDir, app.config, Object.keys(app.variables));
  const ctx = { ...(await context(appDir, app.config, dryRun)), pages: declared.pages, staticPoints: declared.staticPoints };
  if (ctx.providers?.neon) await requireProjectKey(ctx.ports.neon);

  if (command.name === "cleanup") {
    await cleanup(ctx, command.pr);
    return;
  }
  if (command.name === "dev") {
    await devWithFrontend(ctx, appDir);
    return;
  }
  if (command.name === "owner reset") {
    await ownerReset(ctx, app.config, command.email, values.pr === undefined ? undefined : prNumber(values.pr));
    return;
  }
  if (command.name === "db run") {
    if (values.pr === undefined) throw new UsageError("db run works only on a preview's database; pass --pr <n>");
    await dbRun(ctx, app.config, resolve(command.file), prNumber(values.pr));
    return;
  }
  if (command.name === "db stats") {
    await dbStats(ctx, app.config, values.pr === undefined ? undefined : prNumber(values.pr), values.reset);
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

  // The frontend is built first, so a broken build stops the run before anything changes.
  if (!dryRun && (await packageScripts(appDir)).build) await runScript(appDir, await packageManager(repoRoot(appDir)), "build");
  const { hostname } = await deploy(ctx, command.name === "deploy" ? { kind: "prod" } : { kind: "preview", pr: command.pr });
  if (dryRun) return;
  console.log(`\nwaiting for https://${hostname} to answer over HTTPS`);
  await waitForHttps(`https://${hostname}`);
  console.log(`live at https://${hostname}`);

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


async function context(appDir: string, config: Config, dryRun: boolean): Promise<Context> {
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
    run: new Run(dryRun, (line) => console.log(line)),
    repo: () => (repo ??= currentRepo(appDir)),
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

export const DEV_SERVER_PORT = 5173;

// With a `dev` script, the frontend's dev server runs beside the local Worker and is where the app
// is opened; it forwards the Worker's paths, as the package's Vite plugin sets up.
async function devWithFrontend(ctx: Context, appDir: string): Promise<void> {
  if (!(await packageScripts(appDir)).dev) return dev(ctx);
  const appUrl = `http://localhost:${DEV_SERVER_PORT}`;
  const frontend = startScript(appDir, await packageManager(repoRoot(appDir)), "dev", { PLATFORM_WORKER_URL: DEV_URL, PLATFORM_DEV_PORT: String(DEV_SERVER_PORT) });
  try {
    await dev(ctx, { appUrl });
  } finally {
    frontend.kill();
  }
}

// Recovery for an owner who lost their password or email: whoever holds the project's tokens can
// already reach everything, so the new password is typed here, never passed as an argument.
async function ownerReset(ctx: Context, config: Config, email: string, pr: number | undefined): Promise<void> {
  if (!config.auth || !config.database) throw new UsageError("this app has no auth");
  const project = neonProject(ctx.secrets);
  const branch = pr === undefined ? await ctx.ports.neon.defaultBranch(project) : await ctx.ports.neon.findBranch(project, `pr-${pr}`);
  if (!branch) throw new PreflightError(`pull request ${pr} has no preview database`);
  const password = await newPassword();
  if (ctx.run.dryRun) return console.log(`~ would make ${email} the owner on ${branch.name} and set its password`);
  if (!(await resetOwner(await ctx.ports.neon.connectionUri(project, branch.id), email, password))) {
    throw new PreflightError(`no account uses ${email} on ${branch.name}; sign up with it first`);
  }
  console.log(`+ ${email} is the owner on ${branch.name}, with the new password; its sessions are signed out`);
}

async function branchUri(ctx: Context, config: Config, pr: number | undefined): Promise<{ name: string; uri: string }> {
  if (!config.database) throw new UsageError("this app has no database");
  const project = neonProject(ctx.secrets);
  const branch = pr === undefined ? await ctx.ports.neon.defaultBranch(project) : await ctx.ports.neon.findBranch(project, `pr-${pr}`);
  if (!branch) throw new PreflightError(`pull request ${pr} has no preview database`);
  return { name: branch.name, uri: await ctx.ports.neon.connectionUri(project, branch.id) };
}

async function dbRun(ctx: Context, config: Config, file: string, pr: number): Promise<void> {
  const branch = await branchUri(ctx, config, pr);
  if (ctx.run.dryRun) return console.log(`~ would run ${file} on ${branch.name}`);
  await runSqlFile(branch.uri, file);
  console.log(`+ ran ${file} on ${branch.name}`);
}

async function dbStats(ctx: Context, config: Config, pr: number | undefined, reset: boolean): Promise<void> {
  const branch = await branchUri(ctx, config, pr);
  const stats = await queryStats(branch.uri, reset);
  if (reset) return console.log(`✓ query counts cleared on ${branch.name}`);
  console.log(`costliest queries on ${branch.name}:`);
  console.log(`${"total".padEnd(10)}${"mean".padEnd(10)}${"calls".padEnd(9)}query`);
  for (const s of stats) console.log(`${`${Math.round(s.totalMs)}ms`.padEnd(10)}${`${s.meanMs.toFixed(2)}ms`.padEnd(10)}${String(s.calls).padEnd(9)}${s.query.slice(0, 140)}`);
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

// Asks for whatever the flags left out, in a terminal; elsewhere a missing answer stops it with
// the flag to pass.
async function newApp(appDir: string, answers: Partial<Answers>, dryRun: boolean): Promise<void> {
  if (process.stdin.isTTY && !process.env.CI) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const labels: Record<keyof Answers, string> = { name: "App name", hostname: "Prod hostname" };
    try {
      for (const key of Object.keys(labels) as (keyof Answers)[]) {
        while (!rules[key].pattern.test(answers[key] ?? "")) {
          if (answers[key]) console.log(`  must be ${rules[key].hint}`);
          answers[key] = (await rl.question(`${labels[key]}: `)).trim();
        }
      }
    } finally {
      rl.close();
    }
  }
  const flags: Record<keyof Answers, string> = { name: "--name", hostname: "--hostname" };
  const bad = invalid(answers);
  if (bad.length > 0) throw new UsageError(bad.map((key) => `${flags[key]}: ${rules[key].hint}`).join("\n"));

  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const { written, kept } = await scaffold(appDir, answers as Answers, version, dryRun);
  for (const file of written) console.log(dryRun ? `~ would write ${file}` : `✓ ${file}`);
  for (const file of kept) console.log(`• ${file} already there, kept`);
  // A new app may not be in a repository yet; then its own folder is the root.
  const manager = await packageManager(gitRoot(appDir) ?? appDir);
  if (dryRun) return console.log(`~ would run ${manager} install`);
  console.log(`\n${manager} install`);
  execFileSync(manager, ["install"], { cwd: appDir, stdio: "inherit" });
  console.log(`\nnext: continue ${SETUP_SKILL} at "Secrets file"`);
}

// The project id platform.jsonc used to hold goes to .env.secrets beside the key, resolving a ${NAME}
// from .env; init then copies it to GitHub.
async function moveNeonProject(appDir: string, written: string): Promise<void> {
  const variable = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(written)?.[1];
  const id = variable ? (await loadVars(appDir, [variable]))[variable] : written;
  if (!id) throw new PreflightError(`${CONFIG_FILE} names the Neon project as \${${variable}}, which .env does not set; set it there and run upgrade again`);
  if (await addSecret(repoRoot(appDir), "NEON_PROJECT_ID", id)) console.log(`+ NEON_PROJECT_ID in ${SECRETS_FILE}`);
  else console.log(`✓ NEON_PROJECT_ID already set in ${SECRETS_FILE}`);
  console.log(`next: run \`npx @celsoft/platform init\` to store it in GitHub${variable ? `, then remove ${variable} from .env and the repo's GitHub secrets` : ""}`);
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

// The git repository holding `dir`, asked of git once per run; undefined outside one.
const roots = new Map<string, string | undefined>();
function gitRoot(dir: string): string | undefined {
  if (!roots.has(dir)) {
    try {
      roots.set(dir, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      roots.set(dir, undefined);
    }
  }
  return roots.get(dir);
}

function repoRoot(dir: string): string {
  const root = gitRoot(dir);
  if (!root) throw new PreflightError(`${dir} is not inside a git repository`);
  return root;
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

const MIN_NODE = 24;

const SETUP_SKILL = join(AGENT_SKILLS_DIR, "celsoft-platform-setup", "SKILL.md");

main(process.argv.slice(2)).catch((error: unknown) => {
  const known = error instanceof ConfigError || error instanceof PreflightError || error instanceof UsageError || error instanceof HttpsError || error instanceof MigrationQuestions;
  console.error(`✗ ${known ? (error as Error).message : error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
