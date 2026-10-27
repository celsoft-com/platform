import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { applyStaticPoints, createAccess, LEVELS, LINK_HEADER, shareMessage, type Access, type Level, type StaticPoint } from "./access.js";
import { AUTH_PATH, createAuth, type Auth } from "./auth.js";
import { createEmail, type Email, type EmailBindings } from "./email.js";
import { apiHandler, undeclaredAccess, type Endpoint } from "./endpoints.js";
import { createFiles, type Files, type FilesBindings } from "./files.js";
import { isCrossSiteForm, needsSession, rateLimited, type RateLimiter } from "./guard.js";
import type { z } from "zod";
import { anyMessage, CLIENT_PATH, clientScript, createLive, joinRoom, LIVE_PATH, liveRoom, type Live, type LiveNamespace, type MessageCheck } from "./live.js";
import type { LivePeer } from "./live-client.js";
import { MCP_PATH, mcpChallenge, mcpUserId, serveMcp, WELL_KNOWN } from "./mcp.js";
import { createOrganizations, PLATFORM_API, serveOrganizations, type Organizations } from "./organizations.js";
import { EndpointError } from "./endpoint-error.js";
import { isScreen, renderScreen, renderTokensScreen, TOKENS_PATH } from "./screens.js";

export { LEVELS, LINK_HEADER, MAX_DEPTH, organizationPoint, teamPoint, type Access, type Grant, type Grantee, type Level, type Link, type PointInfo, type PointOptions, type ShareEmail, type StaticPoint } from "./access.js";
export type { Invitation, Member, Organization, Organizations, Team } from "./organizations.js";
export type { Auth } from "./auth.js";
export { EndpointError } from "./endpoint-error.js";
export { endpoint, type Door, type Endpoint, type EndpointDefinition, type Method } from "./endpoints.js";
export type { Email, EmailMessage } from "./email.js";
export type { FileEntry, Files, Folder, StoredObject } from "./files.js";
export type { Live } from "./live.js";
export type { LiveConnection, LiveHandlers, LivePeer } from "./live-client.js";

export interface PlatformBindings extends EmailBindings, FilesBindings {
  DB?: { connectionString: string };
  APP_URL?: string;
  APP_NAME?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_ORGANIZATIONS?: string;
  AUTH_API_TOKENS?: string;
  AUTH_LIMIT?: RateLimiter;
  LIVE?: LiveNamespace;
  LIVE_ROOMS?: string;
  MCP?: string;
  ACCESS?: string;
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
  screens?: { stylesheet?: string };
  live?: LiveOptions<Env, Schema>;
  // Control points declared in code, applied at every start; see StaticPoint.
  access?: { points?: Record<string, StaticPoint> };
  pool?: (connectionString: string) => Pool;
}

// What one Worker instance does once: applying the app's static points before the first check.
interface Once {
  staticPoints?: Promise<void>;
}

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
  const undeclared = undeclaredAccess(options.endpoints ?? {});

  return {
    // Read by the package to generate the browser client's routes; the app's own types come from here.
    endpoints: (options.endpoints ?? {}) as E,

    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      // With access on, every endpoint says what it checks, so a forgotten check never ships open.
      if (env.ACCESS === "on" && undeclared.length > 0) {
        console.error(`endpoints ${undeclared.join(", ")} declare no access; add access: { point, level } or access: "none"`);
        return json({ error: "this app is misconfigured; see its logs" }, 500);
      }
      const { app, close } = createContext(request, env, ctx, options, once);
      let closeToken: (() => void) | undefined;
      try {
        if (isCrossSiteForm(request, url)) return json({ error: "cross-site form submissions are refused" }, 403);
        // A request with an API token runs as the token's owner, capped at the token's level.
        let current = app;
        const token = apiToken(request, url, env);
        if (token !== null) {
          const holder = await tokenHolder(app, token);
          if (!holder) return json({ error: "that API token is not valid; it may have expired or been revoked" }, 401);
          if (holder.cap === "read" && !READ_METHODS.includes(request.method)) return json({ error: "this API token can only read" }, 403);
          const made = createContext(request, env, ctx, options, once, async () => holder.session, holder.cap);
          current = made.app;
          closeToken = made.close;
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
          await onMessage(room, message as z.output<Message>, from, app);
          await Promise.allSettled(pending);
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
  let session: Promise<Session | null> | undefined;

  const app: AppContext<Env, Schema> = {
    env,
    get db() {
      if (!env.DB) throw new Error("this app has no database; add `database` to platform.jsonc");
      return (db ??= drizzle((pool ??= openPool(env.DB.connectionString)), { schema: options.schema ?? ({} as Schema) }));
    },
    get email() {
      return (email ??= createEmail(env));
    },
    get files() {
      return (files ??= createFiles(env));
    },
    get auth() {
      if (!env.BETTER_AUTH_SECRET) throw new Error("this app has no auth; set `auth: true` in platform.jsonc");
      return (auth ??= createAuth({
        db: app.db as NodePgDatabase<Record<string, unknown>>,
        secret: env.BETTER_AUTH_SECRET,
        baseURL: env.APP_URL ?? new URL(request.url).origin,
        email: app.email,
        requireVerification: env.EMAIL_MODE === "send",
      }));
    },
    get live() {
      return (live ??= createLive(env.LIVE, env.LIVE_ROOMS === "on", messageCheck(options.live?.message)));
    },
    get access() {
      if (env.ACCESS !== "on") throw new Error("this app has no access; set `access: true` in platform.jsonc");
      const origin = env.APP_URL ?? new URL(request.url).origin;
      const db = app.db as NodePgDatabase<Record<string, unknown>>;
      return (access ??= createAccess(db, async () => ({ userId: (await app.session())?.user.id ?? null, link: request.headers.get(LINK_HEADER), cap }), {
        // Sent after the answer, so a slow or failing email never fails the grant itself.
        notify: async (notice) => app.waitUntil(app.email.send(shareMessage(notice, env.APP_NAME ?? new URL(origin).hostname, origin)).catch((error) => console.error("sharing email failed", error))),
        // Once per Worker instance; a failure is retried by the next request.
        ready: () => (once.staticPoints ??= applyStaticPoints(db, options.access?.points ?? {}).catch((error) => {
          once.staticPoints = undefined;
          throw error;
        })),
      }));
    },
    get organizations() {
      if (!env.BETTER_AUTH_SECRET) throw new Error("this app has no auth; set `auth: true` in platform.jsonc");
      const origin = env.APP_URL ?? new URL(request.url).origin;
      const appName = env.APP_NAME ?? new URL(origin).hostname;
      return (organizations ??= createOrganizations(app.db as NodePgDatabase<Record<string, unknown>>, async () => ({ userId: (await app.session())?.user.id ?? null, link: null, cap }), async (notice) =>
        app.waitUntil(
          app.email
            .send({
              to: notice.to,
              subject: `Join ${notice.organization} on ${appName}`,
              text: `${notice.invitedBy ?? "Someone"} invited you to join ${notice.organization}:\n\n${new URL(`/login?invitation=${notice.invitationId}`, origin)}\n`,
            })
            .catch((error) => console.error("invitation email failed", error)),
        ),
      ));
    },
    session() {
      return (session ??= knownSession ? knownSession() : env.BETTER_AUTH_SECRET ? app.auth.api.getSession({ headers: request.headers }) : Promise.resolve(null));
    },
    async requireUser() {
      const current = await app.session();
      if (!current) throw json({ error: "sign in first" }, 401);
      return current.user;
    },
    waitUntil: (promise) => ctx.waitUntil(promise),
  };
  return { app, close: () => void (pool && ctx.waitUntil(pool.end())) };
}

// A session for a caller proved some other way than a cookie, such as an OAuth or API token.
async function sessionAs<Env, Schema extends Record<string, unknown>>(app: AppContext<Env, Schema>, userId: string, id: string): Promise<Session | null> {
  const user = await (await app.auth.$context).internalAdapter.findUserById(userId);
  if (!user || (user as { banned?: boolean | null }).banned) return null;
  return { user, session: { id, userId, token: "", expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(), updatedAt: new Date() } } as unknown as Session;
}

const READ_METHODS = ["GET", "HEAD", "OPTIONS"];
const TOKEN_ROUTES = ["create", "list", "delete", "get"];

// The API token a request carries, when tokens are on: only on /api/ outside /api/auth/, where
// a token can never make more tokens or change the account.
function apiToken(request: Request, url: URL, env: PlatformBindings): string | null {
  if (env.AUTH_API_TOKENS !== "on" || !env.BETTER_AUTH_SECRET) return null;
  if (!url.pathname.startsWith("/api/") || url.pathname.startsWith(`${AUTH_PATH}/`)) return null;
  return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

// The token's owner and cap, or null for a token that is unknown, expired, revoked, capped at
// no known level, or whose owner is gone.
async function tokenHolder<Env, Schema extends Record<string, unknown>>(app: AppContext<Env, Schema>, token: string): Promise<{ session: Session; cap: Level } | null> {
  const result = await app.auth.api.verifyApiKey({ body: { key: token } }).catch(() => null);
  if (!result?.valid || !result.key) return null;
  const cap = (result.key.metadata as { cap?: unknown } | null)?.cap;
  if (!LEVELS.includes(cap as Level)) return null;
  const session = await sessionAs(app, result.key.referenceId, `api-token ${result.key.id}`);
  return session ? { session, cap: cap as Level } : null;
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
  if (await rateLimited(request, path, env.AUTH_LIMIT)) return json({ error: "too many attempts; wait a minute" }, 429);
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
  }
  if (path.startsWith(`${AUTH_PATH}/`)) return app.auth.handler(request);

  if (needsSession(path)) await app.requireUser();
  return undefined;
}
