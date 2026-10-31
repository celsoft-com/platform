import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

// Versions that cached pages are keyed by. Clearing or invalidating bumps a version, so the old
// copies are never asked for again and expire on their own: nothing is purged, so nothing is rate
// limited, and every data center sees the change. A sequence holds the app's version, since
// bumping one never waits on another writer; a row per invalidated path holds that page's.

type Db = Pick<NodePgDatabase<Record<string, unknown>>, "execute">;

export const CACHE_STATEMENTS = [
  sql`create sequence if not exists platform_cache_clear`,
  sql`create table if not exists platform_cache_page (path text primary key, version bigint not null)`,
];

// Written at deploy and by `dev`, never by requests.
export async function prepareCache(db: Db): Promise<void> {
  for (const statement of CACHE_STATEMENTS) await db.execute(statement);
}

// Each Worker instance remembers a path's versions this long, so a page asks the database at most
// once a second per instance however many visitors it has, and a clear is seen within it.
export const REMEMBER_MS = 1000;
const remembered = new Map<string, { at: number; version: string }>();

export async function pageVersion(db: Db, path: string, now = Date.now()): Promise<string> {
  const known = remembered.get(path);
  if (known && now - known.at < REMEMBER_MS) return known.version;
  const [row] = (
    await db.execute(sql`select (select case when is_called then last_value else 0 end from platform_cache_clear) as app, coalesce((select version from platform_cache_page where path = ${path}), 0) as page`)
  ).rows as { app: string | number; page: string | number }[];
  const version = `${row!.app}.${row!.page}`;
  if (remembered.size >= 10_000) remembered.clear();
  remembered.set(path, { at: now, version });
  return version;
}

export interface Cache {
  // Empties every cached page, within a second everywhere, for one query; every page then renders
  // once more on its next visit. Call it after the write commits.
  clear(): Promise<void>;
  // Empties one page, every query string of it, within a second everywhere; call it after the
  // write that changed the page commits.
  invalidate(path: string): Promise<void>;
}

export function createCache(db: () => Db): Cache {
  return {
    async clear() {
      await db().execute(sql`select nextval('platform_cache_clear')`);
      remembered.clear();
    },
    async invalidate(path) {
      if (!path.startsWith("/") || path.includes("?")) throw new Error(`app.cache.invalidate takes a path with no query, such as /stats; got ${JSON.stringify(path)}`);
      await db().execute(sql`insert into platform_cache_page (path, version) values (${path}, 1) on conflict (path) do update set version = platform_cache_page.version + 1`);
      remembered.delete(path);
    },
  };
}
