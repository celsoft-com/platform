import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { EndpointError } from "./endpoint-error.js";
import { LINK_HEADER } from "./link-header.js";

export { LINK_HEADER };

// Who may do what to an app's items; see docs/design.md, App Code, Access, and the cases in
// docs/access-rules.md. Every check is one query against the app's own Postgres, never cached.

export const LEVELS = ["read", "create", "write", "delete", "manage"] as const;
export type Level = (typeof LEVELS)[number];
export type Grantee = { user: string } | { team: string } | { organization: string } | { email: string };

export interface Grant {
  to: Grantee;
  level: Level;
  grantedBy: string | null;
}

// How a new grant to a person is announced: an email with a link to `path` in the app, worded by
// the platform unless the app gives its own subject and text; `false` sends nothing.
export type ShareEmail = { path?: string; subject?: string; text?: string } | false;

export interface ShareNotice {
  to: string;
  sharedBy: string | null;
  level: Level;
  path: string;
  subject?: string;
  text?: string;
}

export interface Link {
  id: string;
  level: Level;
  expiresAt: Date | null;
}

export interface Access {
  level(kind: string, id: string): Promise<Level | null>;
  can(kind: string, id: string, level: Level): Promise<boolean>;
  // Throws a 404 unless the caller has `level`, so items people cannot see look missing.
  require(kind: string, id: string, level: Level): Promise<void>;
  // Records where an item sits, when it is created or moved; the parent may be a "user" or an
  // "organization" at the top of the tree.
  place(kind: string, id: string, parentKind: string, parentId: string): Promise<void>;
  remove(kind: string, id: string): Promise<void>;
  restrict(kind: string, id: string, restricted?: boolean): Promise<void>;
  // A new grant to a user or an email address sends them an email; teams and organizations get none.
  share(kind: string, id: string, to: Grantee, level: Level, options?: { email?: ShareEmail }): Promise<void>;
  revoke(kind: string, id: string, to: Grantee): Promise<void>;
  grants(kind: string, id: string): Promise<Grant[]>;
  sharedWithMe(kind: string): Promise<string[]>;
  link(kind: string, id: string, level: Level, options?: { expires?: Date }): Promise<{ id: string; token: string }>;
  links(kind: string, id: string): Promise<Link[]>;
  revokeLink(kind: string, id: string, linkId: string): Promise<void>;
  // A condition for the app's own query: rows whose `column` holds the id of a `kind` item the
  // caller has `level` on.
  accessible(kind: string, level: Level, column: unknown): Promise<SQL>;
  // The same calls inside the app's transaction, so a change and its access commit together.
  in(tx: unknown): Access;
}

export interface Caller {
  userId: string | null;
  // A link token the request carries, as the `x-access-link` header.
  link: string | null;
}

// The longest chain from an item up to its user or organization, counting the item itself.
export const MAX_DEPTH = 64;

const ROOTS = ["user", "organization"];
const KIND = /^[a-z][a-z0-9_-]{0,62}$/;
const [READ, CREATE, WRITE, DELETE, MANAGE] = [1, 2, 3, 4, 5];

type Db = Pick<NodePgDatabase<Record<string, unknown>>, "execute" | "transaction">;

export function rank(level: Level): number {
  const n = LEVELS.indexOf(level);
  if (n < 0) throw new Error(`unknown access level ${JSON.stringify(level)}; use ${LEVELS.join(", ")}`);
  return n + 1;
}

const named = (n: number): Level | null => (n >= READ ? LEVELS[n - 1]! : null);

function checkKind(kind: string): void {
  if (typeof kind !== "string" || !KIND.test(kind) || ROOTS.includes(kind)) {
    throw new Error(`access kind ${JSON.stringify(kind)} must be lowercase letters, digits, - and _, and not "user" or "organization"`);
  }
}

function checkId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error(`access id ${JSON.stringify(id)} must be 1 to 200 characters`);
}

const notFound = () => new EndpointError(404, "not found");

export function shareMessage(notice: ShareNotice, appName: string, origin: string): { to: string; subject: string; text: string } {
  const who = notice.sharedBy || "Someone";
  const url = new URL(notice.path, origin).toString();
  return {
    to: notice.to,
    subject: notice.subject ?? `${who} shared something with you on ${appName}`,
    text: `${notice.text ?? `${who} gave you ${notice.level} access on ${appName}.`}\n\n${url}\n`,
  };
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Who {
  userId: string | null;
  linkHash: string | null;
}

// The caller's level on one item, 0 for none, as a scalar subquery. It walks up the chain to the
// user or organization at the top, stops counting grants and links above the first restricted
// item, and gives nothing at all to a chain that never reaches a user or organization that exists.
function levelSql(kind: SQL, id: SQL, who: Who): SQL {
  return sql`(
    with recursive chain as (
      select i.kind, i.id, i.parent_kind, i.parent_id, i.restricted, 0 as depth
      from access_item i where i.kind = ${kind} and i.id = ${id}
      union all
      select p.kind, p.id, p.parent_kind, p.parent_id, p.restricted, c.depth + 1
      from chain c join access_item p on p.kind = c.parent_kind and p.id = c.parent_id
      where c.depth < ${MAX_DEPTH - 1}
    ),
    root as (
      select parent_kind as kind, parent_id as id from chain
      where (parent_kind = 'user' and exists (select 1 from "user" u where u.id::text = parent_id))
         or (parent_kind = 'organization' and exists (select 1 from organization o where o.id::text = parent_id))
    ),
    cut as (select min(depth) as depth from chain where restricted),
    reach as (select chain.kind, chain.id from chain, cut where cut.depth is null or chain.depth <= cut.depth),
    me as (select ${who.userId}::uuid as id),
    levels as (
      select ${MANAGE} as level from root, me where root.kind = 'user' and root.id = me.id::text
      union all
      select case btrim(roles.name)
          when 'owner' then ${MANAGE}
          when 'admin' then ${DELETE}
          when 'member' then (select case when cut.depth is null then ${READ} else 0 end from cut)
          else 0 end
      from root
      join member m on root.kind = 'organization' and m.organization_id::text = root.id
      join me on m.user_id = me.id
      cross join lateral unnest(string_to_array(m.role, ',')) as roles(name)
      union all
      select g.level from access_grant g join reach on g.item_kind = reach.kind and g.item_id = reach.id, me
      where g.user_id = me.id
        or g.team_id in (select tm.team_id from team_member tm where tm.user_id = me.id)
        or g.organization_id in (select mm.organization_id from member mm where mm.user_id = me.id)
        or g.email = (select lower(u.email) from "user" u where u.id = me.id and u.email_verified)
      union all
      select l.level from access_link l join reach on l.item_kind = reach.kind and l.item_id = reach.id
      where l.token_hash = ${who.linkHash} and (l.expires_at is null or l.expires_at > now())
    )
    select case when exists (select 1 from root) then coalesce(max(level), 0) else 0 end from levels
  )`;
}

const rows = async <T>(db: Db, query: SQL): Promise<T[]> => (await db.execute(query)).rows as T[];

function granteeColumns(to: Grantee): { user: string | null; team: string | null; organization: string | null; email: string | null } {
  const keys = Object.keys(to ?? {});
  if (keys.length !== 1 || !["user", "team", "organization", "email"].includes(keys[0]!)) {
    throw new Error("share with exactly one of { user }, { team }, { organization } or { email }");
  }
  const value = Object.values(to)[0];
  if (typeof value !== "string" || value.trim() === "") throw new Error("a grantee needs a non-empty id or email");
  return {
    user: "user" in to ? to.user : null,
    team: "team" in to ? to.team : null,
    organization: "organization" in to ? to.organization : null,
    email: "email" in to ? to.email.trim().toLowerCase() : null,
  };
}

function grantee(row: { user_id: string | null; team_id: string | null; organization_id: string | null; email: string | null }): Grantee {
  if (row.user_id) return { user: row.user_id };
  if (row.team_id) return { team: row.team_id };
  if (row.organization_id) return { organization: row.organization_id };
  return { email: row.email! };
}

// Postgres refuses a grant to a user, team or organization that does not exist, or whose id is not
// a UUID at all; both look like any other missing thing.
async function missingAsNotFound<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    if (code === "23503" || code === "22P02") throw notFound();
    throw error;
  }
}

export function createAccess(db: Db, caller: () => Promise<Caller>, notify?: (notice: ShareNotice) => Promise<void>): Access {
  let who: Promise<Who> | undefined;
  const me = () =>
    (who ??= caller().then(async ({ userId, link }) => ({ userId, linkHash: link ? await hashToken(link) : null })));

  async function levelOf(on: Db, kind: string, id: string): Promise<number> {
    checkKind(kind);
    checkId(id);
    const [row] = await rows<{ level: number }>(on, sql`select ${levelSql(sql`${kind}`, sql`${id}`, await me())} as level`);
    const level = Number(row?.level ?? 0);
    if (level === 0) await reportTooDeep(on, kind, id);
    return level;
  }

  // A chain longer than place allows can only come from writing the tables directly; it is
  // refused like any other, and logged, since it means a bug.
  async function reportTooDeep(on: Db, kind: string, id: string): Promise<void> {
    const [up] = await rows<{ depth: number }>(on, chainUp(kind, id, MAX_DEPTH + 1));
    if (up && Number(up.depth) >= MAX_DEPTH) console.error(`access: ${kind} ${id} sits more than ${MAX_DEPTH} items deep; refused`);
  }

  async function need(on: Db, kind: string, id: string, level: number): Promise<void> {
    if ((await levelOf(on, kind, id)) < level) throw notFound();
  }

  // The level the top of the tree gives: a user over their own items, a role over an organization's.
  async function topLevel(on: Db, kind: string, id: string): Promise<number> {
    const { userId } = await me();
    if (!userId) return 0;
    if (kind === "user") return id === userId ? MANAGE : 0;
    const [row] = await rows<{ level: number }>(
      on,
      sql`select coalesce(max(case btrim(roles.name) when 'owner' then ${MANAGE} when 'admin' then ${DELETE} when 'member' then ${READ} else 0 end), 0) as level
          from member m cross join lateral unnest(string_to_array(m.role, ',')) as roles(name)
          where m.organization_id::text = ${id} and m.user_id = ${userId}::uuid`,
    );
    return Number(row?.level ?? 0);
  }

  async function place(on: Db, kind: string, id: string, parentKind: string, parentId: string): Promise<void> {
    checkKind(kind);
    checkId(id);
    checkId(parentId);
    await on.transaction(async (raw) => {
      const tx = raw as unknown as Db;
      // One move at a time per database, so two moves can never pass each other's loop check.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('@celsoft/platform access place'))`);
      const [existing] = await rows(tx, sql`select 1 from access_item where kind = ${kind} and id = ${id}`);
      if (existing) await need(tx, kind, id, WRITE);

      let above = 0;
      if (ROOTS.includes(parentKind)) {
        if ((await topLevel(tx, parentKind, parentId)) < CREATE) throw notFound();
      } else {
        await need(tx, parentKind, parentId, CREATE);
        const [up] = await rows<{ within: boolean; depth: number }>(
          tx,
          sql`${chainUp(parentKind, parentId, MAX_DEPTH)}, (select exists (select 1 from up where kind = ${kind} and id = ${id})) as within`,
        );
        if (up?.within) throw new EndpointError(409, "an item cannot be placed inside itself");
        above = Number(up?.depth ?? 0) + 1;
      }
      const [down] = await rows<{ height: number }>(
        tx,
        sql`with recursive down as (
              select kind, id, 1 as depth from access_item where parent_kind = ${kind} and parent_id = ${id}
              union all
              select c.kind, c.id, d.depth + 1 from down d join access_item c on c.parent_kind = d.kind and c.parent_id = d.id
              where d.depth < ${MAX_DEPTH}
            )
            select coalesce(max(depth), 0) as height from down`,
      );
      if (above + 1 + Number(down?.height ?? 0) > MAX_DEPTH) throw new EndpointError(409, `items can sit at most ${MAX_DEPTH} deep`);

      await tx.execute(sql`
        insert into access_item (kind, id, parent_kind, parent_id) values (${kind}, ${id}, ${parentKind}, ${parentId})
        on conflict (kind, id) do update set parent_kind = excluded.parent_kind, parent_id = excluded.parent_id, updated_at = now()`);
    });
  }

  function bound(on: Db): Access {
    return {
      level: async (kind, id) => named(await levelOf(on, kind, id)),
      can: async (kind, id, level) => (await levelOf(on, kind, id)) >= rank(level),
      require: async (kind, id, level) => need(on, kind, id, rank(level)),
      place: (kind, id, parentKind, parentId) => place(on, kind, id, parentKind, parentId),

      async remove(kind, id) {
        await need(on, kind, id, DELETE);
        const [child] = await rows(on, sql`select 1 from access_item where parent_kind = ${kind} and parent_id = ${id} limit 1`);
        if (child) throw new EndpointError(409, "move or delete what is inside first");
        await on.execute(sql`delete from access_item where kind = ${kind} and id = ${id}`);
      },

      async restrict(kind, id, restricted = true) {
        await need(on, kind, id, MANAGE);
        await on.execute(sql`update access_item set restricted = ${restricted}, updated_at = now() where kind = ${kind} and id = ${id}`);
      },

      async share(kind, id, to, level, options = {}) {
        const n = rank(level);
        const g = granteeColumns(to);
        const email = options.email ?? {};
        if (email && email.path !== undefined && !/^\/(?![/\\])/.test(email.path)) throw new Error(`a sharing email's path must start with one /, such as /pages/7; got ${JSON.stringify(email.path)}`);
        await need(on, kind, id, MANAGE);
        const { userId } = await me();
        // xmax is 0 only for a row this statement inserted, so a changed grant sends no second email.
        const [row] = await missingAsNotFound(
          rows<{ inserted: boolean; recipient: string | null; shared_by: string | null }>(
            on,
            sql`
            insert into access_grant (item_kind, item_id, user_id, team_id, organization_id, email, level, granted_by)
            values (${kind}, ${id}, ${g.user}::uuid, ${g.team}::uuid, ${g.organization}::uuid, ${g.email}, ${n}, ${userId}::uuid)
            on conflict on constraint access_grant_once do update set level = excluded.level, granted_by = excluded.granted_by, updated_at = now()
            returning xmax = 0 as inserted,
              coalesce(email, (select u.email from "user" u where u.id = access_grant.user_id)) as recipient,
              (select u.name from "user" u where u.id = ${userId}::uuid) as shared_by`,
          ),
        );
        if (!notify || email === false || !row?.inserted || !row.recipient) return;
        await notify({ to: row.recipient, sharedBy: row.shared_by, level, path: email.path ?? "/", subject: email.subject, text: email.text });
      },

      async revoke(kind, id, to) {
        const g = granteeColumns(to);
        await need(on, kind, id, MANAGE);
        await on.execute(sql`
          delete from access_grant where item_kind = ${kind} and item_id = ${id}
            and user_id is not distinct from ${g.user}::uuid and team_id is not distinct from ${g.team}::uuid
            and organization_id is not distinct from ${g.organization}::uuid and email is not distinct from ${g.email}`);
      },

      async grants(kind, id) {
        await need(on, kind, id, MANAGE);
        const found = await rows<{ user_id: string | null; team_id: string | null; organization_id: string | null; email: string | null; level: number; granted_by: string | null }>(
          on,
          sql`select user_id, team_id, organization_id, email, level, granted_by from access_grant where item_kind = ${kind} and item_id = ${id} order by created_at, id`,
        );
        return found.map((row) => ({ to: grantee(row), level: named(Number(row.level))!, grantedBy: row.granted_by }));
      },

      async sharedWithMe(kind) {
        checkKind(kind);
        const who = await me();
        if (!who.userId) return [];
        const found = await rows<{ item_id: string }>(
          on,
          sql`select distinct g.item_id from access_grant g
              where g.item_kind = ${kind}
                and (g.user_id = ${who.userId}::uuid
                  or g.team_id in (select team_id from team_member where user_id = ${who.userId}::uuid)
                  or g.organization_id in (select organization_id from member where user_id = ${who.userId}::uuid)
                  or g.email = (select lower(email) from "user" where id = ${who.userId}::uuid and email_verified))
                and ${levelSql(sql`g.item_kind`, sql`g.item_id`, who)} >= ${READ}
              order by g.item_id`,
        );
        return found.map((row) => row.item_id);
      },

      async link(kind, id, level, options = {}) {
        const n = rank(level);
        if (n > WRITE) throw new Error(`a link can carry read, create or write, never ${level}`);
        await need(on, kind, id, MANAGE);
        const token = newToken();
        const { userId } = await me();
        const [row] = await rows<{ id: string }>(
          on,
          sql`insert into access_link (item_kind, item_id, token_hash, level, expires_at, created_by)
              values (${kind}, ${id}, ${await hashToken(token)}, ${n}, ${options.expires ?? null}, ${userId}::uuid) returning id`,
        );
        return { id: row!.id, token };
      },

      async links(kind, id) {
        await need(on, kind, id, MANAGE);
        const found = await rows<{ id: string; level: number; expires_at: Date | null }>(
          on,
          sql`select id, level, expires_at from access_link where item_kind = ${kind} and item_id = ${id} order by created_at, id`,
        );
        return found.map((row) => ({ id: row.id, level: named(Number(row.level))!, expiresAt: row.expires_at ? new Date(row.expires_at) : null }));
      },

      async revokeLink(kind, id, linkId) {
        await need(on, kind, id, MANAGE);
        await on.execute(sql`delete from access_link where item_kind = ${kind} and item_id = ${id} and id::text = ${linkId}`);
      },

      async accessible(kind, level, column) {
        checkKind(kind);
        return sql`(${levelSql(sql`${kind}`, sql`(${column})::text`, await me())} >= ${rank(level)})`;
      },

      in: (tx) => bound(tx as Db),
    };
  }

  return bound(db);
}

// The chain above an item, the item included, as `up`, with `depth` the topmost step reached.
function chainUp(kind: string, id: string, limit: number): SQL {
  return sql`with recursive up as (
      select kind, id, parent_kind, parent_id, 0 as depth from access_item where kind = ${kind} and id = ${id}
      union all
      select p.kind, p.id, p.parent_kind, p.parent_id, u.depth + 1 from up u join access_item p on p.kind = u.parent_kind and p.id = u.parent_id
      where u.depth < ${limit}
    )
    select (select max(depth) from up) as depth`;
}
