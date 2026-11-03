import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import { MCP_PATH } from "./runtime/mcp.js";
import { listStaticFiles } from "./static-files.js";
import { sharedPostgres } from "./test-postgres.js";
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
  // One JSON-RPC request to /mcp as that person, as an AI client sends it: the first call signs
  // in through the app's own OAuth flow (register, consent, token), as a client would.
  mcp(method: string, params?: object): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }>;
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
  const acting = (headers: Record<string, string>): Acting<App> => {
    const fetchAs = (path: string, init: RequestInit = {}) => send(withHeaders(new Request(new URL(path, TEST_URL), init), headers));
    let token: Promise<string> | undefined;
    let id = 0;
    return {
      call: createCall<App>(routes, { url: TEST_URL, link: () => null, fetch: (request) => send(withHeaders(request, headers)), headers }),
      fetch: fetchAs,
      async mcp(method, params = {}) {
        if (!headers.cookie) throw new Error("mcp needs a signed-in person: t.as(await t.signUp(email)).mcp(...)");
        token ??= mcpToken(fetchAs);
        const response = await fetchAs(MCP_PATH, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${await token}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        });
        if (!response.ok) throw new Error(`/mcp answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
        return (await response.json()) as { result?: Record<string, unknown>; error?: { code: number; message: string } };
      },
    };
  };
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
      await migrator.prepareTables(url);
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

const databaseUrl = (base: string, name: string) => base.replace("/postgres?", `/${name}?`);

// An access token for /mcp, got the way an AI client gets one: it registers, the signed-in person
// authorizes and consents, and it trades the code for a token with PKCE.
async function mcpToken(fetchAs: (path: string, init?: RequestInit) => Promise<Response>): Promise<string> {
  const json = { "content-type": "application/json" };
  const redirect = "http://localhost:1/callback";
  const resource = `${TEST_URL}${MCP_PATH}`;
  const step = async (what: string, response: Response) => {
    if (response.status >= 400) throw new Error(`MCP sign-in failed to ${what}: ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response;
  };
  const registered = await step("register", await fetchAs("/api/auth/oauth2/register", {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_name: "testApp", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code"], response_types: ["code"] }),
  }));
  const { client_id } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirect, scope: "openid", state: "testApp", code_challenge: challenge, code_challenge_method: "S256", resource });
  const authorized = await step("authorize", await fetchAs(`/api/auth/oauth2/authorize?${query}`, { redirect: "manual" }));
  const consentAt = new URL(authorized.headers.get("location") ?? "", TEST_URL);
  const consented = await step("consent", await fetchAs("/api/auth/oauth2/consent", { method: "POST", headers: json, body: JSON.stringify({ accept: true, oauth_query: consentAt.search.slice(1) }) }));
  const { url } = (await consented.json()) as { url: string };
  const code = new URL(url).searchParams.get("code");
  if (!code) throw new Error(`MCP sign-in got no code from consent: ${url}`);
  const exchanged = await step("trade the code for a token", await fetchAs("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id, code_verifier: verifier, resource }),
  }));
  return ((await exchanged.json()) as { access_token: string }).access_token;
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
