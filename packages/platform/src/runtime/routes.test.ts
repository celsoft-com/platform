import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineApp, endpoint, page } from "./index.js";
import { features, PLATFORM_PATHS, RESERVED, servedFiles, workerFirst } from "./routes.js";

const ctx = { waitUntil: () => {} };
const ALL_ON = { AUTH_SIGNUP: "invite", AUTH_API_TOKENS: "on", LIVE_ROOMS: "on", MCP: "on" };

// app.routes as a handler sees it, for a request with these vars.
async function routesOf(app: { fetch(r: Request, env: never, c: typeof ctx): Promise<Response> }, env: object) {
  const response = await app.fetch(new Request("https://app.test/api/routes"), env as never, ctx);
  return (await response.json()) as Record<string, string | null>;
}

const probe = ["/login", "/invites", "/tokens", "/api/auth/get-session", "/api/live/x", "/mcp", "/.well-known/x", "/notes/7", "/notes/7/nope", "/api/notes/7", "/api/notes", "/about", "/about.html", "/docs", "/", "/nope", "/notes/7?x=1#y"];

function testedApp() {
  const app = defineApp(
    (request, a) => Response.json(new URL(request.url).pathname === "/api/routes" ? Object.fromEntries(probe.map((p) => [p, a.routes.serves(p)])) : null),
    {
      pages: [page({ path: "/notes", routes: { "/:id": () => "note" } })],
      endpoints: {
        getNote: endpoint({ method: "GET", path: "/api/notes/:id", input: z.object({ id: z.string() }), output: z.object({}), access: { level: "read" } }, () => ({})),
        addNote: endpoint({ method: "POST", path: "/api/notes", input: z.object({}), output: z.object({}), access: { level: "create" } }, () => ({})),
      },
    },
  );
  app.staticFiles = ["index.html", "about.html", "docs/index.html", "assets/app.js"];
  return app;
}

describe("Routes: serves", () => {
  it("R1: names what answers each GET: platform paths that are on, pages, GET endpoints, then files", async () => {
    const served = await routesOf(testedApp(), { ...ALL_ON, FRONTEND: "files" });
    expect(served).toEqual({
      "/login": "platform",
      "/invites": "platform",
      "/tokens": "platform",
      "/api/auth/get-session": "platform",
      "/api/live/x": "platform",
      "/mcp": "platform",
      "/.well-known/x": "platform",
      "/notes/7": "page",
      "/notes/7/nope": null,
      "/api/notes/7": "endpoint",
      "/api/notes": null,
      "/about": "file",
      "/about.html": "file",
      "/docs": "file",
      "/": "file",
      "/nope": null,
      "/notes/7?x=1#y": "page",
    });
  });

  it("R2: platform paths that are off are not served, and with spa an unknown path is the fallback", async () => {
    const served = await routesOf(testedApp(), { FRONTEND: "spa" });
    expect(served["/login"]).toBe("fallback");
    expect(served["/mcp"]).toBe("fallback");
    expect(served["/api/auth/get-session"]).toBeNull();
    expect(served["/nope"]).toBe("fallback");
    expect((await routesOf(testedApp(), {}))["/about"]).toBeNull();
  });

  it("R3: a frontend file answers its path, and html files also answer without .html or index.html", () => {
    expect(servedFiles(["index.html", "a/index.html", "b.html", "c.png"])).toEqual(["/", "/a", "/a/", "/a/index.html", "/b", "/b.html", "/c.png", "/index.html"]);
  });
});

describe("Routes: one list of platform paths", () => {
  it("R4: the Worker gets /api/* and each platform path that is on before static files", () => {
    expect(workerFirst(features({}))).toEqual(["/api/*"]);
    expect(workerFirst(features(ALL_ON))).toEqual(["/api/*", "/login", "/signup", "/forgot", "/reset", "/consent", "/invites", "/tokens", "/mcp", "/.well-known/*"]);
  });

  it("R5: pages may claim none of them, and the skill names every one", async () => {
    expect(RESERVED).toEqual(["/api", "/login", "/signup", "/forgot", "/reset", "/consent", "/invites", "/tokens", "/mcp", "/.well-known"]);
    for (const path of RESERVED) expect(() => page({ path, routes: { "/": () => "" } }), path).toThrow(/platform answers itself/);
    const skill = await readFile(new URL("../../skills/celsoft-platform/SKILL.md", import.meta.url), "utf8");
    const line = skill.split("\n").find((l) => l.startsWith("1. **Paths:**"))!;
    for (const path of RESERVED) expect(line, path).toContain(`\`${path}\``);
    expect(PLATFORM_PATHS.length).toBeGreaterThan(RESERVED.length - 1);
  });
});
