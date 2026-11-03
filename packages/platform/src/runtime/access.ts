import { conflict, notFound, rows, UUID, type Db } from "./shared.js";
import { sql, type SQL } from "drizzle-orm";
import type { Mail } from "./email.js";
import { EndpointError } from "./endpoint-error.js";
import { LINK_HEADER } from "./link-header.js";

export { LINK_HEADER };

// Who may do what to an app's resources, through control points; see docs/design.md, App Code,
// Access, and the cases in docs/access-rules.md. Every check is one query against the app's own
// Postgres, never cached.

export const LEVELS = ["read", "create", "write", "delete", "manage"] as const;
export type Level = (typeof LEVELS)[number];
export type Grantee = { user: string } | { team: string } | { organization: string } | { email: string } | { everyone: true } | { owner: true };

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
  label: string | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export const MAX_LABEL = 100;

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

export interface PointInfo {
  id: string;
  parent: string | null;
  inherits: boolean;
  static: boolean;
  organizationId: string | null;
}

export interface Access {
  // A point's own settings, for callers with `read`; a 404 otherwise.
  point(point: string): Promise<PointInfo>;
  // The caller's level on a point, or null for none; a point that does not exist is also null.
  level(point: string): Promise<Level | null>;
  can(point: string, level: Level): Promise<boolean>;
  // The caller's level, or a 404 when it is less than `read`, so points people cannot see look missing.
  check(point: string): Promise<Level>;
  // The caller's level, or a 404 unless it is at least `level`. Given a list, it checks the first
  // point that exists, and only that one, so a refused point never falls through to the next.
  require(point: string | readonly string[], level: Level): Promise<Level>;
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
  link(point: string, level: Level, options?: { expires?: Date; label?: string }): Promise<{ id: string; token: string }>;
  links(point: string): Promise<Link[]>;
  revokeLink(point: string, linkId: string): Promise<void>;
  // A condition for the app's own query: rows whose `column` holds the id of a point the caller
  // can read, or has `level` on.
  readable(column: unknown): Promise<SQL>;
  allows(level: Level, column: unknown): Promise<SQL>;
  // The entries the caller has `level` on, in their order, in one query. An entry is an id, or a list
  // whose first existing point is checked, as in require; an entry with no existing point is left out.
  filter<T extends string | readonly string[]>(points: readonly T[], level: Level): Promise<T[]>;
  // The ids starting with `prefix` the caller can read, sorted; the prefix is taken literally.
  points(options?: { prefix?: string }): Promise<string[]>;
  // The same calls inside the app's transaction, so a change and its access commit together.
  in(tx: unknown): Access;
  // The app acting as itself: every check passes and nobody is the creator. For work no user
  // asked for, never for a request's own data.
  asApp(): Access;
  // Anyone signed out with no link: only Everyone's grants count, so its answers are the same for
  // every visitor; the one part of app.access a page handler may use. It only reads.
  asEveryone(): Access;
}

export interface Caller {
  userId: string | null;
  // The link tokens the request carries: the `x-access-link` header and the link cookies.
  link: string | readonly string[] | null;
  // The highest level an API token may use, when the caller is one; every check gives at most this.
  cap?: Level | null;
}

// The longest chain from a point up through its parents, counting the point itself.
export const MAX_DEPTH = 64;

export const organizationPoint = (organizationId: string) => `organization:${organizationId}`;
export const teamPoint = (teamId: string) => `team:${teamId}`;

const RESERVED = /^(organization|team):/;
export const [READ, CREATE, WRITE, DELETE, MANAGE] = [1, 2, 3, 4, 5];


export function rank(level: Level): number {
  const n = LEVELS.indexOf(level);
  if (n < 0) throw new Error(`unknown access level ${JSON.stringify(level)}; use ${LEVELS.join(", ")}`);
  return n + 1;
}

const named = (n: number): Level | null => (n >= READ ? LEVELS[n - 1]! : null);

export function checkPointId(id: unknown): asserts id is string {
  if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new Error(`a control point id must be 1 to 200 characters; got ${JSON.stringify(id)}`);
}


export function shareMessage(notice: ShareNotice, appName: string, origin: string): { to: string; subject: string; text: string } {
  const who = notice.sharedBy || "Someone";
  const url = new URL(notice.path, origin).toString();
  return {
    to: notice.to,
    subject: notice.subject ?? `${who} shared something with you on ${appName}`,
    text: `${notice.text ?? `${who} gave you ${notice.level} access on ${appName}.`}\n\n${url}\n`,
  };
}

// At most this many link tokens count on one request, so a pile of cookies cannot slow every check.
export const MAX_LINKS = 20;

function linkTokens(link: Caller["link"]): string[] {
  const all = link === null ? [] : typeof link === "string" ? [link] : [...link];
  return [...new Set(all.filter((t) => typeof t === "string" && t.length > 0 && t.length <= 200))].slice(0, MAX_LINKS);
}

// The point a link token opens and when it stops, or null for a token that is unknown or expired.
export async function linkTarget(db: Db, token: string): Promise<{ point: string; expires: Date | null } | null> {
  if (token.length === 0 || token.length > 200) return null;
  const [row] = await rows<{ point_id: string; expires_at: Date | string | null }>(
    db,
    sql`select point_id, expires_at from access_link where token_hash = ${await hashToken(token)} and (expires_at is null or expires_at > now())`,
  );
  return row ? { point: row.point_id, expires: row.expires_at === null ? null : new Date(row.expires_at) } : null;
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
  linkHashes: string[];
  app: boolean;
  cap: number | null;
}

// A user id that is not a UUID can match nobody, so it is treated as no user at all.
const userParam = (userId: string | null) => (userId && UUID.test(userId) ? userId : null);

// The caller's level on one point, 0 for none, as an expression any query can use: a call of
// platform_access_level, which access-sql.ts installs and which holds the rules.
function levelSql(point: SQL, who: Who): SQL {
  const level = uncappedLevelSql(point, who);
  return who.cap === null ? level : sql`least(${level}, ${who.cap})`;
}

function uncappedLevelSql(point: SQL, who: Who): SQL {
  if (who.app) return sql`(select case when exists (select 1 from access_point where id = (${point})) then ${MANAGE} else 0 end)`;
  const userId = userParam(who.userId);
  if (!userId && who.linkHashes.length === 0) {
    // Signed out with no link: only Everyone's grants can count, so no principal is looked up.
    return sql`platform_access_level((${point})::text, null, null, '{}', '{}', '{}', '{}')`;
  }
  // The caller's principals are subqueries that never read the point, so Postgres works each out
  // once per statement, however many rows a list filter checks; platform_access_level does the rest.
  const memberTeams = (admins: boolean) => sql`
    from team_member _ac_tm
    join team _ac_t on _ac_t.id = _ac_tm.team_id ${admins ? sql`and _ac_t.admins` : sql``}
    join member _ac_m on _ac_m.organization_id = _ac_t.organization_id and _ac_m.user_id = _ac_tm.user_id
    where _ac_tm.user_id = ${userId}::uuid`;
  return sql`platform_access_level(
    (${point})::text,
    ${userId}::uuid,
    (select case when _ac_u.email_verified then lower(_ac_u.email) end from "user" _ac_u where _ac_u.id = ${userId}::uuid),
    array(select _ac_m.organization_id from member _ac_m where _ac_m.user_id = ${userId}::uuid),
    array(select _ac_tm.team_id ${memberTeams(false)}),
    array(select _ac_t.organization_id ${memberTeams(true)}),
    ${`{${who.linkHashes.join(",")}}`}::text[]
  )`;
}


interface GranteeColumns {
  user: string | null;
  team: string | null;
  organization: string | null;
  everyone: true | null;
  owner: true | null;
  email: string | null;
}

function granteeColumns(to: Grantee): GranteeColumns {
  const keys = Object.keys(to ?? {});
  if (keys.length !== 1 || !["user", "team", "organization", "email", "everyone", "owner"].includes(keys[0]!)) {
    throw new Error("grant to exactly one of { user }, { team }, { organization }, { email }, { everyone: true } or { owner: true }");
  }
  if ("everyone" in to) {
    if (to.everyone !== true) throw new Error("a grant to Everyone is { everyone: true }");
    return { user: null, team: null, organization: null, everyone: true, owner: null, email: null };
  }
  if ("owner" in to) {
    if (to.owner !== true) throw new Error("a grant to the owner is { owner: true }");
    return { user: null, team: null, organization: null, everyone: null, owner: true, email: null };
  }
  const value = Object.values(to)[0];
  if (typeof value !== "string" || value.trim() === "") throw new Error("a grantee needs a non-empty id or email");
  return {
    user: "user" in to ? to.user : null,
    team: "team" in to ? to.team : null,
    organization: "organization" in to ? to.organization : null,
    everyone: null,
    owner: null,
    email: "email" in to ? to.email.trim().toLowerCase() : null,
  };
}

function grantee(row: { user_id: string | null; team_id: string | null; organization_id: string | null; everyone: boolean | null; owner: boolean | null; email: string | null }): Grantee {
  if (row.user_id) return { user: row.user_id };
  if (row.team_id) return { team: row.team_id };
  if (row.organization_id) return { organization: row.organization_id };
  if (row.everyone) return { everyone: true };
  if (row.owner) return { owner: true };
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
  inherits: boolean;
  static: boolean;
}

const pointRow = async (on: Db, id: string): Promise<PointRow | undefined> =>
  (await rows<PointRow>(on, sql`select id, parent_id, organization_id, for_organization, for_team, inherits, static from access_point where id = ${id}`))[0];

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
  // Emails a person a new grant gives access, after the answer.
  mail?: Mail;
  // The caller's levels already found in this request, by point; any change to access clears it.
  // Pass one to clear it from outside, as organization changes do.
  memo?: Map<string, number>;
}

// Runs a write with the request's remembered levels forgotten before and after it, since it can
// change any of them; shared by every module whose writes change who may do what.
export async function forgetting<T>(memo: Map<string, number> | undefined, write: () => Promise<T>): Promise<T> {
  memo?.clear();
  try {
    return await write();
  } finally {
    memo?.clear();
  }
}

// The calls that change access, after which no level found earlier can be trusted.
const WRITES = ["create", "move", "remove", "inherit", "grant", "revoke", "link", "revokeLink"] as const;

export function createAccess(db: Db, caller: () => Promise<Caller>, options: AccessOptions = {}): Access {
  const { mail } = options;
  const memo = options.memo ?? new Map<string, number>();
  let human: Promise<Who> | undefined;
  const person = () =>
    (human ??= caller().then(async ({ userId, link, cap }) => ({ userId, linkHashes: await Promise.all(linkTokens(link).map(hashToken)), app: false, cap: cap ? rank(cap) : null })));
  const asApp: () => Promise<Who> = async () => ({ userId: null, linkHashes: [], app: true, cap: null });
  const everyone: () => Promise<Who> = async () => ({ userId: null, linkHashes: [], app: false, cap: null });

  function bound(on: Db, me: () => Promise<Who>): Access {
    // A request asks about one point once; inside a transaction or as the app, it always asks.
    async function levelOf(at: Db, point: string): Promise<number> {
      checkPointId(point);
      const remembered = at === db && me === person;
      if (remembered && memo.has(point)) return memo.get(point)!;
      const [row] = await rows<{ level: number }>(at, sql`select ${levelSql(sql`${point}`, await me())} as level`);
      const level = Number(row?.level ?? 0);
      if (remembered) memo.set(point, level);
      return level;
    }

    async function firstExisting(at: Db, points: readonly string[]): Promise<string | undefined> {
      points.forEach(checkPointId);
      if (points.length === 0) return undefined;
      const found = new Set(((await at.execute(sql`select id from access_point where id in ${points}`)).rows as { id: string }[]).map((r) => r.id));
      return points.find((p) => found.has(p));
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
          insert into access_grant (point_id, user_id, team_id, organization_id, everyone, owner, email, level, granted_by)
          values (${point}, ${g.user}::uuid, ${g.team}::uuid, ${g.organization}::uuid, ${g.everyone}, ${g.owner}, ${g.email}, ${n}, ${grantedBy}::uuid)
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

    const api: Access = {
      async point(point) {
        await need(on, point, READ);
        const row = (await pointRow(on, point))!;
        return { id: row.id, parent: row.parent_id, inherits: row.inherits, static: row.static, organizationId: row.organization_id };
      },
      level: async (point) => named(await levelOf(on, point)),
      can: async (point, level) => (await levelOf(on, point)) >= rank(level),
      check: async (point) => named(await need(on, point, READ))!,
      require: async (point, level) => {
        const id = typeof point === "string" ? point : await firstExisting(on, point);
        if (id === undefined) throw notFound();
        return named(await need(on, id, rank(level)))!;
      },

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
          if (creator) await insertGrant(tx, point, { user: creator, team: null, organization: null, everyone: null, owner: null, email: null }, MANAGE, creator);
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
        await on.transaction(async (raw) => {
          const tx = raw as unknown as Db;
          await lockTree(tx);
          await changeable(tx, point, MANAGE);
          await tx.execute(sql`update access_point set inherits = ${inherits}, updated_at = now() where id = ${point}`);
        });
      },

      async grant(point, to, level, options = {}) {
        const { g, n } = checkGrant(to, level);
        const email = options.email ?? {};
        if (email && email.path !== undefined && !/^\/(?![/\\])/.test(email.path)) throw new Error(`a sharing email's path must start with one /, such as /pages/7; got ${JSON.stringify(email.path)}`);
        const row = await changeable(on, point, MANAGE);
        await checkSameOrganization(on, row, g);
        const { userId } = await me();
        const [inserted] = await insertGrant(on, point, g, n, userParam(userId));
        if (!mail || email === false || !inserted?.inserted || !inserted.recipient || !(g.user || g.email)) return;
        const notice = { to: inserted.recipient, sharedBy: inserted.shared_by, level, path: email.path ?? "/", subject: email.subject, text: email.text };
        mail.waitUntil(mail.email.send(shareMessage(notice, mail.appName, mail.origin)).catch((error) => console.error("sharing email failed", error)));
      },

      async revoke(point, to) {
        const g = granteeColumns(to);
        await changeable(on, point, MANAGE);
        await missingAsNotFound(
          on.execute(sql`
            delete from access_grant where point_id = ${point}
              and user_id is not distinct from ${g.user}::uuid and team_id is not distinct from ${g.team}::uuid
              and organization_id is not distinct from ${g.organization}::uuid and everyone is not distinct from ${g.everyone}
              and owner is not distinct from ${g.owner} and email is not distinct from ${g.email}`),
        );
      },

      async grants(point) {
        await need(on, point, MANAGE);
        const found = await rows<{ user_id: string | null; team_id: string | null; organization_id: string | null; everyone: boolean | null; owner: boolean | null; email: string | null; level: number; granted_by: string | null }>(
          on,
          sql`select user_id, team_id, organization_id, everyone, owner, email, level, granted_by from access_grant where point_id = ${point} order by created_at, id`,
        );
        return found.map((row) => ({ to: grantee(row), level: named(Number(row.level))!, grantedBy: row.granted_by }));
      },

      async link(point, level, options = {}) {
        const n = rank(level);
        if (n > WRITE) throw new Error(`a link can carry read, create or write, never ${level}`);
        if (options.expires !== undefined && !(options.expires instanceof Date && !Number.isNaN(options.expires.getTime()))) throw new Error("a link's expires must be a valid Date");
        if (options.label !== undefined && !(typeof options.label === "string" && options.label.length > 0 && options.label.length <= MAX_LABEL)) throw new Error(`a link's label must be 1 to ${MAX_LABEL} characters`);
        await changeable(on, point, MANAGE);
        const token = newToken();
        const { userId } = await me();
        const [row] = await rows<{ id: string }>(
          on,
          sql`insert into access_link (point_id, token_hash, level, label, expires_at, created_by)
              values (${point}, ${await hashToken(token)}, ${n}, ${options.label ?? null}, ${options.expires ?? null}, ${userParam(userId)}::uuid) returning id`,
        );
        return { id: row!.id, token };
      },

      async links(point) {
        await need(on, point, MANAGE);
        const found = await rows<{ id: string; level: number; label: string | null; expires_at: Date | null; created_at: Date }>(
          on,
          sql`select id, level, label, expires_at, created_at from access_link where point_id = ${point} order by created_at, id`,
        );
        return found.map((row) => ({
          id: row.id,
          level: named(Number(row.level))!,
          label: row.label,
          expiresAt: row.expires_at ? new Date(row.expires_at) : null,
          createdAt: new Date(row.created_at),
        }));
      },

      async revokeLink(point, linkId) {
        await need(on, point, MANAGE);
        await on.execute(sql`delete from access_link where point_id = ${point} and id::text = ${String(linkId)}`);
      },

      readable: async (column) => sql`(${levelSql(sql`(${column})::text`, await me())} >= ${READ})`,
      allows: async (level, column) => sql`(${levelSql(sql`(${column})::text`, await me())} >= ${rank(level)})`,
      async filter<T extends string | readonly string[]>(points: readonly T[], level: Level): Promise<T[]> {
        const wanted = rank(level);
        const valid = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 200;
        const entries = points.map((entry) => (typeof entry === "string" ? [entry] : Array.isArray(entry) ? entry : []).filter(valid));
        const ids = [...new Set(entries.flat())];
        if (ids.length === 0) return [];
        const found = await rows<{ id: string; level: number }>(
          on,
          sql`select t.id, ${levelSql(sql`t.id`, await me())} as level from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) as t(id)
              where exists (select 1 from access_point p where p.id = t.id)`,
        );
        const levels = new Map(found.map((r) => [r.id, Number(r.level)]));
        return points.filter((_, i) => {
          const first = entries[i]!.find((id) => levels.has(id));
          return first !== undefined && levels.get(first)! >= wanted;
        });
      },

      async points(options = {}) {
        const prefix = options.prefix ?? "";
        if (typeof prefix !== "string" || prefix.length > 200) throw new Error("a points prefix must be a string of at most 200 characters");
        const found = await rows<{ id: string }>(
          on,
          sql`select id from access_point where starts_with(id, ${prefix}) and ${levelSql(sql`id`, await me())} >= ${READ} order by id collate "C"`,
        );
        return found.map((r) => r.id);
      },

      in: (tx) => bound(tx as Db, me),
      asApp: () => bound(on, asApp),
      asEveryone: () => bound(on, everyone),
    };
    for (const name of WRITES) {
      const write = api[name] as (...args: unknown[]) => Promise<unknown>;
      (api as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        if (me === everyone) throw new Error(`app.access.asEveryone() only reads; ${name} needs the caller's own app.access`);
        return forgetting(memo, () => write(...args));
      };
    }
    return api;
  }

  return bound(db, person);
}

// Writes the app's static points, as declared in code: each is created or updated, and its grants
// replaced. Points no longer declared are left alone. Run by every deploy after migrations, so
// requests never write them.
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
          insert into access_grant (point_id, user_id, team_id, organization_id, everyone, owner, email, level)
          values (${name}, ${g.user}::uuid, ${g.team}::uuid, ${g.organization}::uuid, ${g.everyone}, ${g.owner}, ${g.email}, ${n})`);
      }
    }
  });
}
