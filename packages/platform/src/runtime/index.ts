import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { apikey, user } from "../schema.js";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createAccess, hashToken, LEVELS, LINK_HEADER, linkTarget, MAX_LINKS, shareMessage, type Access, type Level, type StaticPoint } from "./access.js";
import { LINK_EXCHANGE_PATH } from "./link-header.js";
import { AUTH_PATH, createAuth, type Auth } from "./auth.js";
import { createEmail, type Email, type EmailBindings } from "./email.js";
import { apiHandler, undeclaredAccess, type Endpoint } from "./endpoints.js";
import { createFiles, type Files, type FilesBindings } from "./files.js";
import { isCrossSiteForm, needsSession, rateLimited, type RateLimiter } from "./guard.js";
import type { z } from "zod";
import { anyMessage, CLIENT_PATH, clientScript, createLive, joinRoom, LIVE_PATH, liveRoom, type Live, type LiveNamespace, type MessageCheck } from "./live.js";
import type { LivePeer } from "./live-client.js";
import { MCP_PATH, mcpChallenge, mcpUserId, WELL_KNOWN } from "./mcp.js";
import { createOrganizations, PLATFORM_API, serveOrganizations, type Organizations } from "./organizations.js";
import { pageServer, type Page, type PageCache } from "./pages.js";
import { EndpointError } from "./endpoint-error.js";
import { createInvites, INVITE_ONLY, INVITES_API, INVITES_PATH, serveInvites, signupAllowed, type Invites } from "./invites.js";
import { isScreen, renderInvitesScreen, renderScreen, renderTokensScreen, TOKENS_PATH } from "./screens.js";
import { createCache, pageVersion, type Cache } from "./cache.js";
import { conditional } from "./conditional.js";
import { Trace, withTiming } from "./trace.js";

export { LEVELS, LINK_HEADER, MAX_DEPTH, organizationPoint, teamPoint, type Access, type Grant, type Grantee, type Level, type Link, type PointInfo, type PointOptions, type ShareEmail, type StaticPoint } from "./access.js";
export type { Invitation, Member, Organization, Organizations, Team } from "./organizations.js";
export type { Auth } from "./auth.js";
export { EndpointError } from "./endpoint-error.js";
export { endpoint, type Door, type Endpoint, type EndpointDefinition, type Method } from "./endpoints.js";
export { page, route, type Page, type PageHandler, type PageResult, type PageRoute, type PathParams } from "./pages.js";
export type { Email, EmailMessage } from "./email.js";
export type { FileEntry, Files, Folder, StoredObject } from "./files.js";
export type { Live } from "./live.js";
export type { Cache } from "./cache.js";
export type { Invite, Invites } from "./invites.js";
export type { LiveConnection, LiveHandlers, LivePeer } from "./live-client.js";

export interface PlatformBindings extends EmailBindings, FilesBindings {
  DB?: { connectionString: string };
  APP_URL?: string;
  APP_NAME?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_ORGANIZATIONS?: string;
  AUTH_API_TOKENS?: string;
  // "open" lets anyone sign up; otherwise sign-up needs an invitation once the app has an account.
  AUTH_SIGNUP?: string;
  AUTH_LIMIT?: RateLimiter;
  API_LIMIT?: RateLimiter;
  LIVE?: LiveNamespace;
  LIVE_ROOMS?: string;
  MCP?: string;
  ACCESS?: string;
  // The deployed version, which keys cached pages so every deploy starts with none.
  CF_VERSION_METADATA?: { id: string };
  // "on" on previews and in local dev: every response says where its time went, in Server-Timing;
  // "sample" in prod: one request in SAMPLE_EVERY logs it instead.
  TRACE?: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type User = Session["user"];

export interface AppContext<Env, Schema extends Record<string, unknown>> {
  env: Env;
  readonly db: NodePgDatabase<Schema>;
  readonly email: Email;
  readonly files: Files;
  readonly auth: Auth;
  readonly live: Live;
  readonly access: Access;
  readonly organizations: Organizations;
  readonly cache: Cache;
  readonly invites: Invites;
  session(): Promise<Session | null>;
  requireUser(): Promise<User>;
  waitUntil(promise: Promise<unknown>): void;
}

export type Handler<Env, Schema extends Record<string, unknown>> = (request: Request, app: AppContext<Env, Schema>) => Response | Promise<Response>;

// Who may join and send to a live room, and what the app does with messages browsers send.
// Joining and sending are refused unless the app says yes. With a `message` schema, every message
// is checked against it, both from browsers and through app.live.publish.
export interface LiveOptions<Env, Schema extends Record<string, unknown>, Message extends z.ZodType = z.ZodType> {
  message?: Message;
  canJoin?(room: string, user: User | null, app: AppContext<Env, Schema>): boolean | Promise<boolean>;
  canSend?(room: string, user: User | null, app: AppContext<Env, Schema>): boolean | Promise<boolean>;
  onMessage?(room: string, message: z.output<Message>, from: LivePeer | null, app: AppContext<Env, Schema>): void | Promise<void>;
}

function messageCheck(schema: z.ZodType | undefined): MessageCheck {
  if (!schema) return anyMessage;
  return (message) => {
    const result = schema.safeParse(message);
    return result.success ? { ok: true, value: result.data } : { ok: false, error: result.error.issues.map((i) => `${i.path.join(".") || "message"}: ${i.message}`).join("; ") };
  };
}

export interface AppOptions<Env, Schema extends Record<string, unknown>> {
  schema?: Schema;
  // Typed functions served over the API, MCP or both; see `endpoint`.
  endpoints?: Record<string, Endpoint<any, any, AppContext<Env, Schema>>>;
  // Paths the Worker renders on each request; see `page`.
  pages?: Page[];
  screens?: { stylesheet?: string };
  live?: LiveOptions<Env, Schema>;
  // Control points declared in code, written by every deploy after migrations; see StaticPoint.
  access?: { points?: Record<string, StaticPoint> };
  pool?: (connectionString: string) => Pool;
}

// What one Worker instance does once: applying the app's static points before the first check.
interface Once {
  // Better Auth, built once per Worker instance: building it runs its plugins' setup queries.
  auth?: Map<string, Auth>;
}

type Db = NodePgDatabase<Record<string, unknown>>;

// The database the request being served uses. Better Auth is built once per Worker instance, so
// it reaches the database through requestDb, which hands each call to that request's own
// connection; a Worker cannot share a connection between requests.
interface DbSlot {
  db?: () => Db;
}
const dbSlot = new AsyncLocalStorage<DbSlot>();
const requestDb = new Proxy({} as Db, {
  get(_target, key) {
    const db = dbSlot.getStore()?.db?.();
    if (!db) throw new Error("the auth database was used outside a request");
    const value = Reflect.get(db, key);
    return typeof value === "function" ? value.bind(db) : value;
  },
});

const defaultPool = (connectionString: string) => new Pool({ connectionString, max: 5 });

const json = (body: unknown, status = 200) => Response.json(body, { status });

const notFound: Handler<unknown, Record<string, unknown>> = () => json({ error: "not found" }, 404);

// `Secrets` names the app's secrets, such as `defineApp<{ SESSION_SECRET: string }>`; the
// platform's own bindings are added to it. Pass the app's tables as `schema` for a typed `app.db`.
// Endpoints are answered first; the handler, when given, takes every other request. A handler or
// endpoint may throw a Response, as `requireUser` does, and it is sent as the answer.
export function defineApp<
  Secrets extends object = object,
  Schema extends Record<string, unknown> = Record<string, never>,
  E extends Record<string, Endpoint<any, any, AppContext<Secrets & PlatformBindings, Schema>>> = Record<string, never>,
  Message extends z.ZodType = z.ZodType,
>(
  handler: Handler<Secrets & PlatformBindings, Schema> | undefined,
  options: AppOptions<Secrets & PlatformBindings, Schema> & { endpoints?: E; live?: LiveOptions<Secrets & PlatformBindings, Schema, Message> } = {},
) {
  type Env = Secrets & PlatformBindings;
  const onMessage = options.live?.onMessage;
  const check = messageCheck(options.live?.message);
  const handle = handler ?? (notFound as Handler<Env, Schema>);
  const api = apiHandler(options.endpoints ?? {});
  const once: Once = {};
  const pages = pageServer(options.pages ?? []);
  const undeclared = [...undeclaredAccess(options.endpoints ?? {}).map((name) => `endpoint ${name}`), ...(pages?.undeclared ?? [])];

  // One request, answered; `trace` collects where its time goes.
  async function serve(request: Request, env: Env, ctx: ExecutionContext, trace: Trace | undefined): Promise<Response> {
    const url = new URL(request.url);
    // With access on, every endpoint says what it checks, so a forgotten check never ships open.
    if (env.ACCESS === "on" && undeclared.length > 0) {
      console.error(`${undeclared.join(", ")} declare no access; add access: { point, level } or access: "none"`);
      return json({ error: "this app is misconfigured; see its logs" }, 500);
    }
    const { app, close } = createContext(request, env, ctx, options, once, undefined, undefined, trace);
    let closeToken: (() => void) | undefined;
    try {
      if (isCrossSiteForm(request, url)) return json({ error: "cross-site form submissions are refused" }, 403);
      // A request with an API token runs as the token's owner, capped at the token's level.
      let current = app;
      const onPage = Boolean(pages?.owns(url.pathname)) && (request.method === "GET" || request.method === "HEAD");
      const token = apiToken(request, url, env, onPage);
      // One caller cannot spend everyone's capacity: a token, a person, or else an address.
      const limited = env.API_LIMIT && (url.pathname.startsWith("/api/") || url.pathname === MCP_PATH || pages?.owns(url.pathname)) ? env.API_LIMIT : undefined;
      const address = `address ${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
      if (token !== null) {
        // A token's own allowance is spent before it is looked up, so a refused token costs no query.
        if (limited && (badTokenSenders.blocked(address) || !(await limited.limit({ key: `token ${(await hashToken(token)).slice(0, 32)}` })).success)) return tooMany();
        const holder = await tokenHolder(app, token);
        if (!holder) {
          // Fresh fake tokens would each get an allowance of their own, so a bad one spends its sender's.
          if (limited && !(await limited.limit({ key: address })).success) badTokenSenders.block(address);
          return json({ error: "that API token is not valid; it may have expired or been revoked" }, 401);
        }
        if (holder.cap === "read" && !READ_METHODS.includes(request.method)) return json({ error: "this API token can only read" }, 403);
        const made = createContext(request, env, ctx, options, once, async () => holder.session, holder.cap, trace);
        current = made.app;
        closeToken = made.close;
      } else if (limited) {
        const caller = (await current.session().catch(() => null))?.user.id ?? address;
        if (!(await limited.limit({ key: caller })).success) return tooMany();
      }
      const live = await liveRoute(request, url, env, current, options);
      if (live) return live;
      if (env.MCP === "on" && env.BETTER_AUTH_SECRET) {
        const answered = await mcpRoute(request, url, env, ctx, app, options, once);
        if (answered) return answered;
      }
      if (env.BETTER_AUTH_SECRET) {
        const platform = await platformRoute(request, url, env, current, options);
        if (platform) return platform;
      }
      const page = await pages?.handle(request, url, current, Boolean(env.BETTER_AUTH_SECRET), pageCache(env, ctx, current));
      if (page) return page;
      const answered = await api?.handle(request, current);
      if (answered) return answered;
      return await handle(request, current);
    } catch (thrown) {
      if (thrown instanceof Response) return thrown;
      // A refusal from app.access or app.organizations in a hand-written route answers like an endpoint's.
      if (thrown instanceof EndpointError) return json({ error: thrown.message }, thrown.status);
      throw thrown;
    } finally {
      closeToken?.();
      close();
    }
  }

  return {
    // Read by the package to generate the browser client's routes; the app's own types come from here.
    endpoints: (options.endpoints ?? {}) as E,
    // Read by the deploy, which routes these paths to the Worker before static files.
    pages: pages?.claims ?? [],
    // Read by the deploy, which writes them after migrations; requests never do.
    staticPoints: options.access?.points ?? {},

    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      // Prod times one request in SAMPLE_EVERY into its logs, never into the response.
      const sampled = env.TRACE === "sample" && Math.random() * SAMPLE_EVERY < 1;
      const trace = env.TRACE === "on" || sampled ? new Trace() : undefined;
      return dbSlot.run({}, async () => {
        const response = await conditional(request, await serve(request, env, ctx, trace));
        if (!sampled) return withTiming(response, trace);
        console.log(JSON.stringify({ timing: trace!.header(), method: request.method, path: new URL(request.url).pathname, status: response.status }));
        return response;
      });
    },

    // The Durable Object class behind live rooms, exported by the deploy's generated entry module.
    // A browser's message reaches the app's onMessage with the same `app` a request gets.
    LiveRoom: liveRoom((rawEnv) => {
      if (!onMessage) return undefined;
      const env = rawEnv as Env;
      return async (room, message, from) => {
        const pending: Promise<unknown>[] = [];
        const { app, close } = createContext(new Request(env.APP_URL ?? "https://app.invalid/"), env, { waitUntil: (p) => void pending.push(p) }, options, once);
        try {
          await dbSlot.run({}, async () => {
            await onMessage(room, message as z.output<Message>, from, app);
            await Promise.allSettled(pending);
          });
        } finally {
          close();
        }
      };
    }, check),
  };
}

function createContext<Env extends PlatformBindings, Schema extends Record<string, unknown>>(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  options: AppOptions<Env, Schema>,
  once: Once,
  // Set when the caller is already known, as for an MCP client signed in with a token.
  knownSession?: () => Promise<Session | null>,
  // The level an API token is capped at, when the request carries one.
  cap?: Level,
  trace?: Trace,
): { app: AppContext<Env, Schema>; close(): void } {
  const openPool = options.pool ?? defaultPool;
  let pool: Pool | undefined;
  let db: NodePgDatabase<Schema> | undefined;
  let email: Email | undefined;
  let files: Files | undefined;
  let auth: Auth | undefined;
  let live: Live | undefined;
  let access: Access | undefined;
  let organizations: Organizations | undefined;
  let cache: Cache | undefined;
  let invites: Invites | undefined;
  const levels = new Map<string, number>();
  let session: Promise<Session | null> | undefined;

  const app: AppContext<Env, Schema> = {
    env,
    get db() {
      if (!env.DB) throw new Error("this app has no database; add `database` to platform.jsonc");
      return (db ??= drizzle((pool ??= trace ? trace.wrap(openPool(env.DB.connectionString)) : openPool(env.DB.connectionString)), { schema: options.schema ?? ({} as Schema) }));
    },
    get email() {
      return (email ??= createEmail(env));
    },
    get files() {
      return (files ??= createFiles(env));
    },
    get auth() {
      if (!env.BETTER_AUTH_SECRET) throw new Error("this app has no auth; set `auth: true` in platform.jsonc");
      const slot = dbSlot.getStore();
      if (slot && !slot.db) slot.db = () => app.db as Db;
      const baseURL = env.APP_URL ?? new URL(request.url).origin;
      const requireVerification = env.EMAIL_MODE === "send";
      const key = `${env.BETTER_AUTH_SECRET}\n${baseURL}\n${requireVerification}`;
      const built = (once.auth ??= new Map());
      if (!auth) {
        auth = built.get(key);
        if (!auth) {
          auth = createAuth({ db: slot ? requestDb : (app.db as Db), secret: env.BETTER_AUTH_SECRET, baseURL, email: app.email, requireVerification });
          if (slot) built.set(key, auth);
        }
      }
      return auth;
    },
    get invites() {
      if (!env.BETTER_AUTH_SECRET) throw new Error("this app has no auth; set `auth: true` in platform.jsonc");
      const origin = env.APP_URL ?? new URL(request.url).origin;
      return (invites ??= createInvites(app.db as unknown as NodePgDatabase<Record<string, unknown>>, () => app.requireUser(), app.email, origin, env.APP_NAME ?? new URL(origin).hostname));
    },
    get cache() {
      if (!env.DB) throw new Error("app.cache needs a database; add `database` to platform.jsonc");
      return (cache ??= createCache(() => app.db as unknown as NodePgDatabase<Record<string, unknown>>));
    },
    get live() {
      return (live ??= createLive(env.LIVE, env.LIVE_ROOMS === "on", messageCheck(options.live?.message)));
    },
    get access() {
      if (env.ACCESS !== "on") throw new Error("this app has no access; set `access: true` in platform.jsonc");
      const origin = env.APP_URL ?? new URL(request.url).origin;
      const db = app.db as NodePgDatabase<Record<string, unknown>>;
      const links = [request.headers.get(LINK_HEADER), ...linkCookies(request)].filter((t): t is string => t !== null);
      return (access ??= createAccess(db, async () => ({ userId: (await app.session())?.user.id ?? null, link: links, cap }), {
        // Sent after the answer, so a slow or failing email never fails the grant itself.
        notify: async (notice) => app.waitUntil(app.email.send(shareMessage(notice, env.APP_NAME ?? new URL(origin).hostname, origin)).catch((error) => console.error("sharing email failed", error))),
        // Once per Worker instance; a failure is retried by the next request.
        memo: levels,
      }));
    },
    get organizations() {
      if (!env.BETTER_AUTH_SECRET) throw new Error("this app has no auth; set `auth: true` in platform.jsonc");
      const origin = env.APP_URL ?? new URL(request.url).origin;
      const appName = env.APP_NAME ?? new URL(origin).hostname;
      return (organizations ??= forgetLevelsOnChange(levels, createOrganizations(app.db as NodePgDatabase<Record<string, unknown>>, async () => ({ userId: (await app.session())?.user.id ?? null, link: null, cap }), async (notice) =>
        app.waitUntil(
          app.email
            .send({
              to: notice.to,
              subject: `Join ${notice.organization} on ${appName}`,
              text: `${notice.invitedBy ?? "Someone"} invited you to join ${notice.organization}:\n\n${new URL(`/login?invitation=${notice.invitationId}`, origin)}\n`,
            })
            .catch((error) => console.error("invitation email failed", error)),
        ),
      )));
    },
    session() {
      const find = () => (knownSession ? knownSession() : env.BETTER_AUTH_SECRET ? app.auth.api.getSession({ headers: request.headers }) : Promise.resolve(null));
      return (session ??= trace ? trace.time("session", "find the session", find) : find());
    },
    async requireUser() {
      const current = await app.session();
      if (!current) {
        // A page sends the visitor to sign in and come back; the API answers 401.
        const url = new URL(request.url);
        if (env.BETTER_AUTH_SECRET && !url.pathname.startsWith("/api/") && url.pathname !== MCP_PATH && READ_METHODS.includes(request.method)) throw signInRedirect(url);
        throw json({ error: "sign in first" }, 401);
      }
      return current.user;
    },
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
  return { app, close: () => void (pool && ctx.waitUntil(pool.end())) };
}

// Organization calls that only read; every other call can change who belongs where, and so any
// level found earlier in the request.
const ORGANIZATION_READS = new Set(["list", "get", "requireMember", "members", "invitations", "myInvitations", "team", "teams", "teamMembers"]);

function forgetLevelsOnChange(levels: Map<string, number>, organizations: Organizations): Organizations {
  return new Proxy(organizations, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function" || ORGANIZATION_READS.has(String(key))) return value;
      return async (...args: unknown[]) => {
        levels.clear();
        try {
          return await value.apply(target, args);
        } finally {
          levels.clear();
        }
      };
    },
  });
}

// A session for a caller proved some other way than a cookie, such as an OAuth or API token.
async function sessionAs<Env, Schema extends Record<string, unknown>>(app: AppContext<Env, Schema>, userId: string, id: string): Promise<Session | null> {
  const user = await (await app.auth.$context).internalAdapter.findUserById(userId);
  if (!user || (user as { banned?: boolean | null }).banned) return null;
  return { user, session: { id, userId, token: "", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() } } as unknown as Session;
}

const READ_METHODS = ["GET", "HEAD", "OPTIONS"];

const signInRedirect = (url: URL) => new Response(null, { status: 302, headers: { location: `/login?next=${encodeURIComponent(url.pathname + url.search)}`, "cache-control": "no-store" } });
const TOKEN_ROUTES = ["create", "list", "delete", "get"];
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The API token a request carries, when tokens are on: on /api/ outside /api/auth/, where a
// token can never make more tokens or change the account, and on page reads.
function apiToken(request: Request, url: URL, env: PlatformBindings, onPage: boolean): string | null {
  if (env.AUTH_API_TOKENS !== "on" || !env.BETTER_AUTH_SECRET) return null;
  const onApi = url.pathname.startsWith("/api/") && !url.pathname.startsWith(`${AUTH_PATH}/`);
  if (!onApi && !onPage) return null;
  return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

const SAMPLE_EVERY = 100;

interface EdgeCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

// Cloudflare's Cache API, shared by every visitor in a data center; keyed by the deploy and, with
// a database, by the versions app.cache bumps; absent outside Workers and without a deploy version.
function pageCache<Env extends PlatformBindings, Schema extends Record<string, unknown>>(env: Env, ctx: ExecutionContext, app: AppContext<Env, Schema>): PageCache | undefined {
  const edge = (globalThis as { caches?: { default?: EdgeCache } }).caches?.default;
  const deploy = env.CF_VERSION_METADATA?.id;
  if (!edge || !deploy) return undefined;
  return {
    version: async (path) => `${deploy}.${env.DB ? await pageVersion(app.db as unknown as NodePgDatabase<Record<string, unknown>>, path) : "0.0"}`,
    match: (key) => edge.match(key),
    put: (key, response) => ctx.waitUntil(edge.put(key, response)),
  };
}

const tooMany = () => Response.json({ error: "too many requests; slow down" }, { status: 429, headers: { "retry-after": "60" } });

// Addresses whose bad tokens spent their allowance, refused for a minute before any lookup; kept
// per Worker instance, so the rate limit itself stays the authority.
const badTokenSenders = (() => {
  const until = new Map<string, number>();
  return {
    blocked: (address: string) => (until.get(address) ?? 0) > Date.now(),
    block(address: string) {
      if (until.size >= 10_000) until.clear();
      until.set(address, Date.now() + 60_000);
    },
  };
})();

// How often a token's last use is written, at most; the tokens screen shows it to this accuracy.
const TOKEN_USE_EVERY_MS = 60 * 60 * 1000;

// The token's owner and cap, or null for a token that is unknown, disabled, expired, revoked,
// capped at no known level, or whose owner is gone or banned. One query reads the key and its
// owner together, where Better Auth's own check would read and write the key's row on every call;
// the last use is written at most hourly.
async function tokenHolder<Env, Schema extends Record<string, unknown>>(app: AppContext<Env, Schema>, token: string): Promise<{ session: Session; cap: Level } | null> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hashed = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const db = app.db as unknown as NodePgDatabase<Record<string, unknown>>;
  const [row] = await db
    .select({ id: apikey.id, metadata: apikey.metadata, lastRequest: apikey.lastRequest, owner: user })
    .from(apikey)
    .innerJoin(user, eq(user.id, apikey.referenceId))
    .where(
      and(
        eq(apikey.key, hashed),
        drizzleSql`${apikey.enabled} is not false`,
        drizzleSql`(${apikey.expiresAt} is null or ${apikey.expiresAt} > now())`,
        drizzleSql`(${apikey.remaining} is null or ${apikey.remaining} > 0)`,
        drizzleSql`(${user.banned} is not true or (${user.banExpires} is not null and ${user.banExpires} <= now()))`,
      ),
    );
  if (!row) return null;
  const cap = (JSON.parse(row.metadata ?? "null") as { cap?: unknown } | null)?.cap;
  if (!LEVELS.includes(cap as Level)) return null;
  if (!row.lastRequest || Date.now() - row.lastRequest.getTime() > TOKEN_USE_EVERY_MS) await db.update(apikey).set({ lastRequest: new Date() }).where(eq(apikey.id, row.id));
  const now = new Date();
  const session = { id: `api-token ${row.id}`, userId: row.owner.id, token: "", expiresAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now };
  return { session: { user: row.owner, session } as unknown as Session, cap: cap as Level };
}

// What a person may send when making a token: a name, a lifetime and a cap, and nothing else,
// so no token is made without an expiry or with Better Auth's server-only settings.
async function tokenCreateRequest(request: Request): Promise<Request | Response> {
  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "send a JSON object" }, 400);
  const cap = (body.metadata as { cap?: unknown } | undefined)?.cap ?? "manage";
  if (!LEVELS.includes(cap as Level)) return json({ error: `a token's cap is one of ${LEVELS.join(", ")}` }, 400);
  if (body.expiresIn !== undefined && body.expiresIn !== null && typeof body.expiresIn !== "number") return json({ error: "expiresIn is a number of seconds" }, 400);
  const clean = { name: body.name, ...(typeof body.expiresIn === "number" && { expiresIn: body.expiresIn }), metadata: { cap } };
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify(clean) });
}

const LINK_COOKIE = "platform_link_";
const LINK_COOKIE_DAYS = 30;

// The link tokens kept as cookies, one per point.
function linkCookies(request: Request): string[] {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c.startsWith(LINK_COOKIE))
    .map((c) => c.slice(c.indexOf("=") + 1))
    .slice(0, MAX_LINKS);
}

// Keeps a valid link token as an HttpOnly cookie named after its point, so a newer link to the
// same point replaces it; it lasts until the link expires, at most LINK_COOKIE_DAYS. A token that
// opens nothing is a 404, the same as any missing point.
async function exchangeLink(request: Request, url: URL, db: NodePgDatabase<Record<string, unknown>>): Promise<Response> {
  if (request.method !== "POST") return json({ error: "not found" }, 404);
  const body = (await request.json().catch(() => undefined)) as { link?: unknown } | undefined;
  const token = body?.link;
  const target = typeof token === "string" ? await linkTarget(db, token) : null;
  if (!target) return json({ error: "not found" }, 404);
  const days = LINK_COOKIE_DAYS * 86400;
  const seconds = Math.max(1, Math.min(days, target.expires ? Math.floor((target.expires.getTime() - Date.now()) / 1000) : days));
  const name = `${LINK_COOKIE}${(await hashToken(target.point)).slice(0, 16)}`;
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": `${name}=${token}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure}` } });
}

// The OAuth server's routes, which exist only for MCP.
const MCP_AUTH_PATHS = ["/oauth2/", "/admin/oauth2/", "/jwks", "/.well-known/"];

// MCP for AI clients: OAuth discovery under /.well-known/, and /mcp, where each call runs as the
// user its token was issued to.
async function mcpRoute<Env extends PlatformBindings, Schema extends Record<string, unknown>>(
  request: Request,
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  app: AppContext<Env, Schema>,
  options: AppOptions<Env, Schema>,
  once: Once,
): Promise<Response | undefined> {
  if (url.pathname.startsWith(WELL_KNOWN)) return app.auth.handler(request);
  if (url.pathname !== MCP_PATH) return undefined;
  const origin = env.APP_URL ?? url.origin;
  const userId = await mcpUserId(request, app.auth, `${origin}${MCP_PATH}`);
  if (!userId) return mcpChallenge(origin);
  const known = () => sessionAs(app, userId, "mcp");
  const { app: asUser, close } = createContext(request, env, ctx, options, once, known);
  try {
    if (!(await asUser.session())) return mcpChallenge(origin);
    const { serveMcp } = await import("./mcp-server.js");
    return await serveMcp(request, asUser, env.APP_NAME ?? url.hostname, options.endpoints ?? {});
  } finally {
    close();
  }
}

// Live rooms answer for themselves: the browser client, and joining a room once the app agrees.
async function liveRoute<Env extends PlatformBindings, Schema extends Record<string, unknown>>(
  request: Request,
  url: URL,
  env: Env,
  app: AppContext<Env, Schema>,
  options: AppOptions<Env, Schema>,
): Promise<Response | undefined> {
  if (!url.pathname.startsWith(LIVE_PATH) || env.LIVE_ROOMS !== "on" || !env.LIVE) return undefined;
  if (url.pathname === CLIENT_PATH) return clientScript();
  return joinRoom(request, url, env.LIVE, async (room) => {
    const user = (await app.session())?.user ?? null;
    const canJoin = (await options.live?.canJoin?.(room, user, app)) ?? false;
    const canSend = canJoin && ((await options.live?.canSend?.(room, user, app)) ?? false);
    return { user: user && { id: user.id, name: user.name }, canJoin, canSend };
  });
}

// What the platform answers itself for an app with auth: screens, auth routes, and the sign-in
// check in front of every private /api route.
async function platformRoute<Env extends PlatformBindings, Schema extends Record<string, unknown>>(
  request: Request,
  url: URL,
  env: Env,
  app: AppContext<Env, Schema>,
  options: AppOptions<Env, Schema>,
): Promise<Response | undefined> {
  const path = url.pathname;
  if (path === "/consent" && env.MCP !== "on") return undefined;
  if (request.method === "GET" && isScreen(path)) return renderScreen(path, env.APP_NAME ?? url.hostname, options.screens?.stylesheet);
  if (request.method === "GET" && path === TOKENS_PATH && env.AUTH_API_TOKENS === "on") return renderTokensScreen(env.APP_NAME ?? url.hostname, options.screens?.stylesheet);
  if (request.method === "GET" && path === INVITES_PATH) return renderInvitesScreen(env.APP_NAME ?? url.hostname, options.screens?.stylesheet);
  if (await rateLimited(request, path, env.AUTH_LIMIT)) return json({ error: "too many attempts; wait a minute" }, 429);
  if (path === LINK_EXCHANGE_PATH) {
    if (env.ACCESS !== "on") return json({ error: "not found" }, 404);
    return exchangeLink(request, url, app.db as NodePgDatabase<Record<string, unknown>>);
  }
  if (path === INVITES_API || path.startsWith(`${INVITES_API}/`)) {
    await app.requireUser();
    return serveInvites(request, path, app.invites);
  }
  // Checked here, before Better Auth makes the account, with the same answer for every refused
  // address, so it never tells who already has an account.
  if (path === `${AUTH_PATH}/sign-up/email` && request.method === "POST" && env.AUTH_SIGNUP !== "open") {
    const address = ((await request.clone().json().catch(() => ({}))) as { email?: unknown }).email;
    if (typeof address !== "string" || !(await signupAllowed(app.db as unknown as NodePgDatabase<Record<string, unknown>>, address))) return Response.json({ message: INVITE_ONLY, code: "INVITE_ONLY" }, { status: 403 });
  }
  if (path.startsWith(PLATFORM_API)) {
    if (env.AUTH_ORGANIZATIONS !== "on") return json({ error: "not found" }, 404);
    await app.requireUser();
    return serveOrganizations(request, path, app.organizations);
  }
  if (env.MCP !== "on" && MCP_AUTH_PATHS.some((p) => path.startsWith(`${AUTH_PATH}${p}`))) return json({ error: "not found" }, 404);
  if (path.startsWith(`${AUTH_PATH}/api-key/`)) {
    // Only the calls the tokens screen needs; updating could remove a token's expiry.
    if (env.AUTH_API_TOKENS !== "on" || !TOKEN_ROUTES.includes(path.slice(`${AUTH_PATH}/api-key/`.length))) return json({ error: "not found" }, 404);
    if (path === `${AUTH_PATH}/api-key/create`) {
      const checked = await tokenCreateRequest(request);
      return checked instanceof Response ? checked : app.auth.handler(checked);
    }
    // A token id that is not a UUID names nothing; Better Auth would fail on it instead.
    const keyId = path.endsWith("/delete") ? ((await request.clone().json().catch(() => ({}))) as { keyId?: unknown }).keyId : path.endsWith("/get") ? url.searchParams.get("id") : undefined;
    if (keyId !== undefined && (typeof keyId !== "string" || !UUID_TEXT.test(keyId))) return json({ error: "not found" }, 404);
  }
  if (path.startsWith(`${AUTH_PATH}/`)) return app.auth.handler(request);

  if (needsSession(path)) await app.requireUser();
  return undefined;
}
