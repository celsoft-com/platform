import { beforeEach, describe, expect, test } from "vitest";
import { appRoute, githubEvent, type AppContext } from "./app-routes.ts";
import type { App } from "./apps.ts";
import { MemoryApps } from "./memory-apps.ts";
import type { InstanceRecord, Store, Viewer } from "./setup.ts";

const RECORD: InstanceRecord = { state: "claimed", email: "ann@example.com", account: "acct", script: "platform", authDomain: "t", aud: "a", admins: ["pat@example.com"] };
const CONFIG = JSON.stringify({ name: "pages", worker: "src/worker.ts", compatibilityDate: "2026-10-01", secrets: ["STRIPE_KEY"] });
// A secret whose characters can only appear in a reply if it leaked.
const SECRET = "Zq9wX3rV6uK1oP4aS7dJ";

const SUPER: Viewer = { email: "ann@example.com", role: "super" };
const PLATFORM: Viewer = { email: "pat@example.com", role: "platform" };
const BOB: Viewer = { email: "bob@example.com", role: "app" };

let apps: MemoryApps;
let policy: string[];
let scripts: string[];

const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const ok = (result: unknown) => Response.json({ success: true, result });
  if (url.host === "api.cloudflare.com") {
    if (url.pathname.endsWith("/workers/scripts")) return ok(scripts.map((id) => ({ id })));
    if (url.pathname.startsWith("/client/v4/zones")) return ok([{ id: "z1", name: "acme.dev" }]);
    if (url.pathname.endsWith("/access/policies") || url.pathname.includes("/access/policies?")) return ok([{ id: "p1", name: "platform super admin" }]);
    if (url.pathname.endsWith("/access/policies/p1")) {
      if (init?.method === "PUT") policy = (JSON.parse(String(init.body)) as { include: { email: { email: string } }[] }).include.map((i) => i.email.email);
      return ok({ id: "p1", name: "platform super admin", include: policy.map((email) => ({ email: { email } })) });
    }
  }
  if (url.host === "api.github.com") {
    if (url.pathname === "/repos/celsoft-com/pages") return Response.json({ id: 7, name: "pages", private: false, default_branch: "main", owner: { login: "celsoft-com", id: 1 } });
    if (url.pathname.endsWith("/contents/platform.jsonc")) return new Response(CONFIG);
    if (url.pathname.endsWith("/releases/latest") || url.pathname.endsWith("/installation")) return new Response(null, { status: 404 });
  }
  throw new Error(`unexpected ${url}`);
}) as typeof fetch;

let record: InstanceRecord;
const store: Store = { get: async () => record, put: async (r) => void (record = r) };

const ctx = (): AppContext => ({
  store,
  apps,
  self: { version: "v", host: "platform.acme.workers.dev" },
  secrets: { CLOUDFLARE_API_TOKEN: "cf" },
  fetcher,
});

const call = async (who: Viewer, route: string, body?: unknown) => {
  const request = new Request("https://platform.acme.workers.dev/admin/api/apps", body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
  const response = await appRoute(request, route, who, ctx());
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as Record<string, any>, text };
};

const app = (name: string, over: Partial<App> = {}): App => ({
  name,
  repo: { owner: "celsoft-com", ownerId: 1, name: "pages", id: 7, private: false, defaultBranch: "main" },
  dir: "",
  address: `${name}.acme.dev`,
  zone: { id: "z1", name: "acme.dev" },
  admins: [],
  build: {},
  updates: "push",
  resources: {},
  previews: [],
  addedBy: "ann@example.com",
  addedAt: "",
  ...over,
});

beforeEach(() => {
  apps = new MemoryApps();
  record = structuredClone(RECORD);
  policy = ["ann@example.com", "pat@example.com"];
  scripts = ["platform"];
});

describe("adding an app", () => {
  const add = { repo: "https://github.com/celsoft-com/pages", name: "pages", address: "pages.acme.dev", admins: "bob@example.com", updates: "branch" };

  test("reads the repo, keeps the app, lets its admins in, and queues its first deploy", async () => {
    const { status, body } = await call(PLATFORM, "add", add);
    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
    expect(apps.apps.get("pages")).toMatchObject({ address: "pages.acme.dev", zone: { id: "z1" }, admins: ["bob@example.com"], updates: "branch", addedBy: "pat@example.com" });
    expect(policy).toEqual(["ann@example.com", "pat@example.com", "bob@example.com"]);
    expect(apps.queued).toEqual([expect.objectContaining({ app: "pages", kind: "deploy", target: { kind: "prod" }, ref: "main" })]);
  });

  test("shows what the app needs before it is added", async () => {
    const { body } = await call(PLATFORM, "inspect", { repo: "celsoft-com/pages" });
    expect(body).toMatchObject({ name: "pages", installed: false, zones: ["acme.dev"], needs: ["A Worker", "Secret STRIPE_KEY"], updates: "branch" });
    expect(body.warnings).toEqual([expect.stringContaining("sets name")]);
  });

  test("refuses an address outside the account's domains, one another app overlaps, and a Worker name already taken", async () => {
    expect((await call(PLATFORM, "add", { ...add, address: "pages.elsewhere.com" })).body.error).toContain("not in any of this account's domains");
    await apps.put(app("blog", { address: "acme.dev" }));
    expect((await call(PLATFORM, "add", add)).body.error).toContain("overlaps blog");
    apps = new MemoryApps();
    scripts.push("pages");
    expect((await call(PLATFORM, "add", add)).body.error).toContain("already has a Worker named pages");
  });

  test("deploying on push needs the GitHub App on the repo", async () => {
    expect((await call(PLATFORM, "add", { ...add, updates: "push" })).body.error).toContain("installed on the repo");
  });

  test("an app admin cannot add apps", async () => {
    expect((await call(BOB, "add", add)).status).toBe(403);
  });
});

describe("scope", () => {
  test("an app admin sees and deploys only their own apps, and cannot remove them or change their admins", async () => {
    await apps.put(app("pages", { admins: ["bob@example.com"] }));
    await apps.put(app("blog"));
    expect((await call(BOB, "")).body.apps.map((a: { name: string }) => a.name)).toEqual(["pages"]);
    expect((await call(BOB, "blog")).status).toBe(404);
    expect((await call(BOB, "pages/deploy", {})).body.error).toBeUndefined();
    expect((await call(BOB, "pages/remove", { confirm: "pages" })).body.error).toContain("Only platform admins");
    expect((await call(BOB, "pages/settings", { admins: "bob@example.com,eve@example.com" })).body.error).toContain("Only platform admins");
  });

  test("the super and platform admins see every app", async () => {
    await apps.put(app("pages"));
    await apps.put(app("blog"));
    expect((await call(SUPER, "")).body.apps).toHaveLength(2);
    expect((await call(PLATFORM, "")).body.apps).toHaveLength(2);
  });
});

describe("app secrets", () => {
  test("are write-only: the page says only whether each is set", async () => {
    await apps.put(app("pages", { admins: ["bob@example.com"] }));
    expect((await call(BOB, "pages/secret", { key: "STRIPE_KEY", value: SECRET })).body.error).toBeUndefined();
    const page = await call(BOB, "pages");
    expect(page.body.secrets).toEqual([{ name: "STRIPE_KEY", set: true }]);
    for (let i = 0; i + 6 <= SECRET.length; i++) expect(page.text).not.toContain(SECRET.slice(i, i + 6));
    expect(await apps.secrets("pages")).toEqual({ STRIPE_KEY: SECRET });
  });
});

describe("GitHub events", () => {
  const push = { ref: "refs/heads/main", after: "c".repeat(40), repository: { id: 7 }, pusher: { name: "bob" } };

  test("a push to the default branch deploys an app that updates on push, and only that", async () => {
    await apps.put(app("pages"));
    await apps.put(app("docs", { updates: "releases" }));
    await githubEvent(ctx(), "push", push);
    await githubEvent(ctx(), "push", { ...push, ref: "refs/heads/feature" });
    expect(apps.queued).toEqual([expect.objectContaining({ app: "pages", commit: "c".repeat(40), by: "push by bob" })]);
  });

  test("a pull request from the same repo gets a preview; one from a fork does not; closing it cleans up", async () => {
    await apps.put(app("pages", { previews: [3] }));
    const pr = (n: number, action: string, headRepo: number) => ({ action, number: n, repository: { id: 7 }, pull_request: { head: { ref: "feature", sha: "d".repeat(40), repo: { id: headRepo } } } });
    await githubEvent(ctx(), "pull_request", pr(3, "synchronize", 7));
    await githubEvent(ctx(), "pull_request", pr(5, "opened", 99));
    await githubEvent(ctx(), "pull_request", pr(3, "closed", 7));
    expect(apps.queued.map((r) => [r.kind, r.target])).toEqual([
      ["deploy", { kind: "preview", pr: 3 }],
      ["cleanup", { kind: "preview", pr: 3 }],
    ]);
  });
});
