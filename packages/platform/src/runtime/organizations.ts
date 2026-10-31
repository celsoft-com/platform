import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { createAccess, organizationPoint, teamPoint, type Access, type Caller } from "./access.js";
import { EndpointError, refusal } from "./endpoint-error.js";

// The platform's own organizations, teams, members and invitations; see docs/design.md, Auth
// behavior, Organizations. Members carry no roles: who may do what is decided by control points,
// the organization's point for the organization and each team's point for the team, and the
// built-in Admins team gets `manage` on everything under its organization.

export const INVITATION_DAYS = 7;
export const ADMINS = "Admins";

export interface Organization {
  id: string;
  name: string;
  slug: string;
}

export interface Member {
  userId: string;
  name: string;
  email: string;
  admin: boolean;
}

export interface Team {
  id: string;
  name: string;
  admins: boolean;
}

export interface Invitation {
  id: string;
  email: string;
  teamId: string | null;
  expiresAt: Date;
}

// An invitation as the person it was sent to sees it.
export interface MyInvitation {
  id: string;
  organizationId: string;
  organization: string;
  teamId: string | null;
  team: string | null;
  invitedBy: string | null;
  expiresAt: Date;
}

export interface InvitationNotice {
  to: string;
  organization: string;
  invitedBy: string | null;
  invitationId: string;
}

export interface Organizations {
  // Makes an organization, its point, and its Admins team holding the creator.
  create(input: { name: string; slug?: string }): Promise<Organization>;
  // The organizations the signed-in user belongs to.
  list(): Promise<Organization[]>;
  get(id: string): Promise<Organization>;
  rename(id: string, name: string): Promise<void>;
  remove(id: string): Promise<void>;
  // Throws a 404 unless the signed-in user belongs, so outsiders cannot tell it exists.
  requireMember(id: string): Promise<void>;
  members(id: string): Promise<Member[]>;
  removeMember(id: string, userId: string): Promise<void>;
  invite(id: string, email: string, options?: { team?: string }): Promise<Invitation>;
  invitations(id: string): Promise<Invitation[]>;
  revokeInvitation(id: string, invitationId: string): Promise<void>;
  // Joins the organization the invitation is for, when the signed-in user's confirmed email is
  // the one it was sent to; returns the organization's id.
  accept(invitationId: string): Promise<string>;
  // Invitations to the signed-in user's confirmed email that have not expired.
  myInvitations(): Promise<MyInvitation[]>;
  // Turns down an invitation sent to the signed-in user's confirmed email.
  decline(invitationId: string): Promise<void>;
  teams(id: string): Promise<Team[]>;
  // One team, for those who can read its point.
  team(teamId: string): Promise<Team & { organizationId: string }>;
  createTeam(id: string, name: string): Promise<Team>;
  renameTeam(teamId: string, name: string): Promise<void>;
  removeTeam(teamId: string): Promise<void>;
  teamMembers(teamId: string): Promise<Member[]>;
  addToTeam(teamId: string, userId: string): Promise<void>;
  removeFromTeam(teamId: string, userId: string): Promise<void>;
}

type Db = Pick<NodePgDatabase<Record<string, unknown>>, "execute" | "transaction">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new EndpointError(404, "not found");
const conflict = (message: string) => new EndpointError(409, message);
const invalid = (message: string) => new EndpointError(400, message);
const rows = async <T>(db: Db, query: SQL): Promise<T[]> => (await db.execute(query)).rows as T[];

// Ids come from URLs and bodies; anything that is not a UUID names nothing.
function uuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw notFound();
  return value.toLowerCase();
}

function name(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 100) throw invalid("a name must be 1 to 100 characters");
  return value.trim();
}

function slugOf(value: unknown, fallback: string): string {
  const slug = typeof value === "string" ? value : `${fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "org"}-${crypto.randomUUID().slice(0, 8)}`;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(slug)) throw invalid("a slug is 1 to 64 lowercase letters, digits and dashes, not starting or ending with a dash");
  return slug;
}

function email(value: unknown): string {
  if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw invalid("an email address is needed");
  return value.trim().toLowerCase();
}

export function createOrganizations(db: Db, caller: () => Promise<Caller>, notify?: (notice: InvitationNotice) => Promise<void>): Organizations {
  const access: Access = createAccess(db, caller);

  async function me(): Promise<string> {
    const { userId } = await caller();
    if (!userId || !UUID.test(userId)) throw new EndpointError(401, "sign in first");
    return userId;
  }

  // The team's organization, when the caller can see the team at all.
  async function teamOrganization(on: Db, teamId: string): Promise<{ organizationId: string; admins: boolean }> {
    const [team] = await rows<{ organization_id: string; admins: boolean }>(on, sql`select organization_id, admins from team where id = ${teamId}::uuid`);
    if (!team) throw notFound();
    return { organizationId: team.organization_id, admins: team.admins };
  }

  // Refuses a change that would leave an organization with no admin.
  async function keepAnAdmin(on: Db, organizationId: string, userId: string): Promise<void> {
    const [row] = await rows<{ admin: boolean; admins: number }>(
      on,
      sql`select exists (select 1 from team_member tm join team t on t.id = tm.team_id where t.organization_id = ${organizationId}::uuid and t.admins and tm.user_id = ${userId}::uuid) as admin,
                 (select count(*) from team_member tm join team t on t.id = tm.team_id join member m on m.user_id = tm.user_id and m.organization_id = t.organization_id
                  where t.organization_id = ${organizationId}::uuid and t.admins)::int as admins`,
    );
    if (row?.admin && Number(row.admins) <= 1) throw conflict("an organization needs at least one admin; add another first");
  }

  async function makeTeam(tx: Db, organizationId: string, teamName: string, admins: boolean, creator: string): Promise<Team> {
    const [team] = await rows<{ id: string }>(tx, sql`insert into team (name, organization_id, admins) values (${teamName}, ${organizationId}::uuid, ${admins}) returning id`);
    await tx.execute(sql`
      insert into access_point (id, parent_id, organization_id, for_team, created_by)
      values (${teamPoint(team!.id)}, ${organizationPoint(organizationId)}, ${organizationId}::uuid, ${team!.id}::uuid, ${creator}::uuid)`);
    await tx.execute(sql`
      insert into access_grant (point_id, team_id, user_id, level, granted_by)
      values (${teamPoint(team!.id)}, ${team!.id}::uuid, null, 3, ${creator}::uuid), (${teamPoint(team!.id)}, null, ${creator}::uuid, 5, ${creator}::uuid)`);
    return { id: team!.id, name: teamName, admins };
  }

  const listMembers = (on: Db, where: SQL) =>
    rows<{ user_id: string; name: string; email: string; admin: boolean }>(
      on,
      sql`select u.id as user_id, u.name, u.email,
            exists (select 1 from team_member tm join team t on t.id = tm.team_id where t.organization_id = m.organization_id and t.admins and tm.user_id = u.id) as admin
          from member m join "user" u on u.id = m.user_id where ${where} order by u.name, u.id`,
    ).then((found) => found.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, admin: Boolean(r.admin) })));

  return {
    async create(input) {
      const creator = await me();
      const orgName = name(input?.name);
      const slug = slugOf(input?.slug, orgName);
      return db.transaction(async (raw) => {
        const tx = raw as unknown as Db;
        let org: { id: string } | undefined;
        try {
          [org] = await rows<{ id: string }>(tx, sql`insert into organization (name, slug) values (${orgName}, ${slug}) returning id`);
        } catch (error) {
          if ((error as { code?: string; cause?: { code?: string } }).code === "23505" || (error as { cause?: { code?: string } }).cause?.code === "23505") throw conflict("that slug is taken");
          throw error;
        }
        const id = org!.id;
        await tx.execute(sql`insert into member (organization_id, user_id) values (${id}::uuid, ${creator}::uuid)`);
        await tx.execute(sql`
          insert into access_point (id, organization_id, for_organization, created_by) values (${organizationPoint(id)}, ${id}::uuid, ${id}::uuid, ${creator}::uuid)`);
        await tx.execute(sql`
          insert into access_grant (point_id, organization_id, level, granted_by) values (${organizationPoint(id)}, ${id}::uuid, 1, ${creator}::uuid)`);
        await tx.execute(sql`
          insert into access_grant (point_id, user_id, level, granted_by) values (${organizationPoint(id)}, ${creator}::uuid, 5, ${creator}::uuid)`);
        const admins = await makeTeam(tx, id, ADMINS, true, creator);
        await tx.execute(sql`insert into team_member (team_id, user_id) values (${admins.id}::uuid, ${creator}::uuid)`);
        return { id, name: orgName, slug };
      });
    },

    async list() {
      const userId = await me();
      return rows<Organization>(
        db,
        sql`select o.id, o.name, o.slug from organization o join member m on m.organization_id = o.id where m.user_id = ${userId}::uuid order by o.name, o.id`,
      );
    },

    async get(id) {
      await access.check(organizationPoint(uuid(id)));
      const [org] = await rows<Organization>(db, sql`select id, name, slug from organization where id = ${uuid(id)}::uuid`);
      if (!org) throw notFound();
      return org;
    },

    async rename(id, newName) {
      await access.require(organizationPoint(uuid(id)), "write");
      await db.execute(sql`update organization set name = ${name(newName)}, updated_at = now() where id = ${uuid(id)}::uuid`);
    },

    async remove(id) {
      await access.require(organizationPoint(uuid(id)), "delete");
      await db.execute(sql`delete from organization where id = ${uuid(id)}::uuid`);
    },

    async requireMember(id) {
      const userId = await me();
      const [row] = await rows(db, sql`select 1 from member where organization_id = ${uuid(id)}::uuid and user_id = ${userId}::uuid`);
      if (!row) throw notFound();
    },

    async members(id) {
      await access.check(organizationPoint(uuid(id)));
      return listMembers(db, sql`m.organization_id = ${uuid(id)}::uuid`);
    },

    async removeMember(id, userId) {
      const orgId = uuid(id);
      const leaving = uuid(userId);
      const self = (await me()) === leaving;
      // Anyone may leave; removing someone else needs `manage` on the organization.
      if (self) await access.check(organizationPoint(orgId));
      else await access.require(organizationPoint(orgId), "manage");
      await db.transaction(async (raw) => {
        const tx = raw as unknown as Db;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`@celsoft/platform admins ${orgId}`}))`);
        const [row] = await rows(tx, sql`select 1 from member where organization_id = ${orgId}::uuid and user_id = ${leaving}::uuid`);
        if (!row) throw notFound();
        await keepAnAdmin(tx, orgId, leaving);
        await tx.execute(sql`delete from team_member where user_id = ${leaving}::uuid and team_id in (select id from team where organization_id = ${orgId}::uuid)`);
        await tx.execute(sql`delete from member where organization_id = ${orgId}::uuid and user_id = ${leaving}::uuid`);
      });
    },

    async invite(id, address, options = {}) {
      const orgId = uuid(id);
      await access.require(organizationPoint(orgId), "manage");
      const to = email(address);
      const teamId = options.team === undefined || options.team === null ? null : uuid(options.team);
      if (teamId && (await teamOrganization(db, teamId)).organizationId !== orgId) throw notFound();
      const inviter = await me();
      const [row] = await rows<{ id: string; expires_at: Date; inviter: string | null; org: string }>(
        db,
        sql`insert into invitation (organization_id, email, team_id, expires_at, inviter_id)
            values (${orgId}::uuid, ${to}, ${teamId}::uuid, now() + make_interval(days => ${INVITATION_DAYS}), ${inviter}::uuid)
            on conflict on constraint invitation_once do update set team_id = excluded.team_id, expires_at = excluded.expires_at, inviter_id = excluded.inviter_id, updated_at = now()
            returning id, expires_at, (select name from "user" where id = ${inviter}::uuid) as inviter, (select name from organization where id = ${orgId}::uuid) as org`,
      );
      await notify?.({ to, organization: row!.org, invitedBy: row!.inviter, invitationId: row!.id });
      return { id: row!.id, email: to, teamId, expiresAt: new Date(row!.expires_at) };
    },

    async invitations(id) {
      await access.require(organizationPoint(uuid(id)), "manage");
      const found = await rows<{ id: string; email: string; team_id: string | null; expires_at: Date }>(
        db,
        sql`select id, email, team_id, expires_at from invitation where organization_id = ${uuid(id)}::uuid and expires_at > now() order by created_at, id`,
      );
      return found.map((r) => ({ id: r.id, email: r.email, teamId: r.team_id, expiresAt: new Date(r.expires_at) }));
    },

    async revokeInvitation(id, invitationId) {
      await access.require(organizationPoint(uuid(id)), "manage");
      await db.execute(sql`delete from invitation where id = ${uuid(invitationId)}::uuid and organization_id = ${uuid(id)}::uuid`);
    },

    async accept(invitationId) {
      const userId = await me();
      const invitationKey = uuid(invitationId);
      return db.transaction(async (raw) => {
        const tx = raw as unknown as Db;
        const [inv] = await rows<{ organization_id: string; team_id: string | null }>(
          tx,
          sql`select i.organization_id, i.team_id from invitation i join "user" u on u.id = ${userId}::uuid
              where i.id = ${invitationKey}::uuid and i.expires_at > now() and u.email_verified and lower(u.email) = i.email
              for update of i`,
        );
        if (!inv) throw notFound();
        await tx.execute(sql`insert into member (organization_id, user_id) values (${inv.organization_id}::uuid, ${userId}::uuid) on conflict on constraint member_once do nothing`);
        if (inv.team_id) await tx.execute(sql`insert into team_member (team_id, user_id) values (${inv.team_id}::uuid, ${userId}::uuid) on conflict on constraint team_member_once do nothing`);
        await tx.execute(sql`delete from invitation where id = ${invitationKey}::uuid`);
        return inv.organization_id;
      });
    },

    async myInvitations() {
      const userId = await me();
      const found = await rows<{ id: string; organization_id: string; organization: string; team_id: string | null; team: string | null; invited_by: string | null; expires_at: Date }>(
        db,
        sql`select i.id, i.organization_id, o.name as organization, i.team_id, t.name as team, inviter.name as invited_by, i.expires_at
            from invitation i join "user" u on u.id = ${userId}::uuid and u.email_verified and lower(u.email) = i.email
            join organization o on o.id = i.organization_id
            left join team t on t.id = i.team_id
            left join "user" inviter on inviter.id = i.inviter_id
            where i.expires_at > now() order by i.created_at, i.id`,
      );
      return found.map((r) => ({ id: r.id, organizationId: r.organization_id, organization: r.organization, teamId: r.team_id, team: r.team, invitedBy: r.invited_by, expiresAt: new Date(r.expires_at) }));
    },

    async decline(invitationId) {
      const userId = await me();
      const [row] = await rows(
        db,
        sql`delete from invitation i using "user" u where i.id = ${uuid(invitationId)}::uuid and u.id = ${userId}::uuid and u.email_verified and lower(u.email) = i.email returning i.id`,
      );
      if (!row) throw notFound();
    },

    async team(teamId) {
      await access.check(teamPoint(uuid(teamId)));
      const [found] = await rows<Team & { organization_id: string }>(db, sql`select id, name, admins, organization_id from team where id = ${uuid(teamId)}::uuid`);
      if (!found) throw notFound();
      return { id: found.id, name: found.name, admins: found.admins, organizationId: found.organization_id };
    },

    async teams(id) {
      await access.check(organizationPoint(uuid(id)));
      return rows<Team>(db, sql`select id, name, admins from team where organization_id = ${uuid(id)}::uuid order by admins desc, name, id`);
    },

    async createTeam(id, teamName) {
      const orgId = uuid(id);
      const n = name(teamName);
      await access.require(organizationPoint(orgId), "create");
      const creator = await me();
      return db.transaction(async (raw) => makeTeam(raw as unknown as Db, orgId, n, false, creator));
    },

    async renameTeam(teamId, newName) {
      await access.require(teamPoint(uuid(teamId)), "write");
      await db.execute(sql`update team set name = ${name(newName)}, updated_at = now() where id = ${uuid(teamId)}::uuid`);
    },

    async removeTeam(teamId) {
      await access.require(teamPoint(uuid(teamId)), "delete");
      if ((await teamOrganization(db, uuid(teamId))).admins) throw conflict("the Admins team stays as long as its organization");
      await db.execute(sql`delete from team where id = ${uuid(teamId)}::uuid`);
    },

    async teamMembers(teamId) {
      await access.check(teamPoint(uuid(teamId)));
      return listMembers(db, sql`exists (select 1 from team_member tm where tm.team_id = ${uuid(teamId)}::uuid and tm.user_id = m.user_id) and m.organization_id = (select organization_id from team where id = ${uuid(teamId)}::uuid)`);
    },

    async addToTeam(teamId, userId) {
      const team = uuid(teamId);
      const adding = uuid(userId);
      await access.require(teamPoint(team), "manage");
      const { organizationId } = await teamOrganization(db, team);
      const [row] = await rows(db, sql`select 1 from member where organization_id = ${organizationId}::uuid and user_id = ${adding}::uuid`);
      if (!row) throw notFound();
      await db.execute(sql`insert into team_member (team_id, user_id) values (${team}::uuid, ${adding}::uuid) on conflict on constraint team_member_once do nothing`);
    },

    async removeFromTeam(teamId, userId) {
      const team = uuid(teamId);
      const leaving = uuid(userId);
      if ((await me()) === leaving) await access.check(teamPoint(team));
      else await access.require(teamPoint(team), "manage");
      const { organizationId, admins } = await teamOrganization(db, team);
      await db.transaction(async (raw) => {
        const tx = raw as unknown as Db;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`@celsoft/platform admins ${organizationId}`}))`);
        if (admins) await keepAnAdmin(tx, organizationId, leaving);
        await tx.execute(sql`delete from team_member where team_id = ${team}::uuid and user_id = ${leaving}::uuid`);
      });
    },
  };
}

export const PLATFORM_API = "/api/platform/";

type Route = [method: string, pattern: RegExp, run: (orgs: Organizations, params: string[], body: Record<string, unknown>) => Promise<unknown>];

const ROUTES: Route[] = [
  ["GET", /^organizations$/, (o) => o.list()],
  ["POST", /^organizations$/, (o, _, b) => o.create({ name: b.name as string, slug: b.slug as string | undefined })],
  ["GET", /^organizations\/([^/]+)$/, (o, [id]) => o.get(id!)],
  ["PATCH", /^organizations\/([^/]+)$/, (o, [id], b) => o.rename(id!, b.name as string)],
  ["DELETE", /^organizations\/([^/]+)$/, (o, [id]) => o.remove(id!)],
  ["GET", /^organizations\/([^/]+)\/members$/, (o, [id]) => o.members(id!)],
  ["DELETE", /^organizations\/([^/]+)\/members\/([^/]+)$/, (o, [id, user]) => o.removeMember(id!, user!)],
  ["GET", /^organizations\/([^/]+)\/invitations$/, (o, [id]) => o.invitations(id!)],
  ["POST", /^organizations\/([^/]+)\/invitations$/, (o, [id], b) => o.invite(id!, b.email as string, { team: b.team as string | undefined })],
  ["DELETE", /^organizations\/([^/]+)\/invitations\/([^/]+)$/, (o, [id, inv]) => o.revokeInvitation(id!, inv!)],
  ["GET", /^invitations$/, (o) => o.myInvitations()],
  ["POST", /^invitations\/([^/]+)\/accept$/, async (o, [inv]) => ({ organizationId: await o.accept(inv!) })],
  ["DELETE", /^invitations\/([^/]+)$/, (o, [inv]) => o.decline(inv!)],
  ["GET", /^organizations\/([^/]+)\/teams$/, (o, [id]) => o.teams(id!)],
  ["POST", /^organizations\/([^/]+)\/teams$/, (o, [id], b) => o.createTeam(id!, b.name as string)],
  ["GET", /^teams\/([^/]+)$/, (o, [team]) => o.team(team!)],
  ["PATCH", /^teams\/([^/]+)$/, (o, [team], b) => o.renameTeam(team!, b.name as string)],
  ["DELETE", /^teams\/([^/]+)$/, (o, [team]) => o.removeTeam(team!)],
  ["GET", /^teams\/([^/]+)\/members$/, (o, [team]) => o.teamMembers(team!)],
  ["POST", /^teams\/([^/]+)\/members$/, (o, [team], b) => o.addToTeam(team!, b.user as string)],
  ["DELETE", /^teams\/([^/]+)\/members\/([^/]+)$/, (o, [team, user]) => o.removeFromTeam(team!, user!)],
];

// The organization routes browsers call, under /api/platform/, answering JSON like every API
// route; an unknown path or method under the prefix is a 404.
export async function serveOrganizations(request: Request, path: string, orgs: Organizations): Promise<Response> {
  const rest = path.slice(PLATFORM_API.length);
  for (const [method, pattern, run] of ROUTES) {
    const match = pattern.exec(rest);
    if (!match || request.method !== method) continue;
    let body: Record<string, unknown> = {};
    if (method === "POST" || method === "PATCH") {
      const parsed = await request.json().catch(() => undefined);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return Response.json({ error: "send a JSON object" }, { status: 400 });
      body = parsed as Record<string, unknown>;
    }
    try {
      let params: string[];
      try {
        params = match.slice(1).map(decodeURIComponent);
      } catch {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const result = await run(orgs, params, body);
      return Response.json(result ?? {}, { status: method === "POST" && !rest.endsWith("/accept") ? 201 : 200 });
    } catch (error) {
      const refused = error instanceof Response ? undefined : await refusal(error);
      if (refused) return Response.json({ error: refused.message }, { status: refused.status });
      throw error;
    }
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
