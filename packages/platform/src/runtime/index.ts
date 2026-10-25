import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { AUTH_PATH, createAuth, type Auth } from "./auth.js";
import { createEmail, type Email, type EmailBindings } from "./email.js";
import { createFiles, type Files, type FilesBindings } from "./files.js";
import { isCrossSiteForm, needsSession, PLATFORM_API, rateLimited, type RateLimiter } from "./guard.js";
import { issueRecoveryCode, recoverOwner } from "./owner.js";
import { isScreen, renderScreen } from "./screens.js";

export type { Auth } from "./auth.js";
export type { Email, EmailMessage } from "./email.js";
export type { FileEntry, Files, Folder, StoredObject } from "./files.js";

export interface PlatformBindings extends EmailBindings, FilesBindings {
  DB?: { connectionString: string };
  APP_URL?: string;
  APP_NAME?: string;
  BETTER_AUTH_SECRET?: string;
  AUTH_ORGANIZATIONS?: string;
  AUTH_LIMIT?: RateLimiter;
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
  session(): Promise<Session | null>;
  requireUser(): Promise<User>;
  waitUntil(promise: Promise<unknown>): void;
}

export type Handler<Env, Schema extends Record<string, unknown>> = (request: Request, app: AppContext<Env, Schema>) => Response | Promise<Response>;

export interface AppOptions<Schema extends Record<string, unknown>> {
  schema?: Schema;
  screens?: { stylesheet?: string };
  pool?: (connectionString: string) => Pool;
}

const defaultPool = (connectionString: string) => new Pool({ connectionString, max: 5 });

const json = (body: unknown, status = 200) => Response.json(body, { status });

// `Secrets` names the app's secrets, such as `defineApp<{ SESSION_SECRET: string }>`; the
// platform's own bindings are added to it. Pass the app's tables as `schema` for a typed `app.db`.
// A handler may throw a Response, as `requireUser` does, and it is sent as the answer.
export function defineApp<Secrets extends object = object, Schema extends Record<string, unknown> = Record<string, never>>(
  handler: Handler<Secrets & PlatformBindings, Schema>,
  options: AppOptions<Schema> = {},
) {
  const openPool = options.pool ?? defaultPool;

  return {
    async fetch(request: Request, env: Secrets & PlatformBindings, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      let pool: Pool | undefined;
      let db: NodePgDatabase<Schema> | undefined;
      let email: Email | undefined;
      let files: Files | undefined;
      let auth: Auth | undefined;
      let session: Promise<Session | null> | undefined;

      const app: AppContext<Secrets & PlatformBindings, Schema> = {
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
            baseURL: env.APP_URL ?? url.origin,
            email: app.email,
            requireVerification: env.EMAIL_MODE === "send",
          }));
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

      try {
        if (isCrossSiteForm(request, url)) return json({ error: "cross-site form submissions are refused" }, 403);
        if (env.BETTER_AUTH_SECRET) {
          const platform = await platformRoute(request, url, env, app, options);
          if (platform) return platform;
        }
        return await handler(request, app);
      } catch (thrown) {
        if (thrown instanceof Response) return thrown;
        throw thrown;
      } finally {
        if (pool) ctx.waitUntil(pool.end());
      }
    },
  };
}

// What the platform answers itself for an app with auth: screens, auth routes, owner recovery,
// and the sign-in check in front of every private /api route.
async function platformRoute<Env extends PlatformBindings, Schema extends Record<string, unknown>>(
  request: Request,
  url: URL,
  env: Env,
  app: AppContext<Env, Schema>,
  options: AppOptions<Schema>,
): Promise<Response | undefined> {
  const path = url.pathname;
  if (request.method === "GET" && isScreen(path)) return renderScreen(path, env.APP_NAME ?? url.hostname, options.screens?.stylesheet);
  if (await rateLimited(request, path, env.AUTH_LIMIT)) return json({ error: "too many attempts; wait a minute" }, 429);
  if (path.startsWith(`${AUTH_PATH}/organization/`) && env.AUTH_ORGANIZATIONS !== "on") return json({ error: "not found" }, 404);
  if (path.startsWith(`${AUTH_PATH}/`)) return app.auth.handler(request);

  const db = app.db as NodePgDatabase<Record<string, unknown>>;
  if (path === `${PLATFORM_API}recovery-code` && request.method === "POST") {
    const user = await app.requireUser();
    return json({ code: await issueRecoveryCode(db, user.id) });
  }
  if (path === `${PLATFORM_API}recover` && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const { email, code, password } = body;
    if (typeof email !== "string" || typeof code !== "string" || typeof password !== "string" || password.length < 8) {
      return json({ error: "email, code and a password of at least 8 characters are required" }, 400);
    }
    return json({ ok: await recoverOwner(db, app.auth, { email, code, password }) });
  }
  if (needsSession(path)) await app.requireUser();
  return undefined;
}
