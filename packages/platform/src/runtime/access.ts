import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { EndpointError } from "./endpoint-error.js";
import { LINK_HEADER } from "./link-header.js";

export { LINK_HEADER };

// Who may do what to an app's resources, through control points; see docs/design.md, App Code,
// Access, and the cases in docs/access-rules.md. Every check is one query against the app's own
// Postgres, never cached.

export const LEVELS = ["read", "create", "write", "delete", "manage"] as const;
export type Level = (typeof LEVELS)[number];
export type Grantee = { user: string } | { team: string } | { organization: string } | { email: string } | { everyone: true };

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

export interface PointOptions {
  // An existing point this one sits under; naming it needs `create` on it.
  parent?: string;
  // Also use the parent's grants, walking up until a point that does not inherit.
  inherit?: boolean;
  // Given alongside the creator's own `manage`.
  grants?: { to: Grantee; level: Level }[];
}

// A point declared in code, applied at every start; its grants change only with a deploy.
export interface StaticPoint {
  parent?: string;
  inherit?: boolean;
  grants?: { to: Grantee; level: Level }[];
}

export interface Access {
  // The caller's level on a point, or null for none; a point that does not exist is also null.
  level(point: string): Promise<Level | null>;
  can(point: string, level: Level): Promise<boolean>;
  // The caller's level, or a 404 when it is less than `read`, so points people cannot see look missing.
  check(point: string): Promise<Level>;
  // The caller's level, or a 404 unless it is at least `level`.
  require(point: string, level: Level): Promise<Level>;
  // A dynamic point for one resource; whoever creates it gets `manage` on it.
  create(point: string, options?: PointOptions): Promise<void>;
  // A new parent, or null for none; needs `manage` on the point and `create` on the new parent.
  move(point: string, parent: string | null): Promise<void>;
  // Needs `delete`; removes the point and every point under it, with their grants and links, and
  // returns their ids, the point's own first, so the app deletes those resources too.
  remove(point: string): Promise<string[]>;
  inherit(point: string, inherits: boolean): Promise<void>;
  // A new grant to a person or an email address sends them an email; teams, organizations and
  // Everyone get none.
  grant(point: string, to: Grantee, level: Level, options?: { email?: ShareEmail }): Promise<void>;
  revoke(point: string, to: Grantee): Promise<void>;
  grants(point: string): Promise<Grant[]>;
  link(point: string, level: Level, options?: { expires?: Date }): Promise<{ id: string; token: string }>;
  links(point: string): Promise<Link[]>;
  revokeLink(point: string, linkId: string): Promise<void>;
  // A condition for the app's own query: rows whose `column` holds the id of a point the caller
  // can read, or has `level` on.
  readable(column: unknown): Promise<SQL>;
  allows(level: Level, column: unknown): Promise<SQL>;
  // The same calls inside the app's transaction, so a change and its access commit together.
  in(tx: unknown): Access;
  // The app acting as itself: every check passes and nobody is the creator. For work no user
  // asked for, never for a request's own data.
  asApp(): Access;
}

export interface Caller {
  userId: string | null;
  // A link token the request carries, as the `x-access-link` header.
  link: string | null;
}

// The longest chain from a point up through its parents, counting the point itself.
export const MAX_DEPTH = 64;

export const organizationPoint = (organizationId: string) => `organization:${organizationId}`;
export const teamPoint = (teamId: string) => `team:${teamId}`;

const RESERVED = /^(organization|team):/;
const [READ, CREATE, WRITE, DELETE, MANAGE] = [1, 2, 3, 4, 5];

type Db = Pick<NodePgDatabase<Record<string, unknown>>, "execute" | "transaction">;

export function rank(level: Level): number {
  const n = LEVELS.indexOf(level);
  if (n < 0) throw new Error(`unknown access level ${JSON.stringify(level)}; use ${LEVELS.join(", ")}`);
  return n + 1;
}

const named = (n: number): Level | null => (n >= READ ? LEVELS[n - 1]! : null);

export function checkPointId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error(`a control point id must be 1 to 200 characters; got ${JSON.stringify(id)}`);
}

const notFound = () => new EndpointError(404, "not found");
const conflict = (message: string) => new EndpointError(409, message);

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
  app: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A user id that is not a UUID can match nobody, so it is treated as no user at all.
const userParam = (userId: string | null) => (userId && UUID.test(userId) ? userId : null);

// The caller's level on one point, 0 for none, as a scalar subquery. The chain is the point and,
// while each point inherits, its parents. Each of the caller's principals (the person, by user id
// or confirmed email, each team, each organization, and Everyone) stops at its nearest grant on
// the chain, and the highest of those wins; organization and team grants count only on points of
// their own organization or none. The organization's Admins get `manage`, and a link counts only
// on the point it was made for.
function levelSql(point: SQL, who: Who): SQL {
  if (who.app) return sql`(select case when exists (select 1 from access_point where id = (${point})) then ${MANAGE} else 0 end)`;
  const userId = userParam(who.userId);
  // The point is read once, in a query with no tables of its own, so a column the app passes,
  // such as `p.id`, always means the app's row; every name inside starts with `_ac` for the same reason.
  return sql`(
    with recursive _ac_target as (select (${point}) as id),
    _ac_chain as (
      select _ac_p.id, _ac_p.parent_id, _ac_p.inherits, _ac_p.organization_id, 0 as depth
      from access_point _ac_p where _ac_p.id = (select id from _ac_target)
      union all
      select _ac_q.id, _ac_q.parent_id, _ac_q.inherits, _ac_q.organization_id, _ac_c.depth + 1
      from _ac_chain _ac_c join access_point _ac_q on _ac_q.id = _ac_c.parent_id
      where _ac_c.inherits and _ac_c.depth < ${MAX_DEPTH - 1}
    ),
    _ac_me as (select _ac_u.id, case when _ac_u.email_verified then lower(_ac_u.email) end as email from "user" _ac_u where _ac_u.id = ${userId}::uuid),
    _ac_orgs as (select _ac_m.organization_id from member _ac_m join _ac_me on _ac_m.user_id = _ac_me.id),
    _ac_teams as (
      select _ac_tm.team_id, _ac_t.admins, _ac_t.organization_id from team_member _ac_tm
      join _ac_me on _ac_tm.user_id = _ac_me.id
      join team _ac_t on _ac_t.id = _ac_tm.team_id
      join _ac_orgs on _ac_orgs.organization_id = _ac_t.organization_id
    ),
    _ac_matched as (
      select _ac_c.depth, _ac_g.level,
        case when _ac_g.user_id is not null or _ac_g.email is not null then 'person'
             when _ac_g.team_id is not null then 'team ' || _ac_g.team_id
             when _ac_g.organization_id is not null then 'organization ' || _ac_g.organization_id
             else 'everyone' end as principal
      from _ac_chain _ac_c join access_grant _ac_g on _ac_g.point_id = _ac_c.id
      where _ac_g.everyone
         or _ac_g.user_id = (select id from _ac_me)
         or _ac_g.email = (select email from _ac_me)
         or (_ac_g.organization_id in (select organization_id from _ac_orgs) and (_ac_c.organization_id is null or _ac_c.organization_id = _ac_g.organization_id))
         or exists (select 1 from _ac_teams _ac_x where _ac_x.team_id = _ac_g.team_id and (_ac_c.organization_id is null or _ac_c.organization_id = _ac_x.organization_id))
    ),
    _ac_nearest as (select distinct on (principal) level from _ac_matched order by principal, depth, level desc),
    _ac_levels as (
      select level from _ac_nearest
      union all
      select ${MANAGE} from _ac_chain _ac_c join _ac_teams _ac_x on _ac_x.admins and _ac_x.organization_id = _ac_c.organization_id where _ac_c.depth = 0
      union all
      select _ac_l.level from access_link _ac_l
      where _ac_l.point_id = (select id from _ac_target) and _ac_l.token_hash = ${who.linkHash} and (_ac_l.expires_at is null or _ac_l.expires_at > now())
    )
    select coalesce(max(level), 0) from _ac_levels
  )`;
}

const rows = async <T>(db: Db, query: SQL): Promise<T[]> => (await db.execute(query)).rows as T[];

interface GranteeColumns {
  user: string | null;
  team: string | null;
  organization: string | null;
  everyone: true | null;
  email: string | null;
}

function granteeColumns(to: Grantee): GranteeColumns {
  const keys = Object.keys(to ?? {});
  if (keys.length !== 1 || !["user", "team", "organization", "email", "everyone"].includes(keys[0]!)) {
    throw new Error("grant to exactly one of { user }, { team }, { organization }, { email } or { everyone: true }");
  }
  if ("everyone" in to) {
    if (to.everyone !== true) throw new Error("a grant to Everyone is { everyone: true }");
    return { user: null, team: null, organization: null, everyone: true, email: null };
  }
  const value = Object.values(to)[0];
  if (typeof value !== "string" || value.trim() === "") throw new Error("a grantee needs a non-empty id or email");
  return {
    user: "user" in to ? to.user : null,
    team: "team" in to ? to.team : null,
    organization: "organization" in to ? to.organization : null,
    everyone: null,
    email: "email" in to ? to.email.trim().toLowerCase() : null,
  };
}

function grantee(row: { user_id: string | null; team_id: string | null; organization_id: string | null; everyone: boolean | null; email: string | null }): Grantee {
  if (row.user_id) return { user: row.user_id };
  if (row.team_id) return { team: row.team_id };
  if (row.organization_id) return { organization: row.organization_id };
  if (row.everyone) return { everyone: true };
  return { email: row.email! };
}

const pgCode = (error: unknown) => (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;

// Postgres refuses a grant to a user, team or organization that does not exist, or whose id is not
// a UUID at all; both look like any other missing thing.
async function missingAsNotFound<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    const code = pgCode(error);
    if (code === "23503" || code === "22P02") throw notFound();
    throw error;
  }
}

interface PointRow {
  id: string;
  parent_id: string | null;
  organization_id: string | null;
  for_organization: string | null;
  for_team: string | null;
  static: boolean;
}

const pointRow = async (on: Db, id: string): Promise<PointRow | undefined> =>
  (await rows<PointRow>(on, sql`select id, parent_id, organization_id, for_organization, for_team, static from access_point where id = ${id}`))[0];

// One structural change at a time per database, so two moves can never pass each other's loop check.
const lockTree = (tx: Db) => tx.execute(sql`select pg_advisory_xact_lock(hashtext('@celsoft/platform access tree'))`);

// The number of points from this one to the top, counting itself.
async function depthOf(on: Db, id: string): Promise<number> {
  const [row] = await rows<{ depth: number }>(
    on,
    sql`with recursive up as (
          select id, parent_id, 1 as depth from access_point where id = ${id}
          union all
          select p.id, p.parent_id, u.depth + 1 from up u join access_point p on p.id = u.parent_id where u.depth <= ${MAX_DEPTH}
        )
        select coalesce(max(depth), 0) as depth from up`,
  );
  return Number(row?.depth ?? 0);
}

// Every point under this one and itself, the point first, as far down as MAX_DEPTH allows.
async function subtree(on: Db, id: string): Promise<{ id: string; depth: number }[]> {
  return rows<{ id: string; depth: number }>(
    on,
    sql`with recursive down as (
          select id, 0 as depth from access_point where id = ${id}
          union all
          select c.id, d.depth + 1 from down d join access_point c on c.parent_id = d.id where d.depth < ${MAX_DEPTH}
        )
        select id, depth from down order by depth, id`,
  );
}

// Organization and team grants under an organization must belong to it; `organizationId` null
// means the points sit under no organization, where any principal may be granted.
async function foreignGrant(on: Db, ids: string[], organizationId: string | null): Promise<boolean> {
  if (organizationId === null || ids.length === 0) return false;
  const [row] = await rows<{ foreign: boolean }>(
    on,
    sql`select exists (
          select 1 from access_grant g left join team t on t.id = g.team_id
          where g.point_id in ${ids}
            and ((g.organization_id is not null and g.organization_id <> ${organizationId}::uuid)
              or (g.team_id is not null and t.organization_id <> ${organizationId}::uuid))
        ) as foreign`,
  );
  return Boolean(row?.foreign);
}

// Refuses an organization or team grant from another organization on a point under one.
async function checkSameOrganization(on: Db, point: PointRow, g: GranteeColumns): Promise<void> {
  if (!point.organization_id) return;
  if (g.organization && g.organization !== point.organization_id) throw conflict("a point under an organization can be granted only to that organization, its teams, people and Everyone");
  if (g.team) {
    const [team] = await missingAsNotFound(rows<{ organization_id: string }>(on, sql`select organization_id from team where id = ${g.team}::uuid`));
    if (!team) throw notFound();
    if (team.organization_id !== point.organization_id) throw conflict("a point under an organization can be granted only to that organization, its teams, people and Everyone");
  }
}

export interface AccessOptions {
  // Announces a new grant to a person, after the answer.
  notify?: (notice: ShareNotice) => Promise<void>;
  // Waited for before the first call, such as applying the app's static points.
  ready?: () => Promise<void>;
}

export function createAccess(db: Db, caller: () => Promise<Caller>, options: AccessOptions = {}): Access {
  const { notify, ready } = options;
  let human: Promise<Who> | undefined;
  const person = () =>
    (human ??= Promise.all([caller(), ready?.()]).then(async ([{ userId, link }]) => ({ userId, linkHash: link ? await hashToken(link) : null, app: false })));
  const asApp: () => Promise<Who> = async () => (await ready?.(), { userId: null, linkHash: null, app: true });

  function bound(on: Db, me: () => Promise<Who>): Access {
    async function levelOf(at: Db, point: string): Promise<number> {
      checkPointId(point);
      const [row] = await rows<{ level: number }>(at, sql`select ${levelSql(sql`${point}`, await me())} as level`);
      return Number(row?.level ?? 0);
    }

    async function need(at: Db, point: string, level: number): Promise<number> {
      const has = await levelOf(at, point);
      if (has < level) throw notFound();
      return has;
    }

    // A point the caller has `level` on, refusing changes to static points, whose grants change
    // only with a deploy, and to the points the platform keeps for organizations and teams where
    // `structural` is set.
    async function changeable(at: Db, point: string, level: number, structural = false): Promise<PointRow> {
      await need(at, point, level);
      const row = (await pointRow(at, point))!;
      if (row.static) throw conflict("a static point changes only in code, with a deploy");
      if (structural && (row.for_organization || row.for_team)) throw conflict("an organization's or team's point changes only through the organization");
      return row;
    }

    async function signedIn(): Promise<Who> {
      const who = await me();
      if (!who.app && !userParam(who.userId)) throw new EndpointError(401, "sign in first");
      return who;
    }

    async function insertGrant(at: Db, point: string, g: GranteeColumns, n: number, grantedBy: string | null) {
      return missingAsNotFound(
        rows<{ inserted: boolean; recipient: string | null; shared_by: string | null }>(
          at,
          // xmax is 0 only for a row this statement inserted, so a changed grant sends no second email.
          sql`
          insert into access_grant (point_id, user_id, team_id, organization_id, everyone, email, level, granted_by)
          values (${point}, ${g.user}::uuid, ${g.team}::uuid, ${g.organization}::uuid, ${g.everyone}, ${g.email}, ${n}, ${grantedBy}::uuid)
          on conflict on constraint access_grant_once do update set level = excluded.level, granted_by = excluded.granted_by, updated_at = now()
          returning xmax = 0 as inserted,
            coalesce(email, (select u.email from "user" u where u.id = access_grant.user_id)) as recipient,
            (select u.name from "user" u where u.id = ${grantedBy}::uuid) as shared_by`,
        ),
      );
    }

    function checkGrant(to: Grantee, level: Level): { g: GranteeColumns; n: number } {
      const n = rank(level);
      const g = granteeColumns(to);
      if (g.everyone && n !== READ) throw new Error(`Everyone can be granted read only, never ${level}`);
      return { g, n };
    }

    return {
      level: async (point) => named(await levelOf(on, point)),
      can: async (point, level) => (await levelOf(on, point)) >= rank(level),
      check: async (point) => named(await need(on, point, READ))!,
      require: async (point, level) => named(await need(on, point, rank(level)))!,

      async create(point, options = {}) {
        checkPointId(point);
        if (RESERVED.test(point)) throw new Error(`control point ids starting organization: or team: belong to the platform; got ${JSON.stringify(point)}`);
        const grants = (options.grants ?? []).map(({ to, level }) => checkGrant(to, level));
        const who = await signedIn();
        await on.transaction(async (raw) => {
          const tx = raw as unknown as Db;
          await lockTree(tx);
          let organizationId: string | null = null;
          if (options.parent !== undefined) {
            await need(tx, options.parent, CREATE);
            const parent = (await pointRow(tx, options.parent))!;
            if ((await depthOf(tx, options.parent)) >= MAX_DEPTH) throw conflict(`points can sit at most ${MAX_DEPTH} deep`);
            organizationId = parent.organization_id;
          }
          const creator = userParam(who.userId);
          try {
            await tx.execute(sql`
              insert into access_point (id, parent_id, organization_id, inherits, created_by)
              values (${point}, ${options.parent ?? null}, ${organizationId}::uuid, ${options.inherit ?? false}, ${creator}::uuid)`);
          } catch (error) {
            if (pgCode(error) === "23505") throw conflict("that control point already exists");
            throw error;
          }
          const row = (await pointRow(tx, point))!;
          for (const { g } of grants) await checkSameOrganization(tx, row, g);
          if (creator) await insertGrant(tx, point, { user: creator, team: null, organization: null, everyone: null, email: null }, MANAGE, creator);
          for (const { g, n } of grants) await insertGrant(tx, point, g, n, creator);
        });
      },

      async move(point, parent) {
        checkPointId(point);
        if (parent !== null) checkPointId(parent);
        await on.transaction(async (raw) => {
          const tx = raw as unknown as Db;
          await lockTree(tx);
          await changeable(tx, point, MANAGE, true);
          let organizationId: string | null = null;
          let above = 0;
          if (parent !== null) {
            await need(tx, parent, CREATE);
            organizationId = (await pointRow(tx, parent))!.organization_id;
            above = await depthOf(tx, parent);
          }
          const below = await subtree(tx, point);
          const ids = below.map((p) => p.id);
          if (parent !== null && ids.includes(parent)) throw conflict("a point cannot sit under itself");
          const height = Math.max(...below.map((p) => Number(p.depth))) + 1;
          if (above + height > MAX_DEPTH) throw conflict(`points can sit at most ${MAX_DEPTH} deep`);
          if (await foreignGrant(tx, ids, organizationId)) throw conflict("points under an organization can be granted only to its own teams and itself; revoke the other organization's grants first");
          await tx.execute(sql`update access_point set parent_id = ${parent}, updated_at = now() where id = ${point}`);
          await tx.execute(sql`update access_point set organization_id = ${organizationId}::uuid, updated_at = now() where id in ${ids}`);
        });
      },

      async remove(point) {
        checkPointId(point);
        return on.transaction(async (raw) => {
          const tx = raw as unknown as Db;
          await lockTree(tx);
          await changeable(tx, point, DELETE, true);
          const ids = (await subtree(tx, point)).map((p) => p.id);
          await tx.execute(sql`delete from access_point where id in ${ids}`);
          return ids;
        });
      },

      async inherit(point, inherits) {
        await changeable(on, point, MANAGE);
        await on.execute(sql`update access_point set inherits = ${inherits}, updated_at = now() where id = ${point}`);
      },

      async grant(point, to, level, options = {}) {
        const { g, n } = checkGrant(to, level);
        const email = options.email ?? {};
        if (email && email.path !== undefined && !/^\/(?![/\\])/.test(email.path)) throw new Error(`a sharing email's path must start with one /, such as /pages/7; got ${JSON.stringify(email.path)}`);
        const row = await changeable(on, point, MANAGE);
        await checkSameOrganization(on, row, g);
        const { userId } = await me();
        const [inserted] = await insertGrant(on, point, g, n, userParam(userId));
        if (!notify || email === false || !inserted?.inserted || !inserted.recipient || !(g.user || g.email)) return;
        await notify({ to: inserted.recipient, sharedBy: inserted.shared_by, level, path: email.path ?? "/", subject: email.subject, text: email.text });
      },

      async revoke(point, to) {
        const g = granteeColumns(to);
        await changeable(on, point, MANAGE);
        await missingAsNotFound(
          on.execute(sql`
            delete from access_grant where point_id = ${point}
              and user_id is not distinct from ${g.user}::uuid and team_id is not distinct from ${g.team}::uuid
              and organization_id is not distinct from ${g.organization}::uuid and everyone is not distinct from ${g.everyone}
              and email is not distinct from ${g.email}`),
        );
      },

      async grants(point) {
        await need(on, point, MANAGE);
        const found = await rows<{ user_id: string | null; team_id: string | null; organization_id: string | null; everyone: boolean | null; email: string | null; level: number; granted_by: string | null }>(
          on,
          sql`select user_id, team_id, organization_id, everyone, email, level, granted_by from access_grant where point_id = ${point} order by created_at, id`,
        );
        return found.map((row) => ({ to: grantee(row), level: named(Number(row.level))!, grantedBy: row.granted_by }));
      },

      async link(point, level, options = {}) {
        const n = rank(level);
        if (n > WRITE) throw new Error(`a link can carry read, create or write, never ${level}`);
        if (options.expires !== undefined && !(options.expires instanceof Date && !Number.isNaN(options.expires.getTime()))) throw new Error("a link's expires must be a valid Date");
        await changeable(on, point, MANAGE);
        const token = newToken();
        const { userId } = await me();
        const [row] = await rows<{ id: string }>(
          on,
          sql`insert into access_link (point_id, token_hash, level, expires_at, created_by)
              values (${point}, ${await hashToken(token)}, ${n}, ${options.expires ?? null}, ${userParam(userId)}::uuid) returning id`,
        );
        return { id: row!.id, token };
      },

      async links(point) {
        await need(on, point, MANAGE);
        const found = await rows<{ id: string; level: number; expires_at: Date | null }>(
          on,
          sql`select id, level, expires_at from access_link where point_id = ${point} order by created_at, id`,
        );
        return found.map((row) => ({ id: row.id, level: named(Number(row.level))!, expiresAt: row.expires_at ? new Date(row.expires_at) : null }));
      },

      async revokeLink(point, linkId) {
        await need(on, point, MANAGE);
        await on.execute(sql`delete from access_link where point_id = ${point} and id::text = ${String(linkId)}`);
      },

      readable: async (column) => sql`(${levelSql(sql`(${column})::text`, await me())} >= ${READ})`,
      allows: async (level, column) => sql`(${levelSql(sql`(${column})::text`, await me())} >= ${rank(level)})`,

      in: (tx) => bound(tx as Db, me),
      asApp: () => bound(on, asApp),
    };
  }

  return bound(db, person);
}

// Writes the app's static points, as declared in code: each is created or updated, and its grants
// replaced. Points no longer declared are left alone. Run once per Worker start, before any check.
export async function applyStaticPoints(db: Db, points: Record<string, StaticPoint>): Promise<void> {
  const names = Object.keys(points);
  if (names.length === 0) return;
  for (const name of names) {
    checkPointId(name);
    if (RESERVED.test(name)) throw new Error(`static point ${JSON.stringify(name)} uses a prefix that belongs to the platform`);
    const parent = points[name]!.parent;
    if (parent !== undefined && !(parent in points)) throw new Error(`static point ${name}'s parent ${JSON.stringify(parent)} is not a static point`);
  }
  // Parents first, refusing a loop among them.
  const order: string[] = [];
  const visiting = new Set<string>();
  const visit = (name: string) => {
    if (order.includes(name)) return;
    if (visiting.has(name)) throw new Error(`static points ${[...visiting].join(", ")} sit under each other`);
    visiting.add(name);
    const parent = points[name]!.parent;
    if (parent !== undefined) visit(parent);
    visiting.delete(name);
    order.push(name);
  };
  names.forEach(visit);
  const depth = (name: string): number => (points[name]!.parent ? 1 + depth(points[name]!.parent!) : 1);
  if (names.some((n) => depth(n) > MAX_DEPTH)) throw new Error(`static points can sit at most ${MAX_DEPTH} deep`);

  await db.transaction(async (raw) => {
    const tx = raw as unknown as Db;
    await lockTree(tx);
    for (const name of order) {
      const point = points[name]!;
      const grants = (point.grants ?? []).map(({ to, level }) => {
        const n = rank(level);
        const g = granteeColumns(to);
        if (g.everyone && n !== READ) throw new Error(`static point ${name}: Everyone can be granted read only`);
        return { g, n };
      });
      const [existing] = await rows<{ static: boolean }>(tx, sql`select static from access_point where id = ${name}`);
      if (existing && !existing.static) throw new Error(`static point ${JSON.stringify(name)} has the id of a point the app created at runtime`);
      await tx.execute(sql`
        insert into access_point (id, parent_id, inherits, static) values (${name}, ${point.parent ?? null}, ${point.inherit ?? false}, true)
        on conflict (id) do update set parent_id = excluded.parent_id, inherits = excluded.inherits, updated_at = now()`);
      await tx.execute(sql`delete from access_grant where point_id = ${name}`);
      for (const { g, n } of grants) {
        await tx.execute(sql`
          insert into access_grant (point_id, user_id, team_id, organization_id, everyone, email, level)
          values (${name}, ${g.user}::uuid, ${g.team}::uuid, ${g.organization}::uuid, ${g.everyone}, ${g.email}, ${n})`);
      }
    }
  });
}
