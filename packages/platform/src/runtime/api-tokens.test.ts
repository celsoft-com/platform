import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { freshDatabase } from "../../test/database.js";
import { organizationPoint } from "./access.js";
import { endpoint } from "./endpoints.js";
import { defineApp } from "./index.js";

// Personal API tokens through the Worker, with Better Auth and Postgres: rows T1 onward of
// docs/access-rules.md.

const { pool, url } = await freshDatabase();
const uid = () => randomUUID();
const ran: string[] = [];

const app = defineApp(undefined, {
  pool: (connectionString) => new Pool({ connectionString, max: 2 }),
  endpoints: {
    whoAmI: endpoint({ method: "GET", path: "/api/me", input: z.object({}), output: z.object({ id: z.string() }), access: { level: "read" } }, async (_, a) => ({ id: (await a.requireUser()).id })),
    makeDoc: endpoint({ method: "POST", path: "/api/docs", input: z.object({ id: z.string() }), output: z.object({}), access: { level: "create" } }, async ({ id }, a) => {
      ran.push(`make ${id}`);
      await a.access.create(id);
      return {};
    }),
    readDoc: endpoint({ method: "GET", path: "/api/docs/:id", input: z.object({ id: z.string() }), output: z.object({ level: z.string() }), access: { point: "id", level: "read" } }, async ({ id }, a) => ({ level: await a.access.check(id) })),
    writeDoc: endpoint({ method: "PUT", path: "/api/docs/:id", input: z.object({ id: z.string() }), output: z.object({}), access: { point: "id", level: "write" } }, ({ id }) => (ran.push(`write ${id}`), {})),
    shareDoc: endpoint(
      { method: "POST", path: "/api/docs/:id/share", input: z.object({ id: z.string(), to: z.string() }), output: z.object({}), access: { point: "id", level: "manage" } },
      async ({ id, to }, a) => (ran.push(`share ${id}`), await a.access.grant(id, { user: to }, "read"), {}),
    ),
    clearDocs: endpoint({ method: "DELETE", path: "/api/docs", input: z.object({}), output: z.object({}), access: { level: "delete" } }, () => (ran.push("clear"), {})),
    manageable: endpoint({ method: "GET", path: "/api/manageable", input: z.object({}), output: z.array(z.string()), access: { level: "read" } }, async (_, a) => {
      const rows = await pool.query(`select id from access_point where created_by = $1 order by id`, [(await a.requireUser()).id]);
      const out: string[] = [];
      for (const r of rows.rows) if (await a.access.can(r.id, "manage")) out.push(r.id);
      return out;
    }),
  },
});

const env = (extra: Record<string, unknown> = {}) => ({
  DB: { connectionString: url },
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
  AUTH_SIGNUP: "open",
  APP_URL: "https://app.test",
  APP_NAME: "test",
  ACCESS: "on",
  AUTH_ORGANIZATIONS: "on",
  AUTH_API_TOKENS: "on",
  MCP: "on",
  EMAIL_MODE: "capture",
  ...extra,
});
const ctx = { waitUntil: () => {} };

async function send(path: string, init: { method?: string; body?: unknown; cookie?: string; token?: string; authorization?: string; env?: Record<string, unknown> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: "https://app.test" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.authorization) headers.authorization = init.authorization;
  const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
  const response = await app.fetch(new Request(`https://app.test${path}`, { method, headers, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) }), env(init.env) as never, ctx);
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: response.status, body: body as any, cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}

async function person() {
  const signed = await send("/api/auth/sign-up/email", { body: { name: "Pat", email: `${uid()}@example.com`, password: "a-long-password-1" } });
  return { cookie: signed.cookie, id: signed.body.user.id as string };
}

async function token(cookie: string, body: Record<string, unknown> = {}) {
  const made = await send("/api/auth/api-key/create", { cookie, body: { name: "script", ...body } });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return made.body as { id: string; key: string; expiresAt: string };
}

describe("API tokens", () => {
  it("T1: a person makes a token, shown once, stored only as a hash, listed without the key", async () => {
    const p = await person();
    const made = await token(p.cookie, { metadata: { cap: "write" } });
    expect(made.key).toMatch(/^pat_/);
    const stored = (await pool.query(`select key, metadata from apikey where id = $1`, [made.id])).rows[0];
    expect(stored.key).not.toContain(made.key);
    const listed = await send("/api/auth/api-key/list", { cookie: p.cookie });
    expect(JSON.stringify(listed.body)).not.toContain(made.key);
    expect(JSON.stringify(listed.body)).toContain('"cap":"write"');
  });

  it("T2: a token acts as the person who made it", async () => {
    const p = await person();
    const { key } = await token(p.cookie);
    expect(await send("/api/me", { token: key })).toEqual({ status: 200, body: { id: p.id }, cookie: "" });
  });

  it("T3: a read token can only read: every other method is a 403 and nothing runs", async () => {
    const p = await person();
    const doc = `doc-${uid()}`;
    await send("/api/docs", { cookie: p.cookie, body: { id: doc } });
    const { key } = await token(p.cookie, { metadata: { cap: "read" } });
    expect((await send(`/api/docs/${doc}`, { token: key })).body).toEqual({ level: "read" });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect((await send(`/api/docs/${doc}`, { token: key, method, body: {} })).status, method).toBe(403);
    }
    expect((await send("/api/docs", { token: key, body: { id: `x-${uid()}` } })).status).toBe(403);
    expect(ran.filter((r) => r.includes(doc) && r.startsWith("write"))).toEqual([]);
  });

  it("T4: every check gives a token at most its cap, even where its owner has more", async () => {
    const p = await person();
    const other = await person();
    const doc = `doc-${uid()}`;
    await send("/api/docs", { cookie: p.cookie, body: { id: doc } });
    const { key } = await token(p.cookie, { metadata: { cap: "write" } });
    expect((await send(`/api/docs/${doc}`, { token: key })).body).toEqual({ level: "write" });
    expect((await send(`/api/docs/${doc}`, { token: key, method: "PUT", body: {} })).status).toBe(200);
    expect((await send(`/api/docs/${doc}/share`, { token: key, body: { to: other.id } })).status).toBe(404);
    expect(ran).not.toContain(`share ${doc}`);
    expect((await send(`/api/docs/${doc}/share`, { cookie: p.cookie, body: { to: other.id } })).status).toBe(200);
    expect((await send("/api/manageable", { token: key })).body).toEqual([]);
  });

  it("T4: an endpoint's level with no point holds a token to its cap too", async () => {
    const p = await person();
    const create = (await token(p.cookie, { metadata: { cap: "create" } })).key;
    const del = (await token(p.cookie, { metadata: { cap: "delete" } })).key;
    expect((await send("/api/docs", { token: create, body: { id: `doc-${uid()}` } })).status).toBe(200);
    const refused = await send("/api/docs", { token: create, method: "DELETE", body: {} });
    expect(refused).toMatchObject({ status: 403, body: { error: "this API token is capped at create; this needs delete" } });
    expect(ran).not.toContain("clear");
    expect((await send("/api/docs", { token: del, method: "DELETE", body: {} })).status).toBe(200);
    expect((await send("/api/docs", { cookie: p.cookie, method: "DELETE", body: {} })).status).toBe(200);
  });

  it("T4: a cap never raises a level the owner does not have", async () => {
    const p = await person();
    const owner = await person();
    const doc = `doc-${uid()}`;
    await send("/api/docs", { cookie: owner.cookie, body: { id: doc } });
    const { key } = await token(p.cookie, { metadata: { cap: "manage" } });
    expect((await send(`/api/docs/${doc}`, { token: key })).status).toBe(404);
  });

  it("T5: the cap applies to organizations too", async () => {
    const p = await person();
    const org = await send("/api/platform/organizations", { cookie: p.cookie, body: { name: "Org" } });
    const write = (await token(p.cookie, { metadata: { cap: "write" } })).key;
    const read = (await token(p.cookie, { metadata: { cap: "read" } })).key;
    expect((await send(`/api/platform/organizations/${org.body.id}`, { token: read })).status).toBe(200);
    expect((await send(`/api/platform/organizations/${org.body.id}/invitations`, { token: write, body: { email: "x@example.com" } })).status).toBe(404);
    expect((await send(`/api/platform/organizations/${org.body.id}`, { token: write, method: "PATCH", body: { name: "Renamed" } })).status).toBe(200);
    expect((await send(`/api/platform/organizations/${org.body.id}`, { token: write, method: "DELETE" })).status).toBe(404);
    expect((await send(`/api/platform/organizations/${org.body.id}/invitations`, { cookie: p.cookie, body: { email: "x@example.com" } })).status).toBe(201);
    expect((await pool.query(`select 1 from access_point where id = $1`, [organizationPoint(org.body.id)])).rows).toHaveLength(1);
  });

  it("T6: a token is never accepted on /api/auth/*, so it cannot make tokens or touch the account", async () => {
    const p = await person();
    const { key } = await token(p.cookie);
    expect((await send("/api/auth/get-session", { token: key })).body).toBe(null);
    expect((await send("/api/auth/api-key/create", { token: key, body: { name: "more" } })).status).toBe(401);
    expect((await send("/api/auth/api-key/list", { token: key })).status).toBe(401);
    expect((await send("/api/auth/change-password", { token: key, body: { currentPassword: "a-long-password-1", newPassword: "another-password-2" } })).status).toBe(401);
    expect((await send("/api/auth/update-user", { token: key, body: { name: "Owned" } })).status).toBe(401);
    expect((await send("/api/me", { token: key, authorization: undefined })).body).toEqual({ id: p.id });
  });

  it("T7: an unknown, altered, expired or revoked token is a 401, even with a good cookie beside it", async () => {
    const p = await person();
    const { key, id } = await token(p.cookie);
    expect((await send("/api/me", { token: `${key}x` })).status).toBe(401);
    expect((await send("/api/me", { token: "pat_nothing" })).status).toBe(401);
    expect((await send("/api/me", { token: `${key}x`, cookie: p.cookie })).status).toBe(401);
    await pool.query(`update apikey set expires_at = now() - interval '1 second' where id = $1`, [id]);
    expect((await send("/api/me", { token: key })).status).toBe(401);
    const second = await token(p.cookie);
    expect((await send("/api/auth/api-key/delete", { cookie: p.cookie, body: { keyId: second.id } })).status).toBe(200);
    expect((await send("/api/me", { token: second.key })).status).toBe(401);
  });

  it("T8: with tokens off, a token is ignored and the token routes and screen are gone", async () => {
    const p = await person();
    const { key } = await token(p.cookie);
    const off = { AUTH_API_TOKENS: "off" };
    expect((await send("/api/me", { token: key, env: off })).status).toBe(401);
    expect((await send("/api/me", { token: key, cookie: p.cookie, env: off })).body).toEqual({ id: p.id });
    expect((await send("/api/auth/api-key/create", { cookie: p.cookie, body: { name: "x" }, env: off })).status).toBe(404);
    expect((await send("/api/auth/api-key/list", { cookie: p.cookie, env: off })).status).toBe(404);
    expect((await send("/tokens", { env: off })).status).toBe(404);
  });

  it("T9: tokens last 90 days unless set, at most 365, and never forever", async () => {
    const p = await person();
    const days = (iso: string) => (new Date(iso).getTime() - Date.now()) / 86_400_000;
    expect(days((await token(p.cookie)).expiresAt)).toBeCloseTo(90, 0);
    expect(days((await token(p.cookie, { expiresIn: null })).expiresAt)).toBeCloseTo(90, 0);
    expect(days((await token(p.cookie, { expiresIn: 7 * 86400 })).expiresAt)).toBeCloseTo(7, 0);
    expect(days((await token(p.cookie, { expiresIn: 365 * 86400 })).expiresAt)).toBeCloseTo(365, 0);
    expect((await send("/api/auth/api-key/create", { cookie: p.cookie, body: { name: "x", expiresIn: 366 * 86400 } })).status).toBe(400);
    expect((await send("/api/auth/api-key/create", { cookie: p.cookie, body: { name: "x", expiresIn: "forever" } })).status).toBe(400);
    expect((await send("/api/auth/api-key/update", { cookie: p.cookie, body: { keyId: uid(), expiresIn: null } })).status).toBe(404);
    expect(Number((await pool.query(`select count(*) from apikey where expires_at is null`)).rows[0].count)).toBe(0);
  });

  it("T10: making a token takes only a name, a lifetime and a cap", async () => {
    const p = await person();
    const victim = await person();
    const made = await token(p.cookie, { userId: victim.id, permissions: { all: ["*"] }, remaining: 1, rateLimitEnabled: true, metadata: { cap: "read", admin: true } });
    const row = (await pool.query(`select reference_id, permissions, remaining, metadata from apikey where id = $1`, [made.id])).rows[0];
    expect(row.reference_id).toBe(p.id);
    expect(row.permissions).toBe(null);
    expect(row.remaining).toBe(null);
    expect(JSON.parse(row.metadata)).toEqual({ cap: "read" });
    expect((await send("/api/auth/api-key/create", { cookie: p.cookie, body: { name: "x", metadata: { cap: "owner" } } })).status).toBe(400);
    expect((await send("/api/auth/api-key/create", { cookie: p.cookie, body: "[]" })).status).toBe(400);
    expect((await send("/api/auth/api-key/create", { cookie: p.cookie, body: {} })).status).toBe(400);
    expect((await send("/api/auth/api-key/create", { body: { name: "x" } })).status).toBe(401);
  });

  it("T11: people see and revoke only their own tokens", async () => {
    const a = await person();
    const b = await person();
    const theirs = await token(b.cookie);
    expect((await send("/api/auth/api-key/list", { cookie: a.cookie })).body.apiKeys).toEqual([]);
    await send("/api/auth/api-key/delete", { cookie: a.cookie, body: { keyId: theirs.id } });
    expect((await send("/api/me", { token: theirs.key })).body).toEqual({ id: b.id });
    expect((await send(`/api/auth/api-key/get?id=${theirs.id}`, { cookie: a.cookie })).status).toBe(404);
    for (const keyId of ["", "x", 7, null, uid()]) {
      expect((await send("/api/auth/api-key/delete", { cookie: a.cookie, body: { keyId } })).status, String(keyId)).toBe(404);
    }
    expect((await send("/api/auth/api-key/get?id=nope", { cookie: a.cookie })).status).toBe(404);
  });

  it("T12: a token whose owner is deleted, or whose cap was changed in the table, is a 401", async () => {
    const p = await person();
    const { key, id } = await token(p.cookie);
    await pool.query(`update apikey set metadata = '{"cap":"owner"}' where id = $1`, [id]);
    expect((await send("/api/me", { token: key })).status).toBe(401);
    const q = await person();
    const second = await token(q.cookie);
    await pool.query(`delete from "user" where id = $1`, [q.id]);
    expect((await send("/api/me", { token: second.key })).status).toBe(401);
  });

  it("T13: MCP accepts only OAuth tokens", async () => {
    const p = await person();
    const { key } = await token(p.cookie);
    const response = await send("/mcp", { token: key, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(response.status).toBe(401);
  });

  it("T14: a header that is not a bearer token is ignored", async () => {
    const p = await person();
    for (const authorization of ["Basic abc", "Bearer", "Bearer ", "bearer"]) {
      expect((await send("/api/me", { authorization, cookie: p.cookie })).body, authorization).toEqual({ id: p.id });
      expect((await send("/api/me", { authorization })).status, authorization).toBe(401);
    }
  });

  it("T15: the tokens screen is served to browsers", async () => {
    const screen = await send("/tokens");
    expect(screen.status).toBe(200);
    expect(String(screen.body)).toContain("API tokens");
    expect(String(screen.body)).toContain("/api/auth/api-key/create");
  });

  it("T16: a token request reads its key and owner in one query, and writes its last use at most hourly", async () => {
    const p = await person();
    const { key, id } = await token(p.cookie);
    const traced = async () => {
      const response = await app.fetch(new Request("https://app.test/api/me", { headers: { authorization: `Bearer ${key}` } }), env({ TRACE: "on" }) as never, ctx);
      return response.headers.get("server-timing") ?? "";
    };
    await traced();
    const lastUse = (await pool.query(`select last_request from apikey where id = $1`, [id])).rows[0].last_request;
    expect(lastUse).not.toBeNull();
    const timing = await traced();
    expect(timing).toContain('desc="1 queries"');
    expect(timing).not.toContain("update");
    expect((await pool.query(`select last_request from apikey where id = $1`, [id])).rows[0].last_request).toEqual(lastUse);
    await pool.query(`update apikey set last_request = now() - interval '2 hours' where id = $1`, [id]);
    await traced();
    expect((await pool.query(`select last_request from apikey where id = $1`, [id])).rows[0].last_request.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("T17: a disabled token, or one whose owner is banned, is refused; a lapsed ban is not", async () => {
    const p = await person();
    const { key, id } = await token(p.cookie);
    await pool.query(`update apikey set enabled = false where id = $1`, [id]);
    expect((await send("/api/me", { token: key })).status).toBe(401);
    await pool.query(`update apikey set enabled = true where id = $1`, [id]);
    await pool.query(`update "user" set banned = true where id = $1`, [p.id]);
    expect((await send("/api/me", { token: key })).status).toBe(401);
    await pool.query(`update "user" set ban_expires = now() - interval '1 minute' where id = $1`, [p.id]);
    expect(await send("/api/me", { token: key })).toMatchObject({ status: 200, body: { id: p.id } });
  });
});

