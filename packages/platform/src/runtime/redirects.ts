import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// Redirects the app keeps as data, so content can move without a deploy: a path the app no longer
// answers points at where it went. They are read only when nothing else answers a path, just before
// the one 404 page, so every path that resolves today costs nothing more.

type Db = Pick<NodePgDatabase<Record<string, unknown>>, "execute">;

export type RedirectStatus = 301 | 302 | 307 | 308;

export interface Redirect {
  from: string;
  to: string;
  status: RedirectStatus;
  // Also moves every path below `from`, keeping the rest of the path: /essay to /p/essay sends
  // /essay/x to /p/essay/x.
  prefix: boolean;
}

export interface Redirects {
  set(from: string, to: string, options?: { status?: RedirectStatus; prefix?: boolean }): Promise<void>;
  remove(from: string): Promise<void>;
  list(): Promise<Redirect[]>;
}

export const REDIRECT_STATEMENTS = [
  sql`create table if not exists platform_redirect (from_path text primary key, to_url text not null, status smallint not null default 301, prefix boolean not null default false, created_at timestamptz not null default now())`,
];

export const MAX_REDIRECT_PATH = 500;
const STATUSES: readonly number[] = [301, 302, 307, 308];

function checkFrom(from: unknown): asserts from is string {
  if (typeof from !== "string" || !from.startsWith("/") || from.length > MAX_REDIRECT_PATH || /[?#\s]/.test(from)) {
    throw new Error(`a redirect's from is a path starting with /, with no query, fragment or spaces, at most ${MAX_REDIRECT_PATH} characters`);
  }
  if (from === "/") throw new Error("a redirect cannot move / itself");
  if (from.startsWith("/api/") || from === "/api") throw new Error("a redirect cannot move /api/ paths; endpoints answer there");
}

function checkTo(to: unknown): asserts to is string {
  const ok = typeof to === "string" && to.length <= 2000 && ((to.startsWith("/") && !to.startsWith("//")) || /^https:\/\/[^\s]+$/.test(to));
  if (!ok) throw new Error("a redirect's to is a path starting with /, or an https:// address");
}

const trimmed = (path: string) => (path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path);

export function createRedirects(db: () => Db): Redirects {
  return {
    async set(from, to, options = {}) {
      checkFrom(from);
      checkTo(to);
      const status = options.status ?? 301;
      if (!STATUSES.includes(status)) throw new Error("a redirect's status is 301, 302, 307 or 308");
      const key = trimmed(from);
      if (trimmed(to) === key) throw new Error(`a redirect from ${from} to itself would loop`);
      await db().execute(sql`
        insert into platform_redirect (from_path, to_url, status, prefix) values (${key}, ${to}, ${status}, ${options.prefix ?? false})
        on conflict (from_path) do update set to_url = excluded.to_url, status = excluded.status, prefix = excluded.prefix`);
    },
    async remove(from) {
      checkFrom(from);
      await db().execute(sql`delete from platform_redirect where from_path = ${trimmed(from)}`);
    },
    async list() {
      const { rows } = await db().execute(sql`select from_path, to_url, status, prefix from platform_redirect order by from_path`);
      return (rows as { from_path: string; to_url: string; status: number; prefix: boolean }[]).map((r) => ({ from: r.from_path, to: r.to_url, status: Number(r.status) as RedirectStatus, prefix: r.prefix }));
    },
  };
}

// The redirect for a path nothing else answered: an exact one first, else the longest prefix one
// covering it, with the rest of the path and the query carried over.
export async function findRedirect(db: Db, url: URL): Promise<Response | undefined> {
  const path = trimmed(decodeURIComponent(url.pathname));
  if (path.length > MAX_REDIRECT_PATH) return undefined;
  const { rows } = await db.execute(sql`
    select from_path, to_url, status, prefix from platform_redirect
    where from_path = ${path} or (prefix and ${path} like replace(replace(replace(from_path, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '/%')
    order by (from_path = ${path}) desc, length(from_path) desc limit 1`);
  const found = (rows as { from_path: string; to_url: string; status: number; prefix: boolean }[])[0];
  if (!found) return undefined;
  const rest = path.slice(found.from_path.length);
  const target = new URL(found.to_url.replace(/\/$/, "") + rest || "/", url);
  if (url.search && !target.search) target.search = url.search;
  return new Response(null, { status: Number(found.status), headers: { location: target.origin === url.origin ? target.pathname + target.search : target.href } });
}
