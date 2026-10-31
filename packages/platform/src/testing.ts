import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { DrizzleMigrator } from "./adapters/drizzle.js";
import { CONFIG_FILE, configVariables, parseConfig, readConfigText, type Config } from "./config.js";
import type { StaticPoint } from "./runtime/access.js";
import { createCall, type Call } from "./runtime/client.js";
import type { EmailMessage } from "./runtime/email.js";
import type { LiveNamespace } from "./runtime/live.js";
import { apiRoutes, type Endpoint } from "./runtime/endpoints.js";
import { createFiles, memoryBucket, type Files } from "./runtime/files.js";
import { loadVars } from "./secrets.js";
import { listStaticFiles } from "./static-files.js";
import { featureVars } from "./wrangler-config.js";

// Runs an app's real runtime for its tests: routing, access checks, token caps, validation and
// auth are the platform's own code; only the cloud behind them is local. Postgres 18 for Neon,
// from the app's embedded-postgres or else the PATH, started once per test process; a bucket in memory for R2; an outbox for Resend; and a list of
// what was published for live rooms, which take no WebSockets here.

export const TEST_URL = "http://localhost";

interface TestableApp {
  endpoints: Record<string, Endpoint<any, any, any>>;
  staticPoints: Record<string, StaticPoint>;
  staticFiles: readonly string[];
  fetch(request: Request, env: never, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<Response>;
}

// A signed-up person; pass it to `as` to act as them.
export interface Caller {
  id: string;
  email: string;
  cookie: string;
}

export interface Acting<App> {
  call: Call<App>;
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

export interface TestApp<App> extends Acting<App> {
  // The test's own database, for seeding and checking rows; the app's requests use it too.
  db: NodePgDatabase<Record<string, unknown>>;
  // The app's files, the same ones `app.files` sees.
  files: Files;
  // Every email the app sent, oldest first.
  emails: EmailMessage[];
  // Every message the app published to a live room, oldest first.
  published: { room: string; message: unknown }[];
  // Signs a person up through the app's own sign-up, inviting them first when sign-up needs it.
  signUp(email: string, options?: { name?: string; password?: string }): Promise<Caller>;
  // Calls and requests made as that person, or with an API token.
  as(who: Caller | { token: string }): Acting<App>;
  close(): Promise<void>;
}

// Builds `app` on a database of its own, copied from one migrated with the app's drizzle/ folder,
// so every call gets a clean start. `dir` is the app's folder, holding platform.jsonc.
export async function testApp<App extends TestableApp>(app: App, options: { dir?: string } = {}): Promise<TestApp<App>> {
  const dir = resolve(options.dir ?? process.cwd());
  const config = await loadConfig(dir);
  const url = config.database ? await freshDatabase(dir, config, app.staticPoints) : undefined;
  const pool = url ? new Pool({ connectionString: url, max: 5 }) : undefined;
  const bucket = memoryBucket();
  const emails: EmailMessage[] = [];
  const published: { room: string; message: unknown }[] = [];
  // As the deploy's entry module does, so app.routes knows the frontend's files.
  if (config.frontend) app.staticFiles = await listStaticFiles(join(dir, config.frontend.dir));
  const env = {
    ...featureVars(config),
    APP_URL: TEST_URL,
    ...(url && { DB: { connectionString: url } }),
    ...(config.files && { FILES: bucket }),
    ...(config.email && { EMAIL_MODE: "capture", EMAIL_FROM: "noreply@localhost", EMAIL_OUTBOX: emails }),
    ...(config.auth && { BETTER_AUTH_SECRET: randomBytes(32).toString("hex") }),
    ...(config.live && { LIVE: recordingRooms(published) }),
  };

  async function send(request: Request): Promise<Response> {
    const pending: Promise<unknown>[] = [];
    const response = await app.fetch(request, env as never, { waitUntil: (promise) => void pending.push(promise) });
    const body = await response.arrayBuffer();
    await Promise.all(pending);
    return new Response(body, response);
  }

  const routes = Object.fromEntries(Object.entries(apiRoutes(app.endpoints)).map(([name, r]) => [name, [r.method, r.path] as const]));
  const acting = (headers: Record<string, string>): Acting<App> => ({
    call: createCall<App>(routes, { url: TEST_URL, link: () => null, fetch: (request) => send(withHeaders(request, headers)), headers }),
    fetch: (path, init = {}) => send(withHeaders(new Request(new URL(path, TEST_URL), init), headers)),
  });
  const anonymous = acting({ origin: TEST_URL });

  return {
    ...anonymous,
    get db() {
      if (!pool) throw new Error("this app has no database; set `database: true` in platform.jsonc");
      return drizzle(pool);
    },
    files: createFiles({ FILES: bucket }),
    emails,
    published,
    async signUp(email, { name = "Test Person", password = "test-password-1" } = {}) {
      if (!pool) throw new Error("this app has no auth; set `auth` in platform.jsonc");
      if (config.auth && config.auth.signup !== "open") {
        await pool.query(`insert into signup_invite (email, expires_at) select $1, now() + interval '1 day' where exists (select 1 from "user") on conflict (email) do nothing`, [email.trim().toLowerCase()]);
      }
      const response = await anonymous.fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, email, password }) });
      const body = (await response.json()) as { user?: { id: string }; message?: string };
      if (!response.ok || !body.user) throw new Error(`sign-up of ${email} failed: ${response.status} ${body.message ?? JSON.stringify(body)}`);
      const cookie = response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      return { id: body.user.id, email, cookie };
    },
    // A browser sends its page's origin with every form it posts, such as an upload.
    as: (who) => acting("token" in who ? { authorization: `Bearer ${who.token}` } : { cookie: who.cookie, origin: TEST_URL }),
    async close() {
      await pool?.end();
    },
  };
}

// Stands in for the live rooms' Durable Objects: a publish is recorded; a browser cannot join.
function recordingRooms(published: { room: string; message: unknown }[]): LiveNamespace {
  return {
    idFromName: (name) => name,
    get: (room) => ({
      async fetch(request) {
        if (new URL(request.url).pathname !== "/publish") return new Response("live rooms take no WebSockets in tests", { status: 501 });
        published.push({ room: room as string, message: JSON.parse(await request.text()) });
        return new Response(null, { status: 204 });
      },
    }),
  };
}

function withHeaders(request: Request, headers: Record<string, string>): Request {
  const merged = new Request(request);
  merged.headers.set("origin", TEST_URL);
  for (const [name, value] of Object.entries(headers)) merged.headers.set(name, value);
  return merged;
}

async function loadConfig(dir: string): Promise<Config> {
  const text = await readConfigText(dir);
  const names = configVariables(text);
  // A test reaches no real hostname, so a variable with no value, as in CI, gets a stand-in.
  const vars = { ...Object.fromEntries(names.map((name) => [name, "test.localhost"])), ...(await loadVars(dir, names)) };
  return parseConfig(text, join(dir, CONFIG_FILE), vars);
}

// One Postgres per test process, and one migrated template per app folder in it.
let server: Promise<string> | undefined;
const templates = new Map<string, Promise<string>>();

async function freshDatabase(dir: string, config: Config, staticPoints: Record<string, StaticPoint>): Promise<string> {
  const base = await (server ??= startPostgres(dir));
  let template = templates.get(dir);
  if (!template) templates.set(dir, (template = migratedTemplate(base, dir, config, staticPoints)));
  const name = await template;
  const fresh = `test_${randomUUID().replace(/-/g, "")}`;
  await withClient(base, (c) => c.query(`create database ${fresh} template ${name}`));
  return databaseUrl(base, fresh);
}

async function migratedTemplate(base: string, dir: string, config: Config, staticPoints: Record<string, StaticPoint>): Promise<string> {
  const migrator = new DrizzleMigrator(dir, config);
  if (!(await migrator.upToDate())) throw new Error("src/schema.ts has changes with no migration; run `npx @celsoft/platform db generate`, then test again");
  const name = `template_${randomUUID().replace(/-/g, "")}`;
  await withClient(base, (c) => c.query(`create database ${name}`));
  const url = databaseUrl(base, name);
  await migrator.migrate(url);
  if (config.auth) await migrator.prepareAccess(url, staticPoints);
  await migrator.prepareCache(url);
  return name;
}

// Postgres's programs: from the app's embedded-postgres, which npm installs for this machine, or
// else from the PATH, for a project that installs Postgres its own way.
function postgresBin(appDir: string): (program: string) => string {
  try {
    const wrapper = createRequire(join(appDir, "package.json")).resolve("embedded-postgres");
    const binaries = createRequire(wrapper).resolve(`@embedded-postgres/${process.platform}-${process.arch}`);
    return (program) => join(dirname(dirname(binaries)), "native", "bin", program);
  } catch {
    return (program) => program;
  }
}

async function startPostgres(appDir: string): Promise<string> {
  const bin = postgresBin(appDir);
  const version = tool(bin("postgres"), ["--version"], `testApp needs Postgres 18 or later: add embedded-postgres to the app's devDependencies, as \`new\` and \`upgrade\` do, or put Postgres 18 on the PATH`);
  const major = Number(/(\d+)\./.exec(version)?.[1]);
  if (!(major >= 18)) throw new Error(`testApp needs Postgres 18 or later, as Neon runs; found ${version.trim()}`);
  const folder = await mkdtemp(join(tmpdir(), "platform-pg-"));
  const data = join(folder, "data");
  tool(bin("initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C", "--no-instructions"]);
  tool(bin("pg_ctl"), ["-D", data, "-l", join(folder, "log"), "-w", "-o", `-k ${folder} -c listen_addresses='' -c fsync=off -c max_connections=200`, "start"]);
  // vitest can end a test process without running its exit handlers, so a process of its own
  // stops the server and removes its folder once this one is gone, however it ended.
  spawn(process.execPath, ["-e", STOP_WHEN_GONE, String(process.pid), bin("pg_ctl"), data, folder], { detached: true, stdio: "ignore" }).unref();
  return `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(folder)}`;
}

const STOP_WHEN_GONE = `
const { execFileSync } = require("node:child_process");
const { rmSync } = require("node:fs");
const [pid, pgCtl, data, folder] = process.argv.slice(1);
const timer = setInterval(() => {
  try {
    process.kill(Number(pid), 0);
    return;
  } catch {}
  clearInterval(timer);
  try {
    execFileSync(pgCtl, ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
  } catch {}
  rmSync(folder, { recursive: true, force: true });
}, 500);
`;

const databaseUrl = (base: string, name: string) => base.replace("/postgres?", `/${name}?`);

async function withClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

function tool(command: string, args: string[], missing?: string): string {
  try {
    return execFileSync(command, args, { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    const { code, stdout = "", stderr = "", message } = error as { code?: string; stdout?: string; stderr?: string; message: string };
    if (code === "ENOENT" && missing) throw new Error(missing);
    throw new Error(`${command} failed: ${message}\n${stdout}${stderr}`);
  }
}
