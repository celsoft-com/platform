import postgres from "postgres";
import type { Pool } from "pg";
import { AUTH_PATH, authPool, createAuth, type Auth } from "./auth.js";
import { createEmail, type Email, type EmailBindings } from "./email.js";
import { createFiles, type Files, type FilesBindings } from "./files.js";

export type { Auth } from "./auth.js";
export type { Email, EmailMessage } from "./email.js";
export type { FileEntry, Files, Folder, StoredObject } from "./files.js";

export type Sql = postgres.Sql;

export interface PlatformBindings extends EmailBindings, FilesBindings {
  DB?: { connectionString: string };
  APP_URL?: string;
  BETTER_AUTH_SECRET?: string;
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

export interface AppContext<Env> {
  env: Env;
  readonly sql: Sql;
  readonly email: Email;
  readonly files: Files;
  readonly auth: Auth;
  session(): Promise<Session | null>;
  waitUntil(promise: Promise<unknown>): void;
}

export type Handler<Env> = (request: Request, app: AppContext<Env>) => Response | Promise<Response>;

export interface AppOptions {
  connect?: (connectionString: string) => Sql;
}

const defaultConnect = (connectionString: string) => postgres(connectionString, { max: 5, fetch_types: false });

// `Secrets` names the app's secrets, such as `defineApp<{ SESSION_SECRET: string }>`; the
// platform's own bindings are added to it. With `auth` on, /api/auth/* is handled for the app.
export function defineApp<Secrets extends object = object>(handler: Handler<Secrets & PlatformBindings>, options: AppOptions = {}) {
  const connect = options.connect ?? defaultConnect;

  return {
    async fetch(request: Request, env: Secrets & PlatformBindings, ctx: ExecutionContext): Promise<Response> {
      let sql: Sql | undefined;
      let email: Email | undefined;
      let files: Files | undefined;
      let auth: Auth | undefined;
      let pool: Pool | undefined;

      const app: AppContext<Secrets & PlatformBindings> = {
        env,
        get sql() {
          if (!env.DB) throw new Error("this app has no database; add `database` to platform.jsonc");
          return (sql ??= connect(env.DB.connectionString));
        },
        get email() {
          return (email ??= createEmail(env));
        },
        get files() {
          return (files ??= createFiles(env));
        },
        get auth() {
          if (!env.BETTER_AUTH_SECRET) throw new Error("this app has no auth; set `auth: true` in platform.jsonc");
          if (!env.DB) throw new Error("auth needs a database; add `database` to platform.jsonc");
          return (auth ??= createAuth({
            pool: (pool ??= authPool(env.DB.connectionString)),
            secret: env.BETTER_AUTH_SECRET,
            baseURL: env.APP_URL ?? new URL(request.url).origin,
            email: app.email,
            requireVerification: env.EMAIL_MODE === "send",
          }));
        },
        async session() {
          return env.BETTER_AUTH_SECRET ? app.auth.api.getSession({ headers: request.headers }) : null;
        },
        waitUntil: (promise) => ctx.waitUntil(promise),
      };

      try {
        if (env.BETTER_AUTH_SECRET && new URL(request.url).pathname.startsWith(`${AUTH_PATH}/`)) {
          return await app.auth.handler(request);
        }
        return await handler(request, app);
      } finally {
        if (sql) ctx.waitUntil(sql.end({ timeout: 5 }));
        if (pool) ctx.waitUntil(pool.end());
      }
    },
  };
}
