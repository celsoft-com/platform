import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { defineApp, EndpointError } from "./index.js";

function fakePool() {
  const calls: string[] = [];
  const pool = { end: async () => void calls.push("end") } as unknown as Pool;
  return { pool, calls };
}

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending) };
}

const env = { DB: { connectionString: "postgres://db" } };
const authEnv = { ...env, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret", APP_URL: "https://app.example.com", APP_NAME: "demo" };
const ok = () => new Response("ok");

describe("defineApp", () => {
  it("opens the database only when used and closes it after the response", async () => {
    const { pool, calls } = fakePool();
    const { ctx, settle } = fakeCtx();
    const app = defineApp((_req, app) => (void app.db, ok()), { pool: () => pool });

    expect(await (await app.fetch(new Request("https://x/api/x"), env, ctx)).text()).toBe("ok");
    await settle();
    expect(calls).toEqual(["end"]);
  });

  it("never connects when the handler skips the database", async () => {
    let opened = 0;
    const app = defineApp(ok, { pool: () => (opened++, fakePool().pool) });
    await app.fetch(new Request("https://x/api/x"), env, fakeCtx().ctx);
    expect(opened).toBe(0);
  });

  it("still closes the database when the handler throws", async () => {
    const { pool, calls } = fakePool();
    const { ctx, settle } = fakeCtx();
    const app = defineApp((_req, app) => {
      void app.db;
      throw new Error("boom");
    }, { pool: () => pool });

    await expect(app.fetch(new Request("https://x/api/x"), env, ctx)).rejects.toThrow("boom");
    await settle();
    expect(calls).toEqual(["end"]);
  });

  it("explains a missing database", async () => {
    const app = defineApp((_req, app) => (void app.db, ok()));
    await expect(app.fetch(new Request("https://x/api/x"), {}, fakeCtx().ctx)).rejects.toThrow(/platform\.jsonc/);
  });

  it("sends a thrown Response as the answer", async () => {
    const app = defineApp(() => {
      throw new Response("nope", { status: 418 });
    });
    expect((await app.fetch(new Request("https://x/api/x"), {}, fakeCtx().ctx)).status).toBe(418);
  });

  it("answers a thrown EndpointError with its status, as endpoints do", async () => {
    const app = defineApp(() => {
      throw new EndpointError(404, "not found");
    });
    const response = await app.fetch(new Request("https://x/api/thing"), {}, fakeCtx().ctx);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
  });

  it("refuses a form posted from another site", async () => {
    const app = defineApp(ok);
    const post = (origin?: string) =>
      new Request("https://x/api/thing", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...(origin && { origin }) }, body: "a=1" });
    expect((await app.fetch(post("https://evil.example"), {}, fakeCtx().ctx)).status).toBe(403);
    expect((await app.fetch(post(), {}, fakeCtx().ctx)).status).toBe(403);
    expect((await app.fetch(post("https://x"), {}, fakeCtx().ctx)).status).toBe(200);
  });
});

describe("with auth", () => {
  const app = defineApp(ok, { pool: () => fakePool().pool, screens: { stylesheet: "/auth.css" } });
  const call = (path: string, init?: RequestInit, extra = {}) => app.fetch(new Request(`https://app.example.com${path}`, init), { ...authEnv, ...extra }, fakeCtx().ctx);

  it("asks for sign-in on private API routes and lets public ones through", async () => {
    expect((await call("/api/notes")).status).toBe(401);
    expect((await call("/api/public/status")).status).toBe(200);
    const missing = await call("/about");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('href="/login?next=%2Fabout"');
  });

  it("serves the sign-in screens with the app's stylesheet after the default", async () => {
    const response = await call("/login");
    const html = await response.text();
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('<h1 class="platform-title">Sign in</h1>');
    expect(html.indexOf("<style>")).toBeLessThan(html.indexOf('href="/auth.css"'));
  });

  it("hides organization routes unless organizations are on", async () => {
    expect((await call("/api/platform/organizations", undefined, { AUTH_ORGANIZATIONS: "off" })).status).toBe(404);
  });

  it("asks for sign-in on organization routes", async () => {
    expect((await call("/api/platform/organizations", undefined, { AUTH_ORGANIZATIONS: "on" })).status).toBe(401);
  });

  it("leaves Better Auth's own organization routes unserved", async () => {
    const response = await call("/api/auth/organization/create", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, { AUTH_ORGANIZATIONS: "on" });
    expect(response.status).toBe(404);
  });

  it("answers 429 once the rate limit is spent", async () => {
    const keys: string[] = [];
    const AUTH_LIMIT = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    const response = await call("/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "A@B.com", password: "x" }) }, { AUTH_LIMIT });
    expect(response.status).toBe(429);
    expect(keys).toEqual(["/api/auth/sign-in/email:a@b.com"]);
  });
});

describe("tracing", () => {
  const pool = { query: async () => ({ rows: [], fields: [] }), end: async () => {} } as unknown as Pool;
  const app = defineApp(async (_req, a) => {
    await a.db.execute(sql`select 1 from access_point join access_grant on true`);
    return new Response("ok");
  }, { pool: () => pool });

  it("with TRACE on, says where the time went in Server-Timing, each query by its verb and tables", async () => {
    const timing = (await app.fetch(new Request("https://x/api/x"), { ...env, TRACE: "on" }, fakeCtx().ctx)).headers.get("server-timing");
    expect(timing).toMatch(/^total;dur=[\d.]+, db-all;dur=[\d.]+;desc="1 queries", db-1;dur=[\d.]+;desc="select access_point,access_grant"$/);
  });

  it("without it, sends no timing", async () => {
    expect((await app.fetch(new Request("https://x/api/x"), env, fakeCtx().ctx)).headers.get("server-timing")).toBeNull();
  });

  it("sampled in prod, logs one request in a hundred and never sends the timing", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const random = vi.spyOn(Math, "random").mockReturnValue(0.001);
    const response = await app.fetch(new Request("https://x/api/notes"), { ...env, TRACE: "sample" }, fakeCtx().ctx);
    expect(response.headers.get("server-timing")).toBeNull();
    expect(JSON.parse(logged.mock.calls[0]![0] as string)).toMatchObject({ method: "GET", path: "/api/notes", status: 200, timing: expect.stringMatching(/^total;dur=/) });
    random.mockReturnValue(0.5);
    await app.fetch(new Request("https://x/api/notes"), { ...env, TRACE: "sample" }, fakeCtx().ctx);
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
    random.mockRestore();
  });
});

describe("rate limit", () => {
  const app = defineApp(ok, { pages: [] });
  const limiter = (allow: (key: string) => boolean) => {
    const keys: string[] = [];
    return { keys, API_LIMIT: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: allow(key) }) } };
  };

  it("limits each caller on the API, by address when signed out, and answers 429 with a wait", async () => {
    const { keys, API_LIMIT } = limiter(() => false);
    const response = await app.fetch(new Request("https://x/api/things", { headers: { "cf-connecting-ip": "203.0.113.7" } }), { API_LIMIT }, fakeCtx().ctx);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual(["address 203.0.113.7"]);
  });

  it("never counts static paths, and lets callers under the limit through", async () => {
    const { keys, API_LIMIT } = limiter(() => true);
    expect((await app.fetch(new Request("https://x/api/things"), { API_LIMIT }, fakeCtx().ctx)).status).toBe(200);
    expect((await app.fetch(new Request("https://x/about.html"), { API_LIMIT: limiter(() => false).API_LIMIT }, fakeCtx().ctx)).status).toBe(404);
    expect(keys).toHaveLength(1);
  });

  describe("with API tokens", () => {
    const queries: string[] = [];
    const pool = { query: async (q: { text?: string } | string) => (queries.push(typeof q === "string" ? q : (q.text ?? "")), { rows: [], fields: [] }), end: async () => {} } as unknown as Pool;
    const tokens = defineApp(ok, { pool: () => pool });
    const tokenEnv = { ...authEnv, AUTH_API_TOKENS: "on" };
    const send = (API_LIMIT: unknown, token: string, ip = "198.51.100.4") =>
      tokens.fetch(new Request("https://app.example.com/api/things", { headers: { authorization: `Bearer ${token}`, "cf-connecting-ip": ip } }), { ...tokenEnv, API_LIMIT }, fakeCtx().ctx);

    it("refuses a token over its own limit before looking it up", async () => {
      queries.length = 0;
      const { keys, API_LIMIT } = limiter(() => false);
      expect((await send(API_LIMIT, "spent")).status).toBe(429);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/^token /);
      expect(queries).toEqual([]);
    });

    it("charges a bad token to its sender's address, and once that is spent refuses the address's tokens unseen", async () => {
      const { keys, API_LIMIT } = limiter((key) => key.startsWith("token "));
      expect((await send(API_LIMIT, "fake-1", "198.51.100.9")).status).toBe(401);
      expect(keys.at(-1)).toBe("address 198.51.100.9");
      queries.length = 0;
      keys.length = 0;
      expect((await send(API_LIMIT, "fake-2", "198.51.100.9")).status).toBe(429);
      expect(keys).toEqual([]);
      expect(queries).toEqual([]);
      expect((await send(API_LIMIT, "fake-3", "198.51.100.10")).status).toBe(401);
    });
  });
});
