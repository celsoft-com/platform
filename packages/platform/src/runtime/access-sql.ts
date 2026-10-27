import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { MAX_DEPTH } from "./access.js";

// The platform's own SQL beside its tables: the triggers that keep each point's stored chain in
// access_ancestor. Drizzle's migrations create tables, not triggers, so every deploy, `dev` and the
// tests run this after migrations; each statement replaces what it finds, so running it again
// changes nothing.
const STATEMENTS = [
  // Rebuilds the chains of a point and every point below it, after its parent or inheritance changed.
  sql.raw(`
    create or replace function platform_access_rebuild(root text) returns void language sql as $$
      delete from access_ancestor where point_id in (
        with recursive sub as (select id from access_point where id = root union all select p.id from access_point p join sub on p.parent_id = sub.id)
        select id from sub);
      insert into access_ancestor (point_id, ancestor_id, depth)
      with recursive sub as (select id from access_point where id = root union all select p.id from access_point p join sub on p.parent_id = sub.id),
      chains as (
        select s.id as point_id, p.id as ancestor_id, p.parent_id, p.inherits, 0 as depth from sub s join access_point p on p.id = s.id
        union all
        select c.point_id, q.id, q.parent_id, q.inherits, c.depth + 1 from chains c join access_point q on q.id = c.parent_id
        where c.inherits and c.depth < ${MAX_DEPTH - 1}
      )
      select point_id, ancestor_id, depth from chains;
    $$`),
  sql.raw(`
    create or replace function platform_access_point_changed() returns trigger language plpgsql as $$
    begin
      if tg_op = 'INSERT' then
        insert into access_ancestor (point_id, ancestor_id, depth) values (new.id, new.id, 0);
        if new.inherits and new.parent_id is not null then
          insert into access_ancestor (point_id, ancestor_id, depth)
          select new.id, ancestor_id, depth + 1 from access_ancestor where point_id = new.parent_id and depth < ${MAX_DEPTH - 1};
        end if;
      elsif new.parent_id is distinct from old.parent_id or new.inherits is distinct from old.inherits then
        -- Every chain that reaches this point keeps what lies below it and swaps what lies above it.
        delete from access_ancestor t using access_ancestor r
        where r.ancestor_id = new.id and t.point_id = r.point_id and t.depth > r.depth;
        if new.inherits and new.parent_id is not null then
          insert into access_ancestor (point_id, ancestor_id, depth)
          select r.point_id, up.ancestor_id, r.depth + 1 + up.depth
          from access_ancestor r join access_ancestor up on up.point_id = new.parent_id
          where r.ancestor_id = new.id and r.depth + 1 + up.depth < ${MAX_DEPTH};
        end if;
      end if;
      return null;
    end $$`),
  sql.raw(`
    create or replace trigger platform_access_point_changed after insert or update of parent_id, inherits on access_point
    for each row execute function platform_access_point_changed()`),
];

// Installs the triggers, then fills access_ancestor for any point that has no chain yet, such as
// every point that existed before the table did.
export async function prepareAccess(db: Pick<NodePgDatabase<Record<string, unknown>>, "execute">): Promise<void> {
  for (const statement of STATEMENTS) await db.execute(statement);
  const [row] = (
    await db.execute(sql`select exists (select 1 from access_point p where not exists (select 1 from access_ancestor a where a.point_id = p.id and a.ancestor_id = p.id)) as missing`)
  ).rows as { missing: boolean }[];
  if (row?.missing) await db.execute(sql`select platform_access_rebuild(id) from access_point where parent_id is null`);
}
