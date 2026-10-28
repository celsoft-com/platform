import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { freshDatabase } from "../../test/database.js";
import { defineApp, EndpointError, page, route } from "./index.js";
import { hashToken } from "./access.js";
import { pageServer } from "./pages.js";
import { REMEMBER_MS } from "./cache.js";

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
    "/:id/session": async (_, app) => `<p>${JSON.stringify(await app.session())}</p>`,
    "/:id/level": async ({ id }, app) => `<p>${await app.access.level(id)}</p>`,
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

  it("P5: a route never declares access, since every visitor sees a page identically", () => {
    for (const access of ["none", { point: "id", level: "read" }]) {
      expect(() => page({ path: "/x", routes: { "/:id": route({ access } as never, () => "") } }), JSON.stringify(access)).toThrow(/drop access/);
    }
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

  it("P16: a page cannot ask who is looking: session, requireUser and access all throw, naming the route", async () => {
    for (const [path, asked] of [["/notes/1/me", "requireUser"], ["/notes/1/session", "session"], ["/notes/1/level", "access"]]) {
      await expect(get(path!), path).rejects.toThrow(new RegExp(`page /notes/:id/${path!.split("/")[3]} asked app\\.${asked}`));
    }
  });

  it("P17: pages are not served cached", async () => {
    const response = await app.fetch(new Request("https://app.test/notes"), {}, ctx);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("Pages: beside sign-in, links and tokens", () => {
  const NoteId = z.object({ id: z.string() });
  // A page every visitor sees the same, beside an endpoint that answers the caller's own level.
  const wired = defineApp(async (request, app) => {
    const id = new URL(request.url).searchParams.get("id");
    return id ? Response.json({ level: await app.access.check(id) }) : new Response("handler");
  }, {
    pool: (connectionString) => new Pool({ connectionString, max: 2 }),
    pages: [page({ path: "/doc", routes: { "/:id": route({ params: NoteId }, ({ id }) => `<h1>${id}</h1>`), "/open/door": () => "<p>open</p>" } })],
    endpoints: {},
  });
  const env = { DB: { connectionString: databaseUrl }, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret", AUTH_SIGNUP: "open", APP_URL: "https://app.test", APP_NAME: "test", ACCESS: "on", AUTH_API_TOKENS: "on", EMAIL_MODE: "capture" as const };
  const send = async (path: string, init: { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", origin: "https://app.test", ...init.headers };
    if (init.cookie) headers.cookie = init.cookie;
    const response = await wired.fetch(new Request(`https://app.test${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) }), env, ctx);
    return { status: response.status, location: response.headers.get("location"), text: await response.text(), cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; "), setCookie: response.headers.getSetCookie() };
  };
  const level = async (id: string, init: { cookie?: string; headers?: Record<string, string> } = {}) => {
    const answer = await send(`/api/public/check?id=${encodeURIComponent(id)}`, init);
    return answer.status === 200 ? (JSON.parse(answer.text) as { level: string }).level : answer.status;
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

  it("P18: with access on, pages need no declaration and serve every visitor the same", async () => {
    const id = await point(await signUp());
    const signedOut = await send(`/doc/${id}`);
    expect(signedOut).toMatchObject({ status: 200, text: `<h1>${id}</h1>` });
    expect(await send(`/doc/${id}`, { cookie: await signUp() })).toMatchObject({ status: 200, text: signedOut.text });
    expect(await send("/doc/open/door")).toMatchObject({ status: 200, text: "<p>open</p>" });
  });

  it("P20: the API still answers 401, never a redirect", async () => {
    expect((await send("/api/anything")).status).toBe(401);
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

  it("P29: a link cookie counts signed out, at its own level only", async () => {
    const id = await point(await signUp());
    expect(await level(id, { cookie: (await exchange((await link(id, 1)).token)).cookie })).toBe("read");
    expect(await level(id, { cookie: (await exchange((await link(id, 3)).token)).cookie })).toBe("write");
  });

  it("P30: a link cookie opens nothing but its own point, and an altered one opens nothing", async () => {
    const a = await point(await signUp());
    const b = await point(await signUp());
    const cookie = (await exchange((await link(a, 3)).token)).cookie;
    expect(await level(b, { cookie })).toBe(404);
    const [name, value] = cookie.split("=");
    expect(await level(a, { cookie: `${name}=${value}x` })).toBe(404);
    expect(await level(a, { cookie: `other_${name}=${value}` })).toBe(404);
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
    expect(await level(id, { cookie: kept.cookie })).toBe(404);
  });

  it("P32: revoking a link closes its cookie on the next request", async () => {
    const id = await point(await signUp());
    const made = await link(id, 1);
    const cookie = (await exchange(made.token)).cookie;
    expect(await level(id, { cookie })).toBe("read");
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    await pool.query(`delete from access_link where id = $1`, [made.id]);
    await pool.end();
    expect(await level(id, { cookie })).toBe(404);
  });

  it("P33: several link cookies each open their own point, up to twenty per request", async () => {
    const ids = await Promise.all([1, 2, 3].map(async () => point(await signUp())));
    const cookies = await Promise.all(ids.map(async (id) => (await exchange((await link(id, 1)).token)).cookie));
    for (const id of ids) expect(await level(id, { cookie: cookies.join("; ") }), id).toBe("read");
    const filler = Array.from({ length: 20 }, (_, i) => `platform_link_${String(i).padStart(16, "0")}=tok-nothing-${i}`);
    expect(await level(ids[0]!, { cookie: [...filler, cookies[0]].join("; ") })).toBe(404);
  });

  it("P34: a link cookie counts beside the header, and the higher level wins", async () => {
    const id = await point(await signUp());
    const cookie = (await exchange((await link(id, 1)).token)).cookie;
    const write = await link(id, 3);
    expect(await level(id, { cookie, headers: { "x-access-link": write.token } })).toBe("write");
    expect(await level(id)).toBe(404);
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

  it("P37: an API token is only looked at on the API, never on pages or other paths", async () => {
    const owner = await signUp();
    const made = await send("/api/auth/api-key/create", { method: "POST", cookie: owner, body: { name: "elsewhere" } });
    const key = JSON.parse(made.text).key as string;
    for (const path of ["/login", "/elsewhere", "/doc/open/door"]) {
      const answer = await wired.fetch(new Request(`https://app.test${path}`, { headers: { authorization: `Bearer ${key}x` } }), env, ctx);
      expect(answer.status, path).not.toBe(401);
    }
    expect((await wired.fetch(new Request("https://app.test/api/public/check?id=x", { headers: { authorization: `Bearer ${key}x` } }), env, ctx)).status).toBe(401);
  });

  it("R10: leaving an organization in a request forgets the levels it found earlier in that request", async () => {
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

  it("Q1: with a fresh session cookie, knowing who is calling costs no query, and a page asks nothing about the caller", async () => {
    const cookie = await signUp();
    const traced = { ...env, TRACE: "on" };
    const whoami = defineApp(async (_req, app) => Response.json({ id: (await app.requireUser()).id }), { pool: (c) => new Pool({ connectionString: c, max: 2 }) });
    await whoami.fetch(new Request("https://app.test/api/me", { headers: { cookie } }), traced, ctx);
    const answer = await whoami.fetch(new Request("https://app.test/api/me", { headers: { cookie } }), traced, ctx);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("server-timing")).toContain('db-all;dur=0.0;desc="0 queries"');
    const page = await wired.fetch(new Request("https://app.test/doc/open/door", { headers: { cookie } }), traced, ctx);
    expect(page.headers.get("server-timing")).toContain('desc="0 queries"');
  });

  it("U1: the rate limit counts a signed-in person by their id, and a token by the token", async () => {
    const keys: string[] = [];
    const API_LIMIT = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: true }) };
    const cookie = await signUp();
    const session = await wired.fetch(new Request("https://app.test/api/auth/get-session", { headers: { cookie } }), env, ctx);
    const { user } = (await session.json()) as { user: { id: string } };
    await wired.fetch(new Request("https://app.test/doc/open/door", { headers: { cookie } }), { ...env, API_LIMIT }, ctx);
    const made = await send("/api/auth/api-key/create", { method: "POST", cookie, body: { name: "limited" } });
    const key = JSON.parse(made.text).key as string;
    await wired.fetch(new Request("https://app.test/api/public/check?id=x", { headers: { authorization: `Bearer ${key}` } }), { ...env, API_LIMIT }, ctx);
    expect(keys[0]).toBe(user.id);
    expect(keys[1]).toMatch(/^token [0-9a-f]{32}$/);
    expect(keys[1]).not.toContain(key);
  });
});

describe("Pages: caching", () => {
  const edge = new Map<string, Response>();
  (globalThis as { caches?: unknown }).caches = {
    default: {
      match: async (key: string) => edge.get(key)?.clone(),
      put: async (key: string, response: Response) => void edge.set(key, response),
    },
  };
  let runs = 0;
  const cached = defineApp(() => new Response("handler"), {
    pages: [
      page({
        path: "/news",
        routes: {
          "/": route({ cache: true }, () => `<h1>news ${++runs}</h1>`),
          "/cookie": route({ cache: { seconds: 60 } }, () => new Response("<p>set</p>", { headers: { "content-type": "text/html", "set-cookie": "a=1" } })),
          "/gone": route({ cache: { seconds: 60 } }, () => {
            throw new EndpointError(410, "gone");
          }),
        },
      }),
    ],
  });
  const env = (id = "v1") => ({ CF_VERSION_METADATA: { id } });
  const visit = async (path: string, init: RequestInit = {}, version = "v1") => {
    const response = await cached.fetch(new Request(`https://app.test${path}`, init), env(version), ctx);
    return { status: response.status, state: response.headers.get("platform-cache"), cacheControl: response.headers.get("cache-control"), body: await response.text() };
  };

  it("P38: any route may be cached, for 1 to 3600 whole seconds", () => {
    for (const seconds of [0, 1.5, 3601]) expect(() => page({ path: "/a", routes: { "/": route({ cache: { seconds } }, () => "") } }), String(seconds)).toThrow(/cache.seconds/);
    expect(() => page({ path: "/a", routes: { "/": route({ cache: { seconds: 3600 } }, () => "") } })).not.toThrow();
    expect(() => page({ path: "/a", routes: { "/": route({ cache: true }, () => "") } })).not.toThrow();
  });

  it("P39: a visitor's answer is kept, and the next visitor gets it without the handler running; browsers keep nothing", async () => {
    edge.clear();
    runs = 0;
    expect(await visit("/news")).toEqual({ status: 200, state: "miss", cacheControl: "no-store", body: "<h1>news 1</h1>" });
    expect(await visit("/news")).toEqual({ status: 200, state: "hit", cacheControl: "no-store", body: "<h1>news 1</h1>" });
    expect(runs).toBe(1);
    expect([...edge.values()][0]!.headers.get("cache-control")).toBe("public, max-age=60");
  });

  it("P40: signed in, with a link or with a token, a visitor gets the same kept copy as everyone", async () => {
    edge.clear();
    runs = 0;
    await visit("/news");
    for (const headers of [{ cookie: "__Secure-better-auth.session_token=abc" }, { cookie: "theme=dark; platform_link_0123456789abcdef=t" }, { "x-access-link": "t" }, { authorization: "Bearer t" }]) {
      expect((await visit("/news", { headers })).state, JSON.stringify(headers)).toBe("hit");
    }
    expect(runs).toBe(1);
  });

  it("P41: errors, answers that set a cookie, and HEAD are never kept", async () => {
    edge.clear();
    expect((await visit("/news/gone")).status).toBe(410);
    expect((await visit("/news/cookie")).state).toBeNull();
    expect((await visit("/news", { method: "HEAD" })).state).toBeNull();
    expect(edge.size).toBe(0);
  });

  it("P42: each deploy starts with nothing kept, and each query string is kept apart", async () => {
    edge.clear();
    runs = 0;
    await visit("/news");
    expect((await visit("/news", {}, "v2")).state).toBe("miss");
    expect((await visit("/news?page=2")).state).toBe("miss");
    expect((await visit("/news?page=2")).state).toBe("hit");
    expect(runs).toBe(3);
  });

  it("P44: with a database, invalidating a page or clearing the app empties it, and a missing version table only skips the cache", async () => {
    edge.clear();
    runs = 0;
    const dbEnv = { CF_VERSION_METADATA: { id: "v1" }, DB: { connectionString: databaseUrl } };
    const hit = async (path: string) => (await cached.fetch(new Request(`https://app.test${path}`), dbEnv, ctx)).headers.get("platform-cache");
    const later = () => new Promise((r) => setTimeout(r, REMEMBER_MS + 50));
    const app = defineApp(async (_req, a) => {
      const [kind, path] = new URL(_req.url).searchParams.getAll("do");
      if (kind === "clear") await a.cache.clear();
      else await a.cache.invalidate(path!);
      return new Response("done");
    });
    const run = (kind: string, path = "") => app.fetch(new Request(`https://app.test/x?do=${kind}&do=${encodeURIComponent(path)}`), dbEnv, ctx);
    expect(await hit("/news")).toBe("miss");
    expect(await hit("/news")).toBe("hit");
    await run("invalidate", "/news");
    await later();
    expect(await hit("/news")).toBe("miss");
    expect(await hit("/news?page=3")).toBe("miss");
    expect(await hit("/news")).toBe("hit");
    await run("clear");
    await later();
    expect(await hit("/news")).toBe("miss");
    await expect(app.fetch(new Request("https://app.test/x?do=invalidate&do=news"), dbEnv, ctx)).rejects.toThrow(/path with no query/);
    const bare = new URL(databaseUrl);
    bare.pathname = "/postgres";
    const missing = { CF_VERSION_METADATA: { id: "v1" }, DB: { connectionString: bare.href } };
    await later();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await cached.fetch(new Request("https://app.test/news?nodb=1"), missing, ctx)).headers.get("platform-cache")).toBeNull();
    error.mockRestore();
  });

  it("P43: without a deploy version, as in tests and local tools, pages run as before", async () => {
    edge.clear();
    const response = await cached.fetch(new Request("https://app.test/news"), {}, ctx);
    expect(response.headers.get("platform-cache")).toBeNull();
    expect(edge.size).toBe(0);
  });
});
