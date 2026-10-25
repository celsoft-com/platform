import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { AUTH_PATH, createAuth, type Auth } from "./auth.js";
import { createEmail, type Email, type EmailBindings } from "./email.js";
import { apiHandler, type Endpoint } from "./endpoints.js";
import { createFiles, type Files, type FilesBindings } from "./files.js";
import { isCrossSiteForm, needsSession, rateLimited, type RateLimiter } from "./guard.js";
import type { z } from "zod";
import { anyMessage, CLIENT_PATH, clientScript, createLive, joinRoom, LIVE_PATH, liveRoom, type Live, type LiveNamespace, type MessageCheck } from "./live.js";
import type { LivePeer } from "./live-client.js";
import { isScreen, renderScreen } from "./screens.js";

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
  AUTH_LIMIT?: RateLimiter;
  LIVE?: LiveNamespace;
  LIVE_ROOMS?: string;
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
  pool?: (connectionString: string) => Pool;
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

  return {
    // Read by the package to generate the browser client's routes; the app's own types come from here.
    endpoints: (options.endpoints ?? {}) as E,

    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const { app, close } = createContext(request, env, ctx, options);
      try {
        if (isCrossSiteForm(request, url)) return json({ error: "cross-site form submissions are refused" }, 403);
        const live = await liveRoute(request, url, env, app, options);
        if (live) return live;
        if (env.BETTER_AUTH_SECRET) {
          const platform = await platformRoute(request, url, env, app, options);
          if (platform) return platform;
        }
        const answered = await api?.handle(request, app);
        if (answered) return answered;
        return await handle(request, app);
      } catch (thrown) {
        if (thrown instanceof Response) return thrown;
        throw thrown;
      } finally {
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
        const { app, close } = createContext(new Request(env.APP_URL ?? "https://app.invalid/"), env, { waitUntil: (p) => void pending.push(p) }, options);
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
): { app: AppContext<Env, Schema>; close(): void } {
  const openPool = options.pool ?? defaultPool;
  let pool: Pool | undefined;
  let db: NodePgDatabase<Schema> | undefined;
  let email: Email | undefined;
  let files: Files | undefined;
  let auth: Auth | undefined;
  let live: Live | undefined;
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
    session() {
      return (session ??= env.BETTER_AUTH_SECRET ? app.auth.api.getSession({ headers: request.headers }) : Promise.resolve(null));
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
  if (request.method === "GET" && isScreen(path)) return renderScreen(path, env.APP_NAME ?? url.hostname, options.screens?.stylesheet);
  if (await rateLimited(request, path, env.AUTH_LIMIT)) return json({ error: "too many attempts; wait a minute" }, 429);
  if (path.startsWith(`${AUTH_PATH}/organization/`) && env.AUTH_ORGANIZATIONS !== "on") return json({ error: "not found" }, 404);
  if (path.startsWith(`${AUTH_PATH}/`)) return app.auth.handler(request);

  if (needsSession(path)) await app.requireUser();
  return undefined;
}
