import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { freshDatabase, world } from "../../test/database.js";
import { applyStaticPoints, organizationPoint, type Access, type Level } from "./access.js";
import { apiHandler, apiRoutes, endpoint, undeclaredAccess } from "./endpoints.js";
import { defineApp } from "./index.js";
import { serveMcp } from "./mcp-server.js";

// Endpoints, lists and the Worker's wiring: rows N1 onward of docs/access-rules.md.

const { db, pool, url } = await freshDatabase();
const w = world(db, pool);
const uid = () => randomUUID();

async function personal() {
  const owner = await w.user();
  const page = `page-${uid()}`;
  await w.as(owner).create(page);
  return { owner, page, as: w.as(owner) };
}

describe("Endpoints", () => {
  const Page = z.object({ id: z.string() });
  const ran: string[] = [];
  const endpoints = {
    readPage: endpoint({ method: "GET", path: "/api/pages/:id", input: Page, output: Page, access: { point: "id", level: "read" } }, ({ id }) => ({ id })),
    editPage: endpoint({ serve: ["api", "mcp"], method: "PUT", path: "/api/pages/:id", input: Page, output: Page, access: { point: "id", level: "write" } }, ({ id }) => {
      ran.push(id);
      return { id };
    }),
    orgName: endpoint(
      { method: "GET", path: "/api/orgs/:org", input: z.object({ org: z.string() }), output: z.object({ org: z.string() }), access: { point: ({ org }) => organizationPoint(org), level: "read" } },
      ({ org }) => ({ org }),
    ),
    open: endpoint({ method: "GET", path: "/api/open", input: z.object({}), output: z.object({ ok: z.boolean() }), access: { level: "read" } }, () => ({ ok: true })),
  };
  const api = apiHandler(endpoints)!;
  const call = async (access: Access, method: string, path: string) => {
    const response = await api.handle(new Request(`https://app.test${path}`, { method, headers: { "content-type": "application/json" }, ...(method !== "GET" && { body: "{}" }) }), { access });
    return { status: response!.status, body: await response!.json() };
  };

  it("N1: the caller has the declared level: the function runs", async () => {
    const { as, page } = await personal();
    expect(await call(as, "PUT", `/api/pages/${page}`)).toEqual({ status: 200, body: { id: page } });
    expect(ran).toContain(page);
  });

  it("N2: the caller has less: 404, and the function never runs", async () => {
    const { as, page } = await personal();
    const reader = await w.user();
    await as.grant(page, { user: reader }, "read");
    expect(await call(w.as(reader), "GET", `/api/pages/${page}`)).toMatchObject({ status: 200 });
    expect(await call(w.as(reader), "PUT", `/api/pages/${page}`)).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(ran).not.toContain(page);
  });

  it("N3: a point that does not exist: the same 404 as no access", async () => {
    const { as, page } = await personal();
    const stranger = w.as(await w.user());
    expect(await call(as, "GET", `/api/pages/${uid()}`)).toEqual(await call(stranger, "GET", `/api/pages/${page}`));
  });

  it("N4: an MCP call gets the same checks, and a refusal is a tool error saying not found", async () => {
    const { as, page } = await personal();
    const mcp = async (access: Access) => {
      const request = new Request("https://app.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "editPage", arguments: { id: page } } }),
      });
      return ((await (await serveMcp(request, { access }, "test", endpoints)).json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };
    expect(await mcp(as)).toEqual({ content: [{ type: "text", text: JSON.stringify({ id: page }) }] });
    expect(await mcp(w.as(await w.user()))).toEqual({ isError: true, content: [{ type: "text", text: "not found" }] });
  });

  it("N6: a point can be worked out from the input", async () => {
    const admin = await w.user();
    const { id } = await w.org(admin);
    expect(await call(w.as(admin), "GET", `/api/orgs/${id}`)).toEqual({ status: 200, body: { org: id } });
    expect((await call(w.as(await w.user()), "GET", `/api/orgs/${id}`)).status).toBe(404);
  });

  it("N7: access { level } runs with no point check for anyone signed in, and is a 404 to no one", async () => {
    const request = () => new Request("https://app.test/api/open");
    const signedIn = await api.handle(request(), { access: w.as(null), session: async () => ({ user: {} }) });
    expect({ status: signedIn!.status, body: await signedIn!.json() }).toEqual({ status: 200, body: { ok: true } });
    expect((await api.handle(request(), { access: w.as(null), session: async () => null }))!.status).toBe(404);
  });

  it("N9: an endpoint's access is checked when it is defined", () => {
    const input = z.object({ id: z.string() });
    expect(() => endpoint({ method: "GET", path: "/api/x", input, output: Page, access: { point: "pageId", level: "read" } }, () => ({ id: "" }))).toThrow(/pageId/);
    expect(() => endpoint({ method: "GET", path: "/api/x", input, output: Page, access: { point: "id", level: "owner" as Level } }, () => ({ id: "" }))).toThrow(/unknown access level/);
    expect(() => endpoint({ method: "GET", path: "/api/x", input, output: Page, access: "all" as never }, () => ({ id: "" }))).toThrow(/\{ level \} or "anon"/);
    expect(() => endpoint({ method: "GET", path: "/api/x", input, output: Page, access: "user" as never }, () => ({ id: "" }))).toThrow(/the endpoint at \/api\/x's access "user" is now \{ level \}/);
    expect(() => endpoint({ method: "GET", path: "/api/x", input, output: Page, access: { point: 7, level: "read" } as never }, () => ({ id: "" }))).toThrow(/function/);
  });

  it("N10: a point id the input cannot give is a 404, never a server error", async () => {
    const weird = apiHandler({
      fromInput: endpoint(
        { method: "GET", path: "/api/weird", input: z.object({ id: z.string().optional() }), output: Page, access: { point: ({ id }) => id as string, level: "read" } },
        () => ({ id: "" }),
      ),
    })!;
    const as = w.as(await w.user());
    for (const query of ["", "?id=", `?id=${"x".repeat(201)}`]) {
      const response = await weird.handle(new Request(`https://app.test/api/weird${query}`), { access: as });
      expect(response!.status, query).toBe(404);
    }
  });

  it("N11: anon endpoints live under /api/public/ and { level } endpoints never do", () => {
    const signedIn = { level: "read" } as const;
    const e = (path: string, access: "anon" | typeof signedIn) => endpoint({ method: "GET", path, input: z.object({}), output: Page, access }, () => ({ id: "" }));
    expect(() => apiRoutes({ a: e("/api/notes", "anon") })).toThrow(/under \/api\/public\//);
    expect(() => apiRoutes({ a: e("/api/public/notes", signedIn) })).toThrow(/make it "anon"/);
    expect(Object.keys(apiRoutes({ a: e("/api/public/notes", "anon"), b: e("/api/notes", signedIn) }))).toEqual(["a", "b"]);
  });

  it("undeclared access lists only the endpoints that say nothing", () => {
    expect(undeclaredAccess({ a: { access: { level: "read" } }, b: {}, c: { access: { point: "id", level: "read" } } })).toEqual(["b"]);
  });
});

describe("Lists", () => {
  it("N5: readable and allows list exactly what single checks allow", async () => {
    const admin = await w.user();
    const { id: org } = await w.org(admin);
    const [member, outsider] = [await w.user(), await w.user()];
    await w.member(org, member);
    const as = w.as(admin);
    await w.query(`create table if not exists docs (id text primary key)`);
    const ids = Array.from({ length: 10 }, () => `doc-${uid()}`);
    for (const [i, id] of ids.entries()) {
      await w.query(`insert into docs (id) values ($1)`, [id]);
      await as.create(id, { parent: i % 3 === 0 ? undefined : organizationPoint(org), inherit: i % 2 === 0 });
    }
    await as.grant(ids[1]!, { user: outsider }, "write");
    await as.grant(ids[2]!, { everyone: true }, "read");
    await as.grant(ids[3]!, { user: member }, "delete");
    await as.grant(ids[4]!, { organization: org }, "create");
    const { token } = await as.link(ids[5]!, "create");
    await w.query(`insert into docs (id) values ($1)`, [`doc-${uid()}`]);
    for (const caller of [admin, member, outsider, null]) {
      for (const link of [null, token]) {
        const access = w.as(caller, link);
        for (const level of ["read", "create", "write", "delete", "manage"] as Level[]) {
          const filter = level === "read" ? await access.readable(sql`docs.id`) : await access.allows(level, sql`docs.id`);
          const listed = (await db.execute(sql`select id from docs where ${filter} and id in ${ids} order by id`)).rows.map((r) => r.id);
          const single = [];
          for (const id of [...ids].sort()) if (await access.can(id, level)) single.push(id);
          expect(listed, `${caller} ${link} ${level}`).toEqual(single);
        }
      }
    }
  });
});

describe("Wiring", () => {
  const nonce = uid();
  const declared = `declared-${nonce}`;
  const app = defineApp(undefined, {
    access: { points: { [declared]: { grants: [{ to: { everyone: true }, level: "read" }] } } },
    endpoints: {
      readPage: endpoint(
        { method: "GET", path: "/api/public/pages/:id", input: z.object({ id: z.string() }), output: z.object({ level: z.string().nullable() }), access: { point: "id", level: "read" } },
        async ({ id }, a) => ({ level: await a.access.level(id) }),
      ),
    },
    pool: (connectionString) => new Pool({ connectionString, max: 1 }),
  });
  const ctx = { waitUntil: () => {} };
  const get = async (path: string, headers: Record<string, string>, access = "on") => {
    const response = await app.fetch(new Request(`https://app.test${path}`, { headers }), { DB: { connectionString: url }, ACCESS: access }, ctx).catch((e: Error) => e);
    return response instanceof Response ? { status: response.status, body: await response.json() } : response.message;
  };

  it("N11: reads a link token from the x-access-link header, never from the query", async () => {
    const { as, page } = await personal();
    const { token } = await as.link(page, "write");
    expect(await get(`/api/public/pages/${page}`, { "x-access-link": token })).toEqual({ status: 200, body: { level: "write" } });
    expect(await get(`/api/public/pages/${page}`, {})).toMatchObject({ status: 404 });
    expect(await get(`/api/public/pages/${page}?link=${token}`, {})).toMatchObject({ status: 404 });
  });

  it("N12: refuses app.access when the app has not turned access on", async () => {
    const { page } = await personal();
    expect(await get(`/api/public/pages/${page}`, {}, "off")).toMatchObject({ status: 500 });
  });

  it("S1: the app's static points are read by the deploy, and a request never writes them", async () => {
    expect(app.staticPoints).toEqual({ [declared]: { grants: [{ to: { everyone: true }, level: "read" }] } });
    expect(await get(`/api/public/pages/${declared}`, {})).toMatchObject({ status: 404 });
    await applyStaticPoints(db, app.staticPoints);
    expect(await get(`/api/public/pages/${declared}`, {})).toEqual({ status: 200, body: { level: "read" } });
  });

  it("N8: an endpoint that says nothing about access stops the app at start, with access on or off", () => {
    const careless = () =>
      defineApp(() => new Response("ok"), {
        endpoints: { forgot: endpoint({ method: "GET", path: "/api/public/forgot", input: z.object({}), output: z.object({}) }, () => ({})) },
      });
    expect(careless).toThrow(/endpoint forgot declare no access; add access: \{ level: "read" \}/);
  });
});

describe("Wiring with auth", () => {
  const app = defineApp(undefined, { pool: (connectionString) => new Pool({ connectionString, max: 2 }) });
  const env = { DB: { connectionString: url }, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret", AUTH_SIGNUP: "open", APP_URL: "https://app.test", APP_NAME: "test", ACCESS: "on", AUTH_ORGANIZATIONS: "on", EMAIL_MODE: "capture" as const };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };
  const send = async (path: string, init: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", origin: "https://app.test" };
    if (init.cookie) headers.cookie = init.cookie;
    const response = await app.fetch(new Request(`https://app.test${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) }), env, ctx);
    return { status: response.status, body: await response.json().catch(() => null), cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  };
  const signUp = async () => (await send("/api/auth/sign-up/email", { method: "POST", body: { name: "Pat", email: `${uid()}@example.com`, password: "a-long-password-1" } })).cookie;

  it("O17: a signed-in person makes and lists organizations through the Worker", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const cookie = await signUp();
    expect(cookie).toContain("session_token");
    const created = await send("/api/platform/organizations", { method: "POST", body: { name: "Wired" }, cookie });
    expect(created.status).toBe(201);
    expect((await send("/api/platform/organizations", { cookie })).body.map((o: { id: string }) => o.id)).toEqual([created.body.id]);
    const stranger = await signUp();
    expect((await send(`/api/platform/organizations/${created.body.id}`, { cookie: stranger })).status).toBe(404);
    expect((await send(`/api/platform/organizations/${created.body.id}/invitations`, { method: "POST", body: { email: "new@example.com" }, cookie })).status).toBe(201);
    await Promise.all(pending);
    expect(log.mock.calls.some(([line]) => String(line).includes("to=new@example.com") && String(line).includes("/login?invitation="))).toBe(true);
    log.mockRestore();
  });

  it("O17: organization routes refuse a signed-out caller and a cross-site form", async () => {
    expect((await send("/api/platform/organizations")).status).toBe(401);
    const form = await app.fetch(
      new Request("https://app.test/api/platform/organizations", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" }, body: "name=x" }),
      env,
      ctx,
    );
    expect(form.status).toBe(403);
  });
});
