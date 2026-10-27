import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
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

    expect(await (await app.fetch(new Request("https://x/"), env, ctx)).text()).toBe("ok");
    await settle();
    expect(calls).toEqual(["end"]);
  });

  it("never connects when the handler skips the database", async () => {
    let opened = 0;
    const app = defineApp(ok, { pool: () => (opened++, fakePool().pool) });
    await app.fetch(new Request("https://x/"), env, fakeCtx().ctx);
    expect(opened).toBe(0);
  });

  it("still closes the database when the handler throws", async () => {
    const { pool, calls } = fakePool();
    const { ctx, settle } = fakeCtx();
    const app = defineApp((_req, app) => {
      void app.db;
      throw new Error("boom");
    }, { pool: () => pool });

    await expect(app.fetch(new Request("https://x/"), env, ctx)).rejects.toThrow("boom");
    await settle();
    expect(calls).toEqual(["end"]);
  });

  it("explains a missing database", async () => {
    const app = defineApp((_req, app) => (void app.db, ok()));
    await expect(app.fetch(new Request("https://x/"), {}, fakeCtx().ctx)).rejects.toThrow(/platform\.jsonc/);
  });

  it("sends a thrown Response as the answer", async () => {
    const app = defineApp(() => {
      throw new Response("nope", { status: 418 });
    });
    expect((await app.fetch(new Request("https://x/"), {}, fakeCtx().ctx)).status).toBe(418);
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
    expect((await call("/about")).status).toBe(200);
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
    const timing = (await app.fetch(new Request("https://x/"), { ...env, TRACE: "on" }, fakeCtx().ctx)).headers.get("server-timing");
    expect(timing).toMatch(/^total;dur=[\d.]+, db-all;dur=[\d.]+;desc="1 queries", db-1;dur=[\d.]+;desc="select access_point,access_grant"$/);
  });

  it("without it, sends no timing", async () => {
    expect((await app.fetch(new Request("https://x/"), env, fakeCtx().ctx)).headers.get("server-timing")).toBeNull();
  });
});
