import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { freshDatabase } from "../../test/database.js";
import { defineApp, EndpointError, page, route } from "./index.js";
import { hashToken } from "./access.js";
import { pageServer } from "./pages.js";

const { url: databaseUrl } = await freshDatabase();
const ctx = { waitUntil: () => {} };
const uid = () => randomUUID();

const notes = page({
  path: "/notes",
  routes: {
    "/": () => "<h1>all notes</h1>",
    "/new": () => "<h1>new note</h1>",
    "/:id": ({ id }) => `<h1>note ${id}</h1>`,
    "/:id/edit": route({ params: z.object({ id: z.coerce.number().int().positive() }) }, ({ id }) => `<h1>edit ${id + 1}</h1>`),
    "/:id/away": () => Response.redirect("https://app.test/notes", 303),
    "/:id/gone": () => {
      throw new EndpointError(410, "this note <was> removed");
    },
    "/:id/me": async (_, app) => `<p>${(await app.requireUser()).id}</p>`,
  },
});

const app = defineApp(() => new Response("handler"), { pages: [notes, page({ path: "/docs/guide", routes: { "/": () => "guide" } })] });

const get = async (path: string, init?: RequestInit, env: object = {}) => {
  const response = await app.fetch(new Request(`https://app.test${path}`, init), env, ctx);
  return { status: response.status, type: response.headers.get("content-type"), location: response.headers.get("location"), body: await response.text() };
};

describe("Pages: declaring", () => {
  it("P1: a page path is plain segments, never a parameter, a trailing slash or the root", () => {
    for (const path of ["/", "", "notes", "/notes/", "/:id", "/notes/*", "/a//b", "/a/../b", "/a b"]) {
      expect(() => page({ path, routes: { "/": () => "" } }), path).toThrow(/page path/);
    }
  });

  it("P2: paths the platform answers itself cannot be claimed", () => {
    for (const path of ["/api", "/api/things", "/login", "/tokens", "/mcp", "/.well-known/x", "/consent"]) {
      expect(() => page({ path, routes: { "/": () => "" } }), path).toThrow(/platform answers itself/);
    }
    expect(() => page({ path: "/apis", routes: { "/": () => "" } })).not.toThrow();
  });

  it("P3: routes are / or segments of text and :name, each name once", () => {
    for (const key of ["", "id", "/:id/", "/:", "/:1x", "/a b", "/..", "/:id/:id"]) {
      expect(() => page({ path: "/x", routes: { [key]: () => "" } }), key).toThrow();
    }
    expect(() => page({ path: "/x", routes: {} })).toThrow(/no routes/);
    expect(() => page({ path: "/x", routes: { "/": "html" as never } })).toThrow(/function or route/);
  });

  it("P4: a params schema must have every :name in the route", () => {
    expect(() => page({ path: "/x", routes: { "/:id": route({ params: z.object({ other: z.string() }) }, () => "") } })).toThrow(/:id/);
  });

  it("P5: access names a parameter the route has, at a known level", () => {
    expect(() => page({ path: "/x", routes: { "/:id": route({ access: { point: "nope", level: "read" } }, () => "") } })).toThrow(/nope/);
    expect(() => page({ path: "/x", routes: { "/:id": route({ access: { point: "id", level: "owner" as never } }, () => "") } })).toThrow(/unknown access level/);
    expect(() => page({ path: "/x", routes: { "/": route({ access: "all" as never }, () => "") } })).toThrow(/"none"/);
    expect(() => page({ path: "/x", routes: { "/:id": route({ access: { point: "id", level: "read" } }, () => "") } })).not.toThrow();
  });

  it("P6: two pages never claim the same or nested paths, and one page never has two routes for the same paths", () => {
    const a = page({ path: "/notes", routes: { "/": () => "" } });
    expect(() => pageServer([a, page({ path: "/notes", routes: { "/": () => "" } })])).toThrow(/overlapping/);
    expect(() => pageServer([a, page({ path: "/notes/archive", routes: { "/": () => "" } })])).toThrow(/overlapping/);
    expect(() => pageServer([page({ path: "/notes/archive", routes: { "/": () => "" } }), a])).toThrow(/overlapping/);
    expect(() => pageServer([a, page({ path: "/Notes", routes: { "/": () => "" } })])).toThrow(/overlapping/);
    expect(() => pageServer([a, page({ path: "/notebook", routes: { "/": () => "" } })])).not.toThrow();
    expect(() => pageServer([page({ path: "/x", routes: { "/:a": () => "", "/:b": () => "" } })])).toThrow(/same paths/);
  });

  it("P7: the app lists its claimed paths for the deploy", () => {
    expect(app.pages).toEqual(["/notes", "/docs/guide"]);
    expect(defineApp(undefined).pages).toEqual([]);
  });
});

describe("Pages: serving", () => {
  it("P8: the claimed path itself, with or without a trailing slash, is the / route as HTML", async () => {
    for (const path of ["/notes", "/notes/"]) {
      expect(await get(path)).toMatchObject({ status: 200, type: "text/html; charset=utf-8", body: "<h1>all notes</h1>" });
    }
    expect(await get("/docs/guide")).toMatchObject({ status: 200, body: "guide" });
  });

  it("P9: text segments win over parameters, and parameters arrive decoded", async () => {
    expect((await get("/notes/new")).body).toBe("<h1>new note</h1>");
    expect((await get("/notes/a%20b")).body).toBe("<h1>note a b</h1>");
    expect((await get("/notes/a%2Fb")).body).toBe("<h1>note a/b</h1>");
  });

  it("P10: a params schema converts parameters, and a value it refuses is a 404", async () => {
    expect((await get("/notes/41/edit")).body).toBe("<h1>edit 42</h1>");
    for (const path of ["/notes/abc/edit", "/notes/-1/edit", "/notes/1.5/edit"]) expect((await get(path)).status, path).toBe(404);
  });

  it("P11: a path under the claim that no route matches is a 404 page, never the handler or a static file", async () => {
    for (const path of ["/notes/1/2/3", "/notes/1/unknown", "/notes//edit", "/notes/%E0%A4%A/edit", "/docs/guide/more"]) {
      expect(await get(path), path).toMatchObject({ status: 404, type: "text/html; charset=utf-8" });
    }
  });

  it("P12: paths outside every claim go on to the handler, including look-alikes", async () => {
    for (const path of ["/", "/notebook", "/notes.html", "/docs", "/docs/guidebook", "/NOTES"]) expect((await get(path)).body, path).toBe("handler");
  });

  it("P13: pages only answer GET and HEAD; HEAD has no body", async () => {
    const post = await get("/notes", { method: "POST", headers: { origin: "https://app.test", "content-type": "application/json" }, body: "{}" });
    expect(post.status).toBe(405);
    const head = await get("/notes/7", { method: "HEAD" });
    expect(head).toMatchObject({ status: 200, body: "", type: "text/html; charset=utf-8" });
  });

  it("P14: a returned Response is sent as it is", async () => {
    expect(await get("/notes/1/away")).toMatchObject({ status: 303, location: "https://app.test/notes" });
  });

  it("P15: a thrown EndpointError is an HTML page with its status, its message escaped", async () => {
    const gone = await get("/notes/1/gone");
    expect(gone).toMatchObject({ status: 410, type: "text/html; charset=utf-8" });
    expect(gone.body).toContain("this note &#60;was&#62; removed");
    expect(gone.body).not.toContain("<was>");
  });

  it("P16: without auth, requireUser on a page is a 401 as before", async () => {
    expect((await get("/notes/1/me")).status).toBe(401);
  });

  it("P17: pages are not served cached", async () => {
    const response = await app.fetch(new Request("https://app.test/notes"), {}, ctx);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Pages: sign-in and access", () => {
  const ran: string[] = [];
  const NoteId = z.object({ id: z.string() });
  const wired = defineApp(undefined, {
    pool: (connectionString) => new Pool({ connectionString, max: 2 }),
    pages: [
      page({
        path: "/doc",
        routes: {
          "/:id": route({ params: NoteId, access: { point: "id", level: "read" } }, ({ id }) => (ran.push(id), `<h1>${id}</h1>`)),
          "/:id/edit": route({ params: NoteId, access: { point: ({ id }) => id, level: "write" } }, ({ id }) => `<h1>edit ${id}</h1>`),
          "/mine/list": route({ access: "none" }, async (_, app) => `<p>${(await app.requireUser()).email}</p>`),
          "/open/door": route({ access: "none" }, () => "<p>open</p>"),
        },
      }),
    ],
    endpoints: {},
  });
  const env = { DB: { connectionString: databaseUrl }, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret", APP_URL: "https://app.test", APP_NAME: "test", ACCESS: "on", AUTH_API_TOKENS: "on", EMAIL_MODE: "capture" as const };
  const send = async (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", origin: "https://app.test", ...init.headers };
    if (init.cookie) headers.cookie = init.cookie;
    const response = await wired.fetch(new Request(`https://app.test${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) }), env, ctx);
    return { status: response.status, location: response.headers.get("location"), text: await response.text(), cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), setCookie: response.headers.getSetCookie() };
  };
  const signUp = async () => (await send("/api/auth/sign-up/email", { method: "POST", body: { name: "Pat", email: `${uid()}@example.com`, password: "a-long-password-1" } })).cookie;
  const point = async (cookie: string) => {
    const id = `doc-${uid()}`;
    const session = await wired.fetch(new Request("https://app.test/api/auth/get-session", { headers: { cookie } }), env, ctx);
    const { user } = (await session.json()) as { user: { id: string } };
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`insert into access_point (id) values ($1)`, [id]);
    await pool.query(`insert into access_grant (point_id, user_id, level) values ($1, $2, 5)`, [id, user.id]);
    await pool.end();
    return id;
  };

  it("P18: signed out, requireUser on a page redirects to /login and back, keeping the query", async () => {
    const answer = await send("/doc/mine/list?tab=2&x=%2F");
    expect(answer.status).toBe(302);
    expect(answer.location).toBe(`/login?next=${encodeURIComponent("/doc/mine/list?tab=2&x=%2F")}`);
  });

  it("P19: signed in, requireUser on a page shows it", async () => {
    const cookie = await signUp();
    expect(await send("/doc/mine/list", { cookie })).toMatchObject({ status: 200, text: expect.stringContaining("@example.com") });
  });

  it("P20: the API still answers 401, never a redirect", async () => {
    expect((await send("/api/anything")).status).toBe(401);
  });

  it("P21: the owner reads and edits; a page's access is checked before its handler", async () => {
    const owner = await signUp();
    const id = await point(owner);
    expect(await send(`/doc/${id}`, { cookie: owner })).toMatchObject({ status: 200, text: `<h1>${id}</h1>` });
    expect(await send(`/doc/${id}/edit`, { cookie: owner })).toMatchObject({ status: 200 });
    expect(ran).toContain(id);
  });

  it("P22: signed in without access, the page is a 404 and its handler never runs", async () => {
    const id = await point(await signUp());
    const stranger = await signUp();
    expect(await send(`/doc/${id}`, { cookie: stranger })).toMatchObject({ status: 404, location: null });
    expect(await send(`/doc/missing-${uid()}`, { cookie: stranger })).toMatchObject({ status: 404 });
    expect(ran).not.toContain(id);
  });

  it("P23: signed out without access, a page answers one 404 for points that exist and those that do not, offering sign-in", async () => {
    const id = await point(await signUp());
    const real = await send(`/doc/${id}`);
    const missing = await send(`/doc/${id.replace(/^doc-/, "doc-0")}`);
    expect(real).toMatchObject({ status: 404, location: null });
    expect(real.text).toContain(`/login?next=${encodeURIComponent(`/doc/${id}`)}`);
    expect(real.text).toContain("/api/platform/link");
    expect(missing.status).toBe(404);
    expect(missing.text.replaceAll(id.replace(/^doc-/, "doc-0"), "X")).toBe(real.text.replaceAll(id, "X"));
    expect(ran).not.toContain(id);
  });

  it("P24: a reader may open the read route but not the write route", async () => {
    const owner = await signUp();
    const id = await point(owner);
    const reader = await signUp();
    const session = await wired.fetch(new Request("https://app.test/api/auth/get-session", { headers: { cookie: reader } }), env, ctx);
    const { user } = (await session.json()) as { user: { id: string } };
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`insert into access_grant (point_id, user_id, level) values ($1, $2, 1)`, [id, user.id]);
    await pool.end();
    expect((await send(`/doc/${id}`, { cookie: reader })).status).toBe(200);
    expect((await send(`/doc/${id}/edit`, { cookie: reader })).status).toBe(404);
  });

  it("P25: an access: none route serves anyone", async () => {
    expect(await send("/doc/open/door")).toMatchObject({ status: 200, text: "<p>open</p>" });
  });

  it("P26: a signed-in person refused a page gets a 404 with no sign-in offer", async () => {
    const id = await point(await signUp());
    const answer = await send(`/doc/${id}`, { cookie: await signUp() });
    expect(answer.status).toBe(404);
    expect(answer.text).not.toContain("/login");
  });

  it("P27: with access on, a page route that declares nothing stops the app with a 500 and a log naming it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const careless = defineApp(undefined, { pages: [page({ path: "/x", routes: { "/:id": () => "open" } })] });
    expect((await careless.fetch(new Request("https://app.test/x/1"), { ACCESS: "on" }, ctx)).status).toBe(500);
    expect(error.mock.calls.flat().join(" ")).toContain("page /x/:id");
    expect((await careless.fetch(new Request("https://app.test/x/1"), { ACCESS: "off" }, ctx)).status).toBe(200);
    error.mockRestore();
  });

  // A link straight into the tables, as app.access.link makes one.
  const link = async (id: string, level: number, expires: Date | null = null) => {
    const token = `tok-${uid()}`;
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const row = (await pool.query(`insert into access_link (point_id, token_hash, level, expires_at) values ($1, $2, $3, $4) returning id`, [id, await hashToken(token), level, expires])).rows[0];
    await pool.end();
    return { token, id: row.id as string };
  };
  const exchange = (token: unknown, init: { headers?: Record<string, string> } = {}) => send("/api/platform/link", { method: "POST", body: { link: token }, ...init });

  it("P28: a valid link becomes an HttpOnly, same-site cookie; anything else is a 404 with no cookie", async () => {
    const id = await point(await signUp());
    const { token } = await link(id, 1);
    const kept = await exchange(token);
    expect(kept.status).toBe(200);
    expect(kept.setCookie).toHaveLength(1);
    expect(kept.setCookie[0]).toMatch(/^platform_link_[0-9a-f]{16}=tok-[^;]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/);
    expect(Number(/Max-Age=(\d+)/.exec(kept.setCookie[0]!)![1])).toBeLessThanOrEqual(30 * 86400);
    for (const bad of [`${token}x`, "", 7, null, "x".repeat(500)]) {
      const refused = await exchange(bad);
      expect(refused.status, String(bad)).toBe(404);
      expect(refused.setCookie).toEqual([]);
    }
    expect((await send("/api/platform/link")).status).toBe(404);
  });

  it("P29: a link cookie opens its page signed out, at its own level only", async () => {
    const id = await point(await signUp());
    const { token } = await link(id, 1);
    const cookie = (await exchange(token)).cookie;
    expect(await send(`/doc/${id}`, { cookie })).toMatchObject({ status: 200, text: `<h1>${id}</h1>` });
    expect((await send(`/doc/${id}/edit`, { cookie })).status).toBe(404);
    const write = (await exchange((await link(id, 3)).token)).cookie;
    expect((await send(`/doc/${id}/edit`, { cookie: write })).status).toBe(200);
  });

  it("P30: a link cookie opens nothing but its own point, and an altered one opens nothing", async () => {
    const a = await point(await signUp());
    const b = await point(await signUp());
    const cookie = (await exchange((await link(a, 3)).token)).cookie;
    expect((await send(`/doc/${b}`, { cookie })).status).toBe(404);
    const [name, value] = cookie.split("=");
    expect((await send(`/doc/${a}`, { cookie: `${name}=${value}x` })).status).toBe(404);
    expect((await send(`/doc/${a}`, { cookie: `other_${name}=${value}` })).status).toBe(404);
  });

  it("P31: an expired link is never kept, and a kept one stops when it expires", async () => {
    const id = await point(await signUp());
    expect((await exchange((await link(id, 1, new Date(Date.now() - 1000))).token)).status).toBe(404);
    const soon = await link(id, 1, new Date(Date.now() + 3600_000));
    const kept = await exchange(soon.token);
    expect(Number(/Max-Age=(\d+)/.exec(kept.setCookie[0]!)![1])).toBeLessThanOrEqual(3600);
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`update access_link set expires_at = now() - interval '1 second' where id = $1`, [soon.id]);
    await pool.end();
    expect((await send(`/doc/${id}`, { cookie: kept.cookie })).status).toBe(404);
  });

  it("P32: revoking a link closes its cookie on the next request", async () => {
    const id = await point(await signUp());
    const made = await link(id, 1);
    const cookie = (await exchange(made.token)).cookie;
    expect((await send(`/doc/${id}`, { cookie })).status).toBe(200);
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`delete from access_link where id = $1`, [made.id]);
    await pool.end();
    expect((await send(`/doc/${id}`, { cookie })).status).toBe(404);
  });

  it("P33: several link cookies each open their own point, up to twenty per request", async () => {
    const ids = await Promise.all([1, 2, 3].map(async () => point(await signUp())));
    const cookies = await Promise.all(ids.map(async (id) => (await exchange((await link(id, 1)).token)).cookie));
    for (const id of ids) expect((await send(`/doc/${id}`, { cookie: cookies.join("; ") })).status, id).toBe(200);
    const filler = Array.from({ length: 20 }, (_, i) => `platform_link_${String(i).padStart(16, "0")}=tok-nothing-${i}`);
    expect((await send(`/doc/${ids[0]}`, { cookie: [...filler, cookies[0]].join("; ") })).status).toBe(404);
  });

  it("P34: a link cookie counts on hand-written routes and endpoints too, beside the header", async () => {
    const id = await point(await signUp());
    const cookie = (await exchange((await link(id, 1)).token)).cookie;
    const access = defineApp(async (_req, app) => Response.json({ level: await app.access.check(id) }), { pool: (c) => new Pool({ connectionString: c, max: 2 }) });
    const ask = (headers: Record<string, string>) => access.fetch(new Request("https://app.test/api/public/check", { headers }), env, ctx);
    expect(await (await ask({ cookie })).json()).toEqual({ level: "read" });
    const write = await link(id, 3);
    expect(await (await ask({ cookie, "x-access-link": write.token })).json()).toEqual({ level: "write" });
    expect((await ask({})).status).toBe(404);
  });

  it("P35: a link cannot be kept from another site's form, or with access off", async () => {
    const id = await point(await signUp());
    const { token } = await link(id, 1);
    const forged = await wired.fetch(new Request("https://app.test/api/platform/link", { method: "POST", headers: { "content-type": "text/plain", origin: "https://evil.test" }, body: JSON.stringify({ link: token }) }), env, ctx);
    expect(forged.status).toBe(403);
    expect(forged.headers.getSetCookie()).toEqual([]);
    const off = await wired.fetch(new Request("https://app.test/api/platform/link", { method: "POST", headers: { "content-type": "application/json", origin: "https://app.test" }, body: JSON.stringify({ link: token }) }), { ...env, ACCESS: "off" }, ctx);
    expect(off.status).toBe(404);
  });

  it("P36: an API token reads pages as its owner, capped, and a bad one is a 401", async () => {
    const owner = await signUp();
    const id = await point(owner);
    const made = await send("/api/auth/api-key/create", { method: "POST", cookie: owner, body: { name: "pages", metadata: { cap: "read" } } });
    const key = JSON.parse(made.text).key as string;
    const bearer = (k: string) => ({ headers: { authorization: `Bearer ${k}` } });
    expect(await send(`/doc/${id}`, bearer(key))).toMatchObject({ status: 200, text: `<h1>${id}</h1>` });
    expect((await send(`/doc/${id}/edit`, bearer(key))).status).toBe(404);
    expect((await send("/doc/mine/list", bearer(key))).status).toBe(200);
    expect((await send(`/doc/${id}`, bearer(`${key}x`))).status).toBe(401);
    expect((await send(`/doc/${id}`, { method: "HEAD", ...bearer(key) })).status).toBe(200);
  });

  it("P37: an API token is never accepted on paths outside the API and pages", async () => {
    const owner = await signUp();
    const made = await send("/api/auth/api-key/create", { method: "POST", cookie: owner, body: { name: "elsewhere" } });
    const key = JSON.parse(made.text).key as string;
    for (const path of ["/login", "/elsewhere"]) {
      const answer = await wired.fetch(new Request(`https://app.test${path}`, { headers: { authorization: `Bearer ${key}x` } }), env, ctx);
      expect(answer.status, path).not.toBe(401);
    }
  });

  it("M10: leaving an organization in a request forgets the levels it found earlier in that request", async () => {
    const cookie = await signUp();
    const created = await wired.fetch(
      new Request("https://app.test/api/platform/organizations", { method: "POST", headers: { "content-type": "application/json", origin: "https://app.test", cookie }, body: JSON.stringify({ name: "Leave" }) }),
      { ...env, AUTH_ORGANIZATIONS: "on" },
      ctx,
    );
    const org = ((await created.json()) as { id: string }).id;
    const joiner = await signUp();
    const session = await wired.fetch(new Request("https://app.test/api/auth/get-session", { headers: { cookie: joiner } }), env, ctx);
    const { user } = (await session.json()) as { user: { id: string } };
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`insert into member (organization_id, user_id) values ($1, $2)`, [org, user.id]);
    await pool.end();
    const leaving = defineApp(
      async (_req, app) => {
        const before = await app.access.level(`organization:${org}`);
        await app.organizations.removeMember(org, (await app.requireUser()).id);
        return Response.json({ before, after: await app.access.level(`organization:${org}`) });
      },
      { pool: (c) => new Pool({ connectionString: c, max: 2 }) },
    );
    const answer = await leaving.fetch(new Request("https://app.test/api/leave", { headers: { cookie: joiner } }), { ...env, AUTH_ORGANIZATIONS: "on" }, ctx);
    expect(await answer.json()).toEqual({ before: "read", after: null });
  });

  it("Q1: with a fresh session cookie, knowing who is calling costs no query, and a page read costs its own queries only", async () => {
    const cookie = await signUp();
    const traced = { ...env, TRACE: "on" };
    const whoami = defineApp(async (_req, app) => Response.json({ id: (await app.requireUser()).id }), { pool: (c) => new Pool({ connectionString: c, max: 2 }) });
    await whoami.fetch(new Request("https://app.test/api/me", { headers: { cookie } }), traced, ctx);
    const answer = await whoami.fetch(new Request("https://app.test/api/me", { headers: { cookie } }), traced, ctx);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("server-timing")).toContain('db-all;dur=0.0;desc="0 queries"');
    const id = await point(cookie);
    const page = await wired.fetch(new Request(`https://app.test/doc/${id}`, { headers: { cookie } }), traced, ctx);
    expect(page.headers.get("server-timing")).toMatch(/desc="1 queries"/);
  });

  it("R1: the rate limit counts a signed-in person by their id, and a token by the token", async () => {
    const keys: string[] = [];
    const API_LIMIT = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    const cookie = await signUp();
    const session = await wired.fetch(new Request("https://app.test/api/auth/get-session", { headers: { cookie } }), env, ctx);
    const { user } = (await session.json()) as { user: { id: string } };
    await wired.fetch(new Request("https://app.test/doc/mine/list", { headers: { cookie } }), { ...env, API_LIMIT }, ctx);
    const made = await send("/api/auth/api-key/create", { method: "POST", cookie, body: { name: "limited" } });
    const key = JSON.parse(made.text).key as string;
    await wired.fetch(new Request("https://app.test/doc/mine/list", { headers: { authorization: `Bearer ${key}` } }), { ...env, API_LIMIT }, ctx);
    expect(keys[0]).toBe(user.id);
    expect(keys[1]).toMatch(/^token [0-9a-f]{32}$/);
    expect(keys[1]).not.toContain(key);
  });
});

