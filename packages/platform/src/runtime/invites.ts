import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Email } from "./email.js";
import { EndpointError, refusal } from "./endpoint-error.js";

// Invite-only sign-up: once an app has its first account, a new address may sign up only with an
// invitation from the owner or an admin, an open organization invitation, or a share to that
// address. See docs/design.md, Auth, Signup.

type Db = Pick<NodePgDatabase<Record<string, unknown>>, "execute">;

export const INVITES_PATH = "/invites";
export const INVITES_API = "/api/platform/invites";
export const INVITE_DAYS = 14;
export const INVITE_ONLY = "This app is invite-only; ask an admin for an invitation";
const INVITER_ROLES = ["owner", "admin"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Invite {
  id: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface Invites {
  // Invites an address, or renews its invitation for another 14 days, and emails it a sign-up link.
  create(email: string): Promise<Invite>;
  // The open invitations, newest first.
  list(): Promise<Invite[]>;
  revoke(id: string): Promise<void>;
}

// Whether this address may sign up now. The first account always may, and becomes the owner.
export async function signupAllowed(db: Db, email: string): Promise<boolean> {
  const address = email.trim().toLowerCase();
  const [row] = (
    await db.execute(sql`select
      not exists (select 1 from "user")
      or exists (select 1 from signup_invite where email = ${address} and expires_at > now())
      or exists (select 1 from invitation where email = ${address} and expires_at > now())
      or exists (select 1 from access_grant where email = ${address}) as allowed`)
  ).rows as { allowed: boolean }[];
  return row!.allowed;
}

// Called once an address has signed up, so its invitation cannot be used again.
export async function useInvite(db: Db, email: string): Promise<void> {
  await db.execute(sql`delete from signup_invite where email = ${email.trim().toLowerCase()}`);
}

interface Caller {
  id: string;
}

export function createInvites(db: Db, caller: () => Promise<Caller>, email: Email, appUrl: string, appName: string): Invites {
  // Read from the table, not the session's cached copy, so a new owner may invite at once and a
  // removed admin may not.
  async function inviter(): Promise<Caller> {
    const me = await caller();
    const [row] = (await db.execute(sql`select role from "user" where id = ${me.id}::uuid`)).rows as { role: string | null }[];
    if (!INVITER_ROLES.includes(row?.role ?? "")) throw new EndpointError(403, "only the owner and admins may invite people");
    return me;
  }
  return {
    async create(raw) {
      const me = await inviter();
      const address = raw.trim().toLowerCase();
      if (!EMAIL.test(address)) throw new EndpointError(400, "that is not an email address");
      const [existing] = (await db.execute(sql`select 1 from "user" where email = ${address}`)).rows;
      if (existing) throw new EndpointError(409, "that address already has an account");
      const [row] = (
        await db.execute(sql`
          insert into signup_invite (email, expires_at, invited_by) values (${address}, now() + make_interval(days => ${INVITE_DAYS}), ${me.id}::uuid)
          on conflict (email) do update set expires_at = excluded.expires_at, invited_by = excluded.invited_by, updated_at = now()
          returning id, email, expires_at, created_at`)
      ).rows as { id: string; email: string; expires_at: Date; created_at: Date }[];
      const link = `${appUrl}/signup?email=${encodeURIComponent(address)}`;
      await email.send({ to: address, subject: `You're invited to ${appName}`, text: `You're invited to ${appName}. Create your account with this address:\n\n${link}\n\nThe invitation lasts ${INVITE_DAYS} days.` });
      return { id: row!.id, email: row!.email, expiresAt: new Date(row!.expires_at), createdAt: new Date(row!.created_at) };
    },
    async list() {
      await inviter();
      const rows = (await db.execute(sql`select id, email, expires_at, created_at from signup_invite where expires_at > now() order by created_at desc`)).rows as { id: string; email: string; expires_at: Date; created_at: Date }[];
      return rows.map((r) => ({ id: r.id, email: r.email, expiresAt: new Date(r.expires_at), createdAt: new Date(r.created_at) }));
    },
    async revoke(id) {
      await inviter();
      if (!/^[0-9a-f-]{36}$/i.test(id)) throw new EndpointError(404, "not found");
      const gone = await db.execute(sql`delete from signup_invite where id = ${id}::uuid`);
      if (gone.rowCount === 0) throw new EndpointError(404, "not found");
    },
  };
}

// The browser's side: GET lists, POST { email } invites, DELETE /<id> revokes.
export async function serveInvites(request: Request, path: string, invites: Invites): Promise<Response> {
  try {
    if (path === INVITES_API && request.method === "GET") return Response.json(await invites.list());
    if (path === INVITES_API && request.method === "POST") {
      const body = (await request.json().catch(() => undefined)) as { email?: unknown } | undefined;
      if (!body || typeof body.email !== "string") return Response.json({ error: "send { email }" }, { status: 400 });
      return Response.json(await invites.create(body.email), { status: 201 });
    }
    const id = path.startsWith(`${INVITES_API}/`) ? path.slice(INVITES_API.length + 1) : undefined;
    if (id && request.method === "DELETE") {
      await invites.revoke(id);
      return Response.json({});
    }
    return Response.json({ error: "not found" }, { status: 404 });
  } catch (thrown) {
    const refused = thrown instanceof Response ? undefined : await refusal(thrown);
    if (refused) return Response.json({ error: refused.message }, { status: refused.status });
    throw thrown;
  }
}
