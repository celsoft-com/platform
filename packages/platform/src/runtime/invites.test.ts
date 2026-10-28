import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../test/database.js";
import { defineApp } from "./index.js";
import { INVITE_ONLY } from "./invites.js";

// Invite-only sign-up through the Worker, with Better Auth and Postgres: see docs/design.md, Auth,
// Signup. The file's database starts empty, so its first sign-up is the app's first account.

const { pool, url } = await freshDatabase();
const uid = () => randomUUID();
const app = defineApp(undefined, { pool: (connectionString) => new Pool({ connectionString, max: 2 }) });
const env = (extra: Record<string, unknown> = {}) => ({
  DB: { connectionString: url },
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  APP_URL: "https://app.test",
  APP_NAME: "test",
  ACCESS: "on",
  AUTH_ORGANIZATIONS: "on",
  EMAIL_MODE: "capture",
  ...extra,
});
const ctx = { waitUntil: () => {} };

async function send(path: string, init: { method?: string; body?: unknown; cookie?: string; env?: Record<string, unknown> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: "https://app.test" };
  if (init.cookie) headers.cookie = init.cookie;
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const response = await app.fetch(new Request(`https://app.test${path}`, { method, headers, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) }), env(init.env) as never, ctx);
  const text = await response.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body, cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

const signUp = (email: string, extra?: Record<string, unknown>) => send("/api/auth/sign-up/email", { body: { name: "Pat", email, password: "a-long-password-1" }, env: extra });
const address = () => `${uid()}@example.com`;
let owner = "";

describe("Invite-only sign-up", () => {
  it("I1: the first account signs up without an invitation and is the owner; after it, an uninvited address is refused the same way whether or not it has an account", async () => {
    const first = address();
    const made = await signUp(first);
    expect(made.status).toBe(200);
    owner = made.cookie;
    expect((await pool.query(`select role from "user" where email = $1`, [first])).rows[0].role).toBe("owner");
    const stranger = await signUp(address());
    expect(stranger).toMatchObject({ status: 403, body: { message: INVITE_ONLY } });
    expect((await signUp(first)).body).toEqual(stranger.body);
  });

  it("I2: the owner invites an address, which signs up once, using the invitation up; inviting again renews it", async () => {
    const invited = address();
    const sent = vi.spyOn(console, "log").mockImplementation(() => {});
    const made = await send("/api/platform/invites", { cookie: owner, body: { email: invited.toUpperCase() } });
    expect(made.status).toBe(201);
    expect(made.body.email).toBe(invited);
    expect(JSON.stringify(sent.mock.calls)).toContain(`/signup?email=${encodeURIComponent(invited)}`);
    sent.mockRestore();
    const again = await send("/api/platform/invites", { cookie: owner, body: { email: invited } });
    expect(again.body.id).toBe(made.body.id);
    expect((await send("/api/platform/invites", { cookie: owner })).body.map((i: { email: string }) => i.email)).toContain(invited);
    expect((await signUp(invited)).status).toBe(200);
    expect((await pool.query(`select 1 from signup_invite where email = $1`, [invited])).rows).toHaveLength(0);
  });

  it("I3: an expired or revoked invitation lets no one sign up", async () => {
    const [late, revoked] = [address(), address()];
    await send("/api/platform/invites", { cookie: owner, body: { email: late } });
    await pool.query(`update signup_invite set expires_at = now() - interval '1 second' where email = $1`, [late]);
    expect((await signUp(late)).status).toBe(403);
    const made = await send("/api/platform/invites", { cookie: owner, body: { email: revoked } });
    expect((await send(`/api/platform/invites/${made.body.id}`, { cookie: owner, method: "DELETE" })).status).toBe(200);
    expect((await signUp(revoked)).status).toBe(403);
    expect((await send(`/api/platform/invites/${made.body.id}`, { cookie: owner, method: "DELETE" })).status).toBe(404);
  });

  it("I4: only the owner and admins invite, list and revoke; signed out is a 401", async () => {
    const plain = address();
    await send("/api/platform/invites", { cookie: owner, body: { email: plain } });
    const member = (await signUp(plain)).cookie;
    expect((await send("/api/platform/invites", { cookie: member, body: { email: address() } })).status).toBe(403);
    expect((await send("/api/platform/invites", { cookie: member })).status).toBe(403);
    expect((await send("/api/platform/invites", { body: { email: address() } })).status).toBe(401);
    await pool.query(`update "user" set role = 'admin' where email = $1`, [plain]);
    expect((await send("/api/platform/invites", { cookie: member, body: { email: address() } })).status).toBe(201);
  });

  it("I5: an address that already has an account, or is not an address, cannot be invited", async () => {
    const taken = (await pool.query(`select email from "user" limit 1`)).rows[0].email;
    expect((await send("/api/platform/invites", { cookie: owner, body: { email: taken } })).status).toBe(409);
    expect((await send("/api/platform/invites", { cookie: owner, body: { email: "nope" } })).status).toBe(400);
  });

  it("I6: an open organization invitation, or a share to an address, lets that address sign up", async () => {
    const [joiner, shared] = [address(), address()];
    const org = await send("/api/platform/organizations", { cookie: owner, body: { name: "Crew" } });
    expect((await send(`/api/platform/organizations/${org.body.id}/invitations`, { cookie: owner, body: { email: joiner } })).status).toBeLessThan(300);
    expect((await signUp(joiner)).status).toBe(200);
    const point = `doc-${uid()}`;
    await pool.query(`insert into access_point (id) values ($1)`, [point]);
    await pool.query(`insert into access_grant (point_id, email, level) values ($1, $2, 1)`, [point, shared]);
    expect((await signUp(shared)).status).toBe(200);
  });

  it("I7: with sign-up open, anyone signs up", async () => {
    expect((await signUp(address(), { AUTH_SIGNUP: "open" })).status).toBe(200);
  });

  it("I8: the invitations screen is served, and sign-up fills in the invited address", async () => {
    const screen = await send("/invites");
    expect(screen.status).toBe(200);
    expect(screen.body).toContain("Invitations");
    expect((await send("/signup")).body).toContain(`params.get("email")`);
  });
});
