import postgres from "postgres";

export type Sql = postgres.Sql;

export interface PlatformBindings {
  DB?: { connectionString: string };
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface AppContext<Env> {
  env: Env;
  readonly sql: Sql;
  waitUntil(promise: Promise<unknown>): void;
}

export type Handler<Env> = (request: Request, app: AppContext<Env>) => Response | Promise<Response>;

export interface AppOptions {
  connect?: (connectionString: string) => Sql;
}

const defaultConnect = (connectionString: string) => postgres(connectionString, { max: 5, fetch_types: false });

// `Secrets` names the app's secrets, such as `defineApp<{ SESSION_SECRET: string }>`; the
// platform's own bindings are added to it.
export function defineApp<Secrets extends object = object>(handler: Handler<Secrets & PlatformBindings>, options: AppOptions = {}) {
  const connect = options.connect ?? defaultConnect;

  return {
    async fetch(request: Request, env: Secrets & PlatformBindings, ctx: ExecutionContext): Promise<Response> {
      let sql: Sql | undefined;
      const app: AppContext<Secrets & PlatformBindings> = {
        env,
        get sql() {
          if (!env.DB) throw new Error("this app has no database; add `database` to platform.jsonc");
          return (sql ??= connect(env.DB.connectionString));
        },
        waitUntil: (promise) => ctx.waitUntil(promise),
      };

      try {
        return await handler(request, app);
      } finally {
        if (sql) ctx.waitUntil(sql.end({ timeout: 5 }));
      }
    },
  };
}
