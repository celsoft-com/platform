import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDatabase } from "../../test/database.js";
import { defineApp, EndpointError, page, route } from "./index.js";
import { createRedirects } from "./redirects.js";

// Redirects as the app keeps them: read only when nothing else answers, just before the 404 page.

const { pool, url } = await freshDatabase();
const redirects = createRedirects(() => drizzle(pool) as never);
const app = defineApp(undefined, {
  pool: (connectionString) => new Pool({ connectionString, max: 2 }),
  pages: [
    page({
      path: "/p",
      routes: {
        "/*path": route({ access: "anon" }, ({ path }) => {
          if (path.startsWith("moved")) throw new EndpointError(404, "no such page");
          return "<h1>page</h1>";
        }),
      },
    }),
  ],
});
const env = { DB: { connectionString: url }, APP_URL: "https://app.test", APP_NAME: "test", FRONTEND: "files" };
const get = async (path: string, method = "GET") => {
  const response = await app.fetch(new Request(`https://app.test${path}`, { method, redirect: "manual" }), env as never, { waitUntil: () => {} });
  return { status: response.status, location: response.headers.get("location") };
};

beforeEach(async () => {
  await pool.query("delete from platform_redirect");
});

describe("redirects", () => {
  it("send a path nothing answers where it went, with its status and query", async () => {
    await redirects.set("/about", "/p/about");
    await redirects.set("/old-news", "/p/news", { status: 308 });
    expect(await get("/about?x=1")).toEqual({ status: 301, location: "/p/about?x=1" });
    expect(await get("/about/")).toEqual({ status: 301, location: "/p/about" });
    expect(await get("/old-news", "HEAD")).toEqual({ status: 308, location: "/p/news" });
    expect((await get("/elsewhere")).status).toBe(404);
  });

  it("move a whole folder with prefix, the longest one winning, and never part of a name", async () => {
    await redirects.set("/essay", "/p/essay", { prefix: true });
    await redirects.set("/essay/drafts", "/p/archive", { prefix: true });
    expect((await get("/essay/working-code")).location).toBe("/p/essay/working-code");
    expect((await get("/essay")).location).toBe("/p/essay");
    expect((await get("/essay/drafts/one")).location).toBe("/p/archive/one");
    expect((await get("/essays")).status).toBe(404);
  });

  it("reach a path inside a page claim whose page answers 404, never one whose page answers", async () => {
    await redirects.set("/p/moved/trip", "/p/journey");
    await redirects.set("/p/moved/folder", "/p/elsewhere", { prefix: true });
    expect(await get("/p/moved/trip")).toEqual({ status: 301, location: "/p/journey" });
    expect((await get("/p/moved/folder/a")).location).toBe("/p/elsewhere/a");
    expect((await get("/p/moved/other")).status).toBe(404);
  });

  it("never take a path something answers, nor POSTs", async () => {
    await redirects.set("/p/kept", "/p/elsewhere");
    expect((await get("/p/kept")).status).toBe(200);
    await redirects.set("/gone", "/p/gone");
    expect((await get("/gone", "POST")).status).not.toBe(301);
  });

  it("take an outside https address, and are listed, replaced and removed", async () => {
    await redirects.set("/talk", "https://video.example/talk");
    expect((await get("/talk")).location).toBe("https://video.example/talk");
    await redirects.set("/talk", "/p/talk", { status: 302 });
    expect(await redirects.list()).toEqual([{ from: "/talk", to: "/p/talk", status: 302, prefix: false }]);
    await redirects.remove("/talk");
    expect(await redirects.list()).toEqual([]);
    expect((await get("/talk")).status).toBe(404);
  });

  it("refuse what would loop, reach /api/, or is not a path", async () => {
    await expect(redirects.set("/a", "/a/")).rejects.toThrow(/loop/);
    await expect(redirects.set("/api/x", "/p/x")).rejects.toThrow(/\/api\//);
    await expect(redirects.set("/", "/p")).rejects.toThrow(/\//);
    await expect(redirects.set("about", "/p/about")).rejects.toThrow(/starting with \//);
    await expect(redirects.set("/a", "//evil.example")).rejects.toThrow(/https/);
    await expect(redirects.set("/a", "http://plain.example")).rejects.toThrow(/https/);
    await expect(redirects.set("/a", "/b", { status: 303 as never })).rejects.toThrow(/301/);
  });

  it("treat % and _ in a prefix literally", async () => {
    await redirects.set("/a_b", "/p/x", { prefix: true });
    expect((await get("/aXb/c")).status).toBe(404);
    expect((await get("/a_b/c")).location).toBe("/p/x/c");
  });
});
