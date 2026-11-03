import type { Redirects } from "./redirects.js";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Access, Level } from "./access.js";
import type { Auth } from "./auth.js";
import type { Cache } from "./cache.js";
import type { Email } from "./email.js";
import type { Files } from "./files.js";
import type { Invites } from "./invites.js";
import type { Live } from "./live.js";
import type { Organizations } from "./organizations.js";
import type { Routes } from "./routes.js";

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
  readonly redirects: Redirects;
  readonly invites: Invites;
  readonly routes: Routes;
  // The level the request's API token is capped at; undefined without a token.
  readonly cap: Level | undefined;
  session(): Promise<Session | null>;
  requireUser(): Promise<User>;
  waitUntil(promise: Promise<unknown>): void;
}

// What a handler gets as `app`; an app wanting its own secrets and tables typed annotates the
// parameter with its own AppContext.
export type AnyApp = AppContext<any, any>;
