import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { CloudflareApi } from "./adapters/cloudflare.js";
import { commentPreviewLink, GhCli } from "./adapters/github.js";
import { NeonApi } from "./adapters/neon.js";
import { ResendApi } from "./adapters/resend.js";
import { DrizzleMigrator } from "./adapters/drizzle.js";
import { queryStats, runSqlFile } from "./adapters/database.js";
import { resetOwner } from "./adapters/owner.js";
import { CONFIG_FILE, readConfigText, upgradeConfigText, type Config } from "./config.js";
import { generate } from "./generate.js";
import { waitForHttps } from "./https.js";
import { init } from "./init.js";
import { invalid, rules, scaffold, upgradeScaffold, type Answers } from "./scaffold.js";
import { packageManager, packageScripts, runScript, startScript } from "./scripts.js";
import { AGENT_SKILLS_DIR, installSkills } from "./skills.js";
import { cleanup, deploy, destroy, dev, DEV_URL, findPreviews, moveApp, neonProject, PreflightError, sweep, type Context } from "./lifecycle.js";
import { Run } from "./run.js";
import { addSecret, loadVars, SECRETS_FILE } from "./secrets.js";
import type { Terminal } from "./terminal.js";

// What each command does, given what it needs: the app's folder, its loaded config, or the whole
// Context the CLI composes; every word to the person goes through the Terminal.

export type Command =
  | { name: "skills" }
  | { name: "new" }
  | { name: "generate" }
  | { name: "previews" }
  | { name: "apps move" }
  | { name: "db generate" }
  | { name: "sweep" }
  | { name: "owner reset"; email: string }
  | { name: "db run"; file: string }
  | { name: "db stats" }
  | { name: "upgrade" }
  | { name: "init" }
  | { name: "dev" }
  | { name: "deploy" }
  | { name: "destroy" }
  | { name: "preview"; pr: number; sha?: string }
  | { name: "cleanup"; pr: number };

export class UsageError extends Error {}

export interface Flags {
  custom?: string;
  rename?: string[];
  create?: string[];
  data: boolean;
  pr?: string;
  reset: boolean;
  name?: string;
  hostname?: string;
}

export interface Input {
  appDir: string;
  dryRun: boolean;
  inCi: boolean;
  flags: Flags;
  terminal: Terminal;
}
export interface AppInput extends Input {
  config: Config;
  variables: Record<string, string>;
}
export interface ContextInput extends AppInput {
  ctx: Context;
}

type Of<N extends Command["name"]> = Extract<Command, { name: N }>;

// What a command needs before it runs: only the folder, the app's config, or the whole Context,
// with the generated files written first when it builds or serves the app.
export type Spec<N extends Command["name"]> =
  | { needs: "dir"; run(command: Of<N>, input: Input): Promise<void> }
  | { needs: "app"; run(command: Of<N>, input: AppInput): Promise<void> }
  | { needs: "context"; generates?: boolean; run(command: Of<N>, input: ContextInput): Promise<void> };

// Commands that would change something without saying so first; they refuse --dry-run rather
// than ignore it.
export const NO_DRY_RUN = new Set(["skills", "generate", "upgrade", "db generate"]);

export const SETUP_SKILL = join(AGENT_SKILLS_DIR, "celsoft-platform-setup", "SKILL.md");

export const COMMANDS: { [N in Command["name"]]: Spec<N> } = {
  upgrade: {
    needs: "dir",
    async run(_, { appDir, terminal }) {
      const { text, changes, neonProject: written } = upgradeConfigText(await readConfigText(appDir));
      if (written) await moveNeonProject(appDir, written, terminal);
      if (changes.length > 0) await writeFile(join(appDir, CONFIG_FILE), text);
      const scaffolded = await upgradeScaffold(appDir);
      if (changes.length === 0 && scaffolded.length === 0) return terminal.log("✓ this app already has the current shape");
      if (changes.length > 0) terminal.log(`✓ ${CONFIG_FILE}: ${changes.join(", ")}`);
      for (const change of scaffolded) terminal.log(`✓ ${change}`);
      terminal.log("review and commit the changes");
    },
  },
  skills: {
    needs: "dir",
    async run(_, { appDir, terminal }) {
      const changed = await installSkills(appDir);
      for (const file of changed) terminal.log(`✓ ${file}`);
      terminal.log(`${changed.length === 0 ? "skills already current; " : ""}next: read ${SETUP_SKILL} and follow it`);
    },
  },
  new: {
    needs: "dir",
    async run(_, { appDir, dryRun, flags, terminal }) {
      const name = flags.name ?? (rules.name.pattern.test(basename(appDir)) ? basename(appDir) : undefined);
      await newApp(appDir, { name, hostname: flags.hostname }, dryRun, terminal);
    },
  },
  generate: {
    needs: "dir",
    async run(_, { appDir, terminal }) {
      for (const file of (await generate(appDir)).files) terminal.log(`✓ ${file}`);
    },
  },
  init: {
    needs: "app",
    async run(_, { appDir, dryRun, config, variables, terminal }) {
      await init({
        repoRoot: repoRoot(appDir),
        appDir,
        config,
        variables,
        run: new Run(dryRun, (line) => terminal.log(line)),
        connect: (tokens) => ({
          cloudflare: new CloudflareApi(tokens.CLOUDFLARE_API_TOKEN!),
          neon: new NeonApi(tokens.NEON_API_KEY ?? ""),
          mail: new ResendApi(tokens.RESEND_API_KEY ?? ""),
          github: new GhCli(repoRoot(appDir)),
        }),
      });
    },
  },
  "db generate": {
    needs: "app",
    async run(_, { appDir, config, flags }) {
      const custom = flags.custom;
      if (custom !== undefined && !/^[a-z0-9][a-z0-9_-]*$/.test(custom)) throw new UsageError("--custom takes a name of lowercase letters, digits, - and _, such as place-notes");
      if (custom !== undefined && (flags.rename || flags.create)) throw new UsageError("--custom writes an empty migration, so drizzle-kit asks nothing; drop --rename and --create");
      const renames: Record<string, string> = {};
      for (const flag of flags.rename ?? []) {
        const [from, to, more] = flag.split("=");
        if (!from || !to || more !== undefined) throw new UsageError(`--rename takes <old>=<new>, such as users=accounts or accounts.full_name=accounts.name; got ${flag}`);
        renames[to] = from;
      }
      await new DrizzleMigrator(appDir, config).generate({ custom, answers: { renames, creates: flags.create ?? [] } });
    },
  },
  cleanup: { needs: "context", run: async (command, { ctx }) => void (await cleanup(ctx, command.pr)) },
  dev: { needs: "context", generates: true, run: (_, { ctx, appDir }) => devWithFrontend(ctx, appDir) },
  "owner reset": {
    needs: "context",
    run: (command, { ctx, config, flags, terminal }) => ownerReset(ctx, config, command.email, flags.pr === undefined ? undefined : prNumber(flags.pr), terminal),
  },
  "db run": {
    needs: "context",
    async run(command, { ctx, config, flags, terminal }) {
      if (flags.pr === undefined) throw new UsageError("db run works only on a preview's database; pass --pr <n>");
      await dbRun(ctx, config, resolve(command.file), prNumber(flags.pr), terminal);
    },
  },
  "db stats": {
    needs: "context",
    run: (_, { ctx, config, flags, terminal }) => dbStats(ctx, config, flags.pr === undefined ? undefined : prNumber(flags.pr), flags.reset, terminal),
  },
  previews: { needs: "context", run: (_, { ctx, appDir, terminal }) => listPreviews(ctx, appDir, terminal) },
  sweep: { needs: "context", run: async (_, { ctx, appDir }) => void (await sweep(ctx, await new GhCli(repoRoot(appDir)).openPullRequests())) },
  destroy: { needs: "context", run: (_, { ctx, config, flags, terminal }) => confirmDestroy(ctx, config.name, flags.data, terminal) },
  "apps move": { needs: "context", run: async (_, { ctx }) => void (await moveApp(ctx)) },
  deploy: { needs: "context", generates: true, run: (command, input) => deployAndWait(command, input) },
  preview: { needs: "context", generates: true, run: (command, input) => deployAndWait(command, input) },
};

// Prod or a preview: the frontend is built first, so a broken build stops the run before anything
// changes; then the deploy, and a wait until the hostname answers over HTTPS. A preview in CI
// comments its link and dry-runs prod with the change.
async function deployAndWait(command: Of<"deploy"> | Of<"preview">, { ctx, appDir, dryRun, inCi, terminal }: ContextInput): Promise<void> {
  if (!dryRun && (await packageScripts(appDir)).build) await runScript(appDir, await packageManager(repoRoot(appDir)), "build");
  const { hostname } = await deploy(ctx, command.name === "deploy" ? { kind: "prod" } : { kind: "preview", pr: command.pr });
  if (dryRun) return;
  terminal.log(`\nwaiting for https://${hostname} to answer over HTTPS`);
  await waitForHttps(`https://${hostname}`);
  terminal.log(`live at https://${hostname}`);

  if (inCi && command.name === "preview") {
    await commentPreviewLink(process.env, command.pr, `https://${hostname}`, command.sha);
    terminal.log("\nprod dry run with this change:");
    await deploy({ ...ctx, run: new Run(true, (line) => terminal.log(line)) }, { kind: "prod" });
  }
}

// Read-only: what exists for each preview, so leftovers a cleanup missed stand out.
async function listPreviews(ctx: Context, appDir: string, terminal: Terminal): Promise<void> {
  const previews = await findPreviews(ctx);
  if (previews.length === 0) return terminal.log("no previews");
  const open = await new GhCli(repoRoot(appDir)).openPullRequests();
  for (const { pr, pieces } of previews) {
    const state = open.includes(pr) ? "open" : "closed, the next sweep removes it";
    terminal.log(`PR ${String(pr).padEnd(6)} ${state}\n           ${pieces.join(", ")}`);
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
export async function ownerReset(ctx: Context, config: Config, email: string, pr: number | undefined, terminal: Terminal): Promise<void> {
  if (!config.auth || !config.database) throw new UsageError("this app has no auth");
  const project = neonProject(ctx.secrets);
  const branch = pr === undefined ? await ctx.ports.neon.defaultBranch(project) : await ctx.ports.neon.findBranch(project, `pr-${pr}`);
  if (!branch) throw new PreflightError(`pull request ${pr} has no preview database`);
  const password = await newPassword(terminal);
  if (ctx.run.dryRun) return terminal.log(`~ would make ${email} the owner on ${branch.name} and set its password`);
  if (!(await resetOwner(await ctx.ports.neon.connectionUri(project, branch.id), email, password))) {
    throw new PreflightError(`no account uses ${email} on ${branch.name}; sign up with it first`);
  }
  terminal.log(`+ ${email} is the owner on ${branch.name}, with the new password; its sessions are signed out`);
}

async function branchUri(ctx: Context, config: Config, pr: number | undefined): Promise<{ name: string; uri: string }> {
  if (!config.database) throw new UsageError("this app has no database");
  const project = neonProject(ctx.secrets);
  const branch = pr === undefined ? await ctx.ports.neon.defaultBranch(project) : await ctx.ports.neon.findBranch(project, `pr-${pr}`);
  if (!branch) throw new PreflightError(`pull request ${pr} has no preview database`);
  return { name: branch.name, uri: await ctx.ports.neon.connectionUri(project, branch.id) };
}

async function dbRun(ctx: Context, config: Config, file: string, pr: number, terminal: Terminal): Promise<void> {
  const branch = await branchUri(ctx, config, pr);
  if (ctx.run.dryRun) return terminal.log(`~ would run ${file} on ${branch.name}`);
  await runSqlFile(branch.uri, file);
  terminal.log(`+ ran ${file} on ${branch.name}`);
}

async function dbStats(ctx: Context, config: Config, pr: number | undefined, reset: boolean, terminal: Terminal): Promise<void> {
  const branch = await branchUri(ctx, config, pr);
  const stats = await queryStats(branch.uri, reset);
  if (reset) return terminal.log(`✓ query counts cleared on ${branch.name}`);
  terminal.log(`costliest queries on ${branch.name}:`);
  terminal.log(`${"total".padEnd(10)}${"mean".padEnd(10)}${"calls".padEnd(9)}query`);
  for (const s of stats) terminal.log(`${`${Math.round(s.totalMs)}ms`.padEnd(10)}${`${s.meanMs.toFixed(2)}ms`.padEnd(10)}${String(s.calls).padEnd(9)}${s.query.slice(0, 140)}`);
}

// Typed twice in a terminal with nothing echoed; the first line of standard input otherwise.
async function newPassword(terminal: Terminal): Promise<string> {
  const password = await terminal.askSecret("New password: ");
  if (terminal.tty && (await terminal.askSecret("Same password again: ")) !== password) throw new UsageError("the passwords did not match");
  if (password.length < 8) throw new UsageError("the password needs at least 8 characters");
  return password;
}

// Asks for whatever the flags left out when someone is there to answer; elsewhere a missing answer
// stops it with the flag to pass.
async function newApp(appDir: string, answers: Partial<Answers>, dryRun: boolean, terminal: Terminal): Promise<void> {
  if (terminal.interactive) {
    const labels: Record<keyof Answers, string> = { name: "App name", hostname: "Prod hostname" };
    for (const key of Object.keys(labels) as (keyof Answers)[]) {
      while (!rules[key].pattern.test(answers[key] ?? "")) {
        if (answers[key]) terminal.log(`  must be ${rules[key].hint}`);
        answers[key] = (await terminal.ask(`${labels[key]}: `)).trim();
      }
    }
  }
  const flags: Record<keyof Answers, string> = { name: "--name", hostname: "--hostname" };
  const bad = invalid(answers);
  if (bad.length > 0) throw new UsageError(bad.map((key) => `${flags[key]}: ${rules[key].hint}`).join("\n"));

  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const { written, kept } = await scaffold(appDir, answers as Answers, version, dryRun);
  for (const file of written) terminal.log(dryRun ? `~ would write ${file}` : `✓ ${file}`);
  for (const file of kept) terminal.log(`• ${file} already there, kept`);
  // A new app may not be in a repository yet; then its own folder is the root.
  const manager = await packageManager(gitRoot(appDir) ?? appDir);
  if (dryRun) return terminal.log(`~ would run ${manager} install`);
  terminal.log(`\n${manager} install`);
  execFileSync(manager, ["install"], { cwd: appDir, stdio: "inherit" });
  terminal.log(`\nnext: continue ${SETUP_SKILL} at "Secrets file"`);
}

// The project id platform.jsonc used to hold goes to .env.secrets beside the key, resolving a ${NAME}
// from .env; init then copies it to GitHub.
async function moveNeonProject(appDir: string, written: string, terminal: Terminal): Promise<void> {
  const variable = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(written)?.[1];
  const id = variable ? (await loadVars(appDir, [variable]))[variable] : written;
  if (!id) throw new PreflightError(`${CONFIG_FILE} names the Neon project as \${${variable}}, which .env does not set; set it there and run upgrade again`);
  if (await addSecret(repoRoot(appDir), "NEON_PROJECT_ID", id)) terminal.log(`+ NEON_PROJECT_ID in ${SECRETS_FILE}`);
  else terminal.log(`✓ NEON_PROJECT_ID already set in ${SECRETS_FILE}`);
  terminal.log(`next: run \`npx @celsoft/platform init\` to store it in GitHub${variable ? `, then remove ${variable} from .env and the repo's GitHub secrets` : ""}`);
}

// Destroy lists what it will delete, then needs the app's name typed and a final yes, so a
// slip of the keyboard can never start it.
export async function confirmDestroy(ctx: Context, appName: string, data: boolean, terminal: Terminal): Promise<void> {
  if (!terminal.interactive) throw new UsageError("destroy asks for confirmation, so it runs only in a terminal");
  terminal.log(`destroy ${appName}${data ? ", including its data" : ""}:\n`);
  await destroy({ ...ctx, run: new Run(true, (line) => terminal.log(line)) }, { data });
  if (ctx.run.dryRun) return;

  terminal.log(`\n${data ? "This deletes the app's database tables, backups and files. They cannot be recovered." : "The app goes offline until its next deploy."}`);
  if ((await terminal.ask(`Type the app's name (${appName}) to continue: `)).trim() !== appName) return terminal.log("Name did not match; nothing was deleted.");
  if (!(await terminal.confirm("Last chance. Delete all of the above? [y/N] "))) return terminal.log("Nothing was deleted.");
  await destroy(ctx, { data });
  terminal.log(`\n${appName} destroyed; the next deploy sets it up from scratch.`);
}

// The git repository holding `dir`, asked of git once per run; undefined outside one.
const roots = new Map<string, string | undefined>();
export function gitRoot(dir: string): string | undefined {
  if (!roots.has(dir)) {
    try {
      roots.set(dir, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch {
      roots.set(dir, undefined);
    }
  }
  return roots.get(dir);
}

export function repoRoot(dir: string): string {
  const root = gitRoot(dir);
  if (!root) throw new PreflightError(`${dir} is not inside a git repository`);
  return root;
}

export function prNumber(value: string | undefined): number {
  const pr = Number(value);
  if (!Number.isInteger(pr) || pr <= 0) throw new UsageError(`expected a pull request number, got ${value ?? "nothing"}`);
  return pr;
}
