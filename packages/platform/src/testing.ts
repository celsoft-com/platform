import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { type Client, Pool } from "pg";
import { withClient } from "./adapters/database.js";
import { DrizzleMigrator, MIGRATIONS_DIR } from "./adapters/drizzle.js";
import { loadApp, type Config } from "./config.js";
import type { StaticPoint } from "./runtime/access.js";
import { createCall, type Call } from "./runtime/client.js";
import type { EmailMessage } from "./runtime/email.js";
import type { LiveNamespace } from "./runtime/live.js";
import { apiRoutes, type Endpoint } from "./runtime/endpoints.js";
import { createFiles, memoryBucket, type Files } from "./runtime/files.js";
import type { EdgeCache } from "./runtime/index.js";
import { covers, features, workerFirst } from "./runtime/routes.js";
import { listStaticFiles } from "./static-files.js";
import { featureVars } from "./wrangler-config.js";

// Runs an app's real runtime for its tests: routing, access checks, token caps, validation and
// auth are the platform's own code; only the cloud behind them is local. Postgres 18 for Neon,
// from the app's embedded-postgres or else the PATH, one server shared by all of the app's test processes; a bucket in memory for R2; an outbox for Resend; and a list of
// what was published for live rooms, which take no WebSockets here.

export const TEST_URL = "http://localhost";

interface TestableApp {
  endpoints: Record<string, Endpoint<any, any, any>>;
  pages: readonly string[];
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
// `env` adds the app's own values, such as its secrets, which a test supplies itself.
export async function testApp<App extends TestableApp>(app: App, options: { dir?: string; env?: Record<string, string> } = {}): Promise<TestApp<App>> {
  const dir = resolve(options.dir ?? process.cwd());
  // A test reaches no real hostname, so a variable with no value, as in CI, gets a stand-in.
  const { config } = await loadApp(dir, { fallback: "test.localhost" });
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
    DEPLOY_TARGET: "test",
    // As a deploy runs: the page cache, keyed by a version that stays put for the test's life.
    CF_VERSION_METADATA: { id: "test" },
    EDGE_CACHE: memoryEdgeCache(),
    ...(url && { DB: { connectionString: url } }),
    ...(config.files && { FILES: bucket }),
    ...(config.email && { EMAIL_MODE: "capture", EMAIL_FROM: "noreply@localhost", EMAIL_OUTBOX: emails }),
    ...(config.auth && { BETTER_AUTH_SECRET: randomBytes(32).toString("hex") }),
    ...(config.live && { LIVE: recordingRooms(published) }),
    ...options.env,
  };

  // As Cloudflare serves the frontend: a GET of a file's path gets the file before the Worker,
  // unless the Worker claims the path first; with spa, a page request no file answers gets index.html.
  const frontendDir = config.frontend ? join(dir, config.frontend.dir) : undefined;
  const workerPaths = [...workerFirst(features(featureVars(config))), ...app.pages.flatMap((p) => (p === "/" ? [p] : [p, `${p}/*`]))];
  async function frontendFile(request: Request): Promise<Response | undefined> {
    if (!frontendDir || (request.method !== "GET" && request.method !== "HEAD")) return undefined;
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (workerPaths.some((pattern) => covers(pattern, pathname))) return undefined;
    const candidates = pathname.endsWith("/") ? [`${pathname}index.html`] : [pathname, `${pathname}.html`, `${pathname}/index.html`];
    if (config.frontend!.spa && (request.headers.get("accept") ?? "").includes("text/html")) candidates.push("/index.html");
    for (const candidate of candidates) {
      const file = resolve(frontendDir, `.${candidate}`);
      if (!file.startsWith(`${frontendDir}/`)) continue;
      const bytes = await readFile(file).catch(() => undefined);
      if (bytes) return new Response(request.method === "HEAD" ? null : bytes, { headers: { "content-type": contentType(file) } });
    }
    return undefined;
  }

  async function send(request: Request): Promise<Response> {
    const file = await frontendFile(request);
    if (file) return file;
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
    // Ends the app's connections and drops the test's database, so a kept server holds none.
    async close() {
      await pool?.end();
      if (url) await withClient(await server!, (c) => c.query(`drop database if exists ${new URL(url).pathname.slice(1)} with (force)`));
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

// One Postgres for every test process of an app, started by the first, and one migrated template
// per version of the app's schema and migrations in it, made by the first that needs it and kept
// between runs; each process keeps its own promise of both.
let server: Promise<string> | undefined;
const templates = new Map<string, Promise<string>>();

async function freshDatabase(dir: string, config: Config, staticPoints: Record<string, StaticPoint>): Promise<string> {
  const base = await (server ??= sharedPostgres(dir));
  let template = templates.get(dir);
  if (!template) templates.set(dir, (template = migratedTemplate(base, dir, config, staticPoints)));
  const name = await template;
  const fresh = `test_${randomUUID().replace(/-/g, "")}`;
  await withClient(base, (c) => c.query(`create database ${fresh} template ${name}`));
  return databaseUrl(base, fresh);
}

// A template's name: a hash of everything it is built from, the schema and every file it imports,
// the migrations and the static points, so a template that exists was checked and built from
// exactly what the app has now.
export async function templateName(dir: string, config: Config, staticPoints: Record<string, StaticPoint>): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify({ auth: Boolean(config.auth), staticPoints }));
  for (const file of await new DrizzleMigrator(dir, config).schemaSources()) hash.update(file).update(await readFile(file));
  const migrations = join(dir, MIGRATIONS_DIR);
  for (const file of await listStaticFiles(migrations)) hash.update(file).update(await readFile(join(migrations, file)));
  return `template_${hash.digest("hex").slice(0, 32)}`;
}

// A template that exists is used at once. Otherwise one process, holding an advisory lock, checks
// the schema has no ungenerated migration, which runs drizzle-kit and costs seconds, and builds it;
// the rest wait for the lock and find it built. Older templates of the app are dropped.
async function migratedTemplate(base: string, dir: string, config: Config, staticPoints: Record<string, StaticPoint>): Promise<string> {
  const name = await templateName(dir, config, staticPoints);
  const exists = (c: Client) => c.query("select 1 from pg_database where datname = $1", [name]).then((r) => Boolean(r.rowCount));
  await withClient(base, async (c) => {
    if (await exists(c)) return;
    await c.query("select pg_advisory_lock(hashtext('platform template'))");
    try {
      if (await exists(c)) return;
      const migrator = new DrizzleMigrator(dir, config);
      if (!(await migrator.upToDate())) throw new Error("the schema has changes with no migration, in src/schema.ts or, after an upgrade, in the platform's own tables; run `npx @celsoft/platform db generate`, review the SQL in drizzle/, then test again");
      const building = `building_${randomUUID().replace(/-/g, "")}`;
      await c.query(`create database ${building}`);
      const url = databaseUrl(base, building);
      await migrator.migrate(url);
      if (config.auth) await migrator.prepareAccess(url, staticPoints);
      await migrator.prepareCache(url);
      // Renamed only once whole, so a template that exists is always complete.
      await c.query(`alter database ${building} rename to ${name}`);
      const { rows } = await c.query<{ datname: string }>("select datname from pg_database where datname like 'template\\_%' and datname <> $1", [name]);
      for (const { datname } of rows) await c.query(`drop database if exists ${datname} with (force)`);
    } finally {
      await c.query("select pg_advisory_unlock(hashtext('platform template'))");
    }
  });
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

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// The app's server, shared by its test processes through a folder named after the app: each
// process registers its pid there, the first to take the lock starts the server and writes its
// address, and the rest wait for that. The folder doubles as the socket directory, so its path
// stays short enough for a Unix socket.
async function sharedPostgres(appDir: string): Promise<string> {
  const home = join(tmpdir(), `platform-pg-${createHash("sha256").update(resolve(appDir)).digest("hex").slice(0, 12)}`);
  await mkdir(join(home, "pids"), { recursive: true });
  await writeFile(join(home, "pids", String(process.pid)), "");
  const lock = join(home, "lock");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const url = await readFile(join(home, "url"), "utf8").catch(() => undefined);
    if (url && (await answers(url))) return url;
    if (await mkdir(lock).then(() => true, () => false)) {
      try {
        // Checked again under the lock: another process may have just started one.
        const again = await readFile(join(home, "url"), "utf8").catch(() => undefined);
        if (again && (await answers(again))) return again;
        // A server the watcher was about to stop, kept now that this process has registered.
        const stopping = await readFile(join(home, "url.stopping"), "utf8").catch(() => undefined);
        if (stopping && (await answers(stopping))) {
          await rename(join(home, "url.stopping"), join(home, "url"));
          return stopping;
        }
        return await startPostgres(appDir, home);
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    }
    // A starter that died holding the lock leaves it behind; a minute is far longer than a start.
    const held = await stat(lock).catch(() => undefined);
    if (held && Date.now() - held.mtimeMs > 60_000) await rm(lock, { recursive: true, force: true });
    await sleep(100);
  }
  throw new Error(`testApp waited two minutes for another test process to start Postgres in ${home}; remove that folder and test again`);
}

async function answers(url: string): Promise<boolean> {
  return withClient(url, async () => true).catch(() => false);
}

async function startPostgres(appDir: string, home: string): Promise<string> {
  const bin = postgresBin(appDir);
  const version = tool(bin("postgres"), ["--version"], `testApp needs Postgres 18 or later: add embedded-postgres to the app's devDependencies, as \`new\` and \`upgrade\` do, or put Postgres 18 on the PATH`);
  const major = Number(/(\d+)\./.exec(version)?.[1]);
  if (!(major >= 18)) throw new Error(`testApp needs Postgres 18 or later, as Neon runs; found ${version.trim()}`);
  // Kept between runs, so its templates are too and a run starts with no initdb; one that will not
  // start, such as one an older Postgres made, is made again.
  const data = join(home, "data");
  const start = () => tool(bin("pg_ctl"), ["-D", data, "-l", join(home, "log"), "-w", "-o", `-k ${home} -c listen_addresses='' -c fsync=off -c max_connections=500`, "start"]);
  const make = async () => {
    await rm(data, { recursive: true, force: true });
    tool(bin("initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C", "--no-instructions"]);
    start();
  };
  if (await stat(join(data, "PG_VERSION")).then(() => true, () => false)) {
    try {
      start();
    } catch (error) {
      // Never remade under a server still running on it.
      const running = (() => {
        try {
          tool(bin("pg_ctl"), ["-D", data, "status"]);
          return true;
        } catch {
          return false;
        }
      })();
      if (running) throw error;
      await make();
    }
  } else await make();
  const url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(home)}`;
  // Nobody uses it yet, so what an earlier run left, such as a test's database it never closed or a
  // template it was building when it ended, goes now; finished templates stay.
  await withClient(url, async (c) => {
    const { rows } = await c.query<{ datname: string }>("select datname from pg_database where datname like 'test\\_%' or datname like 'building\\_%'");
    for (const { datname } of rows) await c.query(`drop database if exists ${datname} with (force)`);
  });
  // Written whole, so a waiting process never reads half an address.
  await writeFile(join(home, "url.next"), url);
  await rename(join(home, "url.next"), join(home, "url"));
  // vitest can end a test process without running its exit handlers, so a process of its own
  // stops the server once no registered process is left, however they ended; its data stays.
  spawn(process.execPath, ["-e", STOP_WHEN_GONE, bin("pg_ctl"), data, home], { detached: true, stdio: "ignore" }).unref();
  return url;
}

const STOP_WHEN_GONE = `
const { execFileSync } = require("node:child_process");
const { mkdirSync, readdirSync, renameSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const [pgCtl, data, home] = process.argv.slice(1);
const pids = join(home, "pids");
const alive = () =>
  readdirSync(pids).filter((pid) => {
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      rmSync(join(pids, pid), { force: true });
      return false;
    }
  }).length > 0;
const timer = setInterval(() => {
  if (alive()) return;
  // The address goes first, so a process starting now starts a new server instead; one that
  // registered in between keeps this one.
  try {
    renameSync(join(home, "url"), join(home, "url.stopping"));
  } catch {}
  if (alive()) {
    try {
      renameSync(join(home, "url.stopping"), join(home, "url"));
    } catch {}
    return;
  }
  // Stopped cleanly under the start lock, so the next run never finds it half stopped.
  try {
    mkdirSync(join(home, "lock"));
  } catch {
    return;
  }
  clearInterval(timer);
  try {
    execFileSync(pgCtl, ["-D", data, "-m", "fast", "-w", "stop"], { stdio: "ignore" });
  } catch {}
  rmSync(join(home, "url.stopping"), { force: true });
  rmSync(join(home, "lock"), { recursive: true, force: true });
}, 500);
`;

const databaseUrl = (base: string, name: string) => base.replace("/postgres?", `/${name}?`);

function tool(command: string, args: string[], missing?: string): string {
  try {
    return execFileSync(command, args, { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    const { code, stdout = "", stderr = "", message } = error as { code?: string; stdout?: string; stderr?: string; message: string };
    if (code === "ENOENT" && missing) throw new Error(missing);
    throw new Error(`${command} failed: ${message}\n${stdout}${stderr}`);
  }
}

// The Cache API as a test needs it: one store per testApp, matched by the exact key.
function memoryEdgeCache(): EdgeCache {
  const store = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();
  return {
    async match(key) {
      const hit = store.get(key);
      return hit ? new Response(hit.body.slice(0), hit.init) : undefined;
    },
    async put(key, response) {
      store.set(key, { body: await response.arrayBuffer(), init: { status: response.status, headers: [...response.headers] } });
    },
  };
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json", txt: "text/plain; charset=utf-8", xml: "application/xml", svg: "image/svg+xml", png: "image/png",
  jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", woff2: "font/woff2", pdf: "application/pdf",
};
const contentType = (file: string) => CONTENT_TYPES[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
