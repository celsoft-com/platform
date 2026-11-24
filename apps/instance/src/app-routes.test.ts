import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { appRoute, githubEvent, type AppContext } from "./app-routes.ts";
import type { App } from "./apps.ts";
import type { GitHubApp } from "./github.ts";
import { MemoryApps } from "./memory-apps.ts";
import type { InstanceRecord, Store, Viewer } from "./setup.ts";
import { testApp } from "./test-keys.ts";

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
let gh: GitHubApp;
// Repos on GitHub by owner/name, and who the user token belongs to.
let repos: Map<string, { id: number; private: boolean }>;
let made: { path: string; body: Record<string, unknown> }[];
let addedToInstallation: string[];
const SOURCE_COMMIT = "e".repeat(40);

beforeAll(async () => {
  gh = await testApp("acme");
});

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
  if (url.host === "github.com" && url.pathname === "/login/oauth/access_token") {
    const b = JSON.parse(String(init?.body)) as { code: string; client_secret: string };
    return Response.json(b.code === "good" && b.client_secret === "client-secret" ? { access_token: "gho_user" } : { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." });
  }
  if (url.host === "api.github.com") {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    let m: RegExpExecArray | null;
    if (url.pathname === "/user") return Response.json({ login: "ann" });
    if (url.pathname === "/orgs/acme/repos" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; private: boolean };
      made.push({ path: url.pathname, body, ...(auth === "token gho_user" ? {} : { wrongAuth: auth }) });
      repos.set(`acme/${body.name}`, { id: 99, private: body.private });
      return Response.json({ id: 99, name: body.name, private: body.private, default_branch: "main", owner: { login: "acme", id: 2 } });
    }
    if (url.pathname === "/users/acme/installation") return Response.json({ id: 5, repository_selection: "selected" });
    if ((m = /^\/user\/installations\/5\/repositories\/(\d+)$/.exec(url.pathname)) && init?.method === "PUT") return addedToInstallation.push(m[1]!), new Response(null, { status: 204 });
    if ((m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(url.pathname))) {
      const found = repos.get(`${m[1]}/${m[2]}`);
      return found ? Response.json({ id: found.id, name: m[2], private: found.private, default_branch: "main", owner: { login: m[1], id: m[1] === "acme" ? 2 : 1 } }) : Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (url.pathname.endsWith("/contents/platform.jsonc")) return new Response(CONFIG);
    if (url.pathname.endsWith("/releases/latest") || url.pathname.endsWith("/installation")) return new Response(null, { status: 404 });
    if (url.pathname.endsWith("/commits/main")) return new Response(SOURCE_COMMIT);
  }
  throw new Error(`unexpected ${url}`);
}) as typeof fetch;

let record: InstanceRecord;
const store: Store = { get: async () => record, put: async (r) => void (record = r) };

const ctx = (): AppContext => ({
  store,
  apps,
  self: { version: "v", host: "platform.acme.workers.dev" },
  secrets: { CLOUDFLARE_API_TOKEN: "cf", GITHUB_APP: JSON.stringify(gh) },
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
  repos = new Map([["celsoft-com/pages", { id: 7, private: false }]]);
  made = [];
  addedToInstallation = [];
});

describe("adding an app", () => {
  const add = { repo: "https://github.com/celsoft-com/pages", name: "pages", address: "pages.acme.dev", admins: "bob@example.com" };

  test("from a repo outside the instance's owner: GitHub lets the admin make its clone, then its first run clones and deploys", async () => {
    const started = await call(PLATFORM, "add", add);
    expect(started.body.error).toBeUndefined();
    const authorize = new URL(started.body.authorize);
    expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://platform.acme.workers.dev/admin/github/authorized");
    expect(apps.apps.size).toBe(0);

    const { body } = await call(PLATFORM, "authorized", { code: "good", state: authorize.searchParams.get("state") });
    expect(body.error).toBeUndefined();
    expect(made).toEqual([{ path: "/orgs/acme/repos", body: expect.objectContaining({ name: "pages", private: true }) }]);
    expect(addedToInstallation).toEqual(["99"]);
    expect(apps.apps.get("pages")).toMatchObject({ repo: { owner: "acme", name: "pages", id: 99 }, address: "pages.acme.dev", admins: ["bob@example.com"], addedBy: "pat@example.com" });
    expect(policy).toEqual(["ann@example.com", "pat@example.com", "bob@example.com"]);
    expect(apps.queued).toEqual([expect.objectContaining({ app: "pages", kind: "deploy", merge: { source: { owner: "celsoft-com", name: "pages" }, ref: "main", commit: SOURCE_COMMIT, clone: true, author: "pat@example.com" } })]);
  });

  test("GitHub's answer works once, only for the admin who started it", async () => {
    const state = new URL((await call(PLATFORM, "add", add)).body.authorize).searchParams.get("state");
    expect((await call(SUPER, "authorized", { code: "good", state })).body.error).toContain("not for an Add app you started");
    expect((await call(PLATFORM, "authorized", { code: "good", state })).body.error).toContain("not for an Add app you started");
    expect(made).toEqual([]);
  });

  test("shows what the app needs and that it will be cloned into the instance's owner", async () => {
    const { body } = await call(PLATFORM, "inspect", { repo: "celsoft-com/pages" });
    expect(body).toMatchObject({ name: "pages", clone: true, owner: "acme", zones: ["acme.dev"], needs: ["A Worker", "Secret STRIPE_KEY"] });
    expect(body.warnings).toEqual([expect.stringContaining("sets name")]);
  });

  test("refuses an address outside the account's domains, one another app overlaps, a Worker name already taken, and a repo name already taken", async () => {
    expect((await call(PLATFORM, "add", { ...add, address: "pages.elsewhere.com" })).body.error).toContain("not in any of this account's domains");
    await apps.put(app("blog", { address: "acme.dev" }));
    expect((await call(PLATFORM, "add", add)).body.error).toContain("overlaps blog");
    apps = new MemoryApps();
    scripts.push("pages");
    expect((await call(PLATFORM, "add", add)).body.error).toContain("already has a Worker named pages");
    scripts.pop();
    repos.set("acme/pages", { id: 50, private: true });
    expect((await call(PLATFORM, "add", add)).body.error).toContain("acme/pages already exists");
  });

  test("an app admin cannot add apps", async () => {
    expect((await call(BOB, "add", add)).status).toBe(403);
  });
});

describe("updating and moving", () => {
  test("Update queues merging the source's newer version into the app's repo, then a deploy", async () => {
    await apps.put(app("pages", { admins: ["bob@example.com"], source: { owner: "celsoft-com", name: "pages", ref: "v1", commit: "1".repeat(40) }, available: { ref: "v2", commit: "2".repeat(40) } }));
    expect((await call(BOB, "pages/update", {})).body.error).toBeUndefined();
    expect(apps.queued).toEqual([expect.objectContaining({ kind: "deploy", merge: { source: { owner: "celsoft-com", name: "pages" }, ref: "v2", commit: "2".repeat(40), clone: false, author: "bob@example.com" } })]);
  });

  test("a platform admin moves an app to a new address; its next deploy retires the old one; an app admin cannot", async () => {
    await apps.put(app("pages", { admins: ["bob@example.com"] }));
    expect((await call(BOB, "pages/settings", { address: "new.acme.dev" })).body.error).toContain("Only platform admins");
    expect((await call(PLATFORM, "pages/settings", { address: "new.acme.dev" })).body.error).toBeUndefined();
    expect(apps.apps.get("pages")).toMatchObject({ address: "new.acme.dev", moved: [{ address: "pages.acme.dev", zone: { id: "z1" } }] });
    expect(apps.queued).toEqual([expect.objectContaining({ kind: "deploy", target: { kind: "prod" } })]);
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

  test("a push to the default branch deploys, and a push to another branch does not", async () => {
    await apps.put(app("pages"));
    await githubEvent(ctx(), "push", push);
    await githubEvent(ctx(), "push", { ...push, ref: "refs/heads/feature" });
    expect(apps.queued).toEqual([expect.objectContaining({ app: "pages", commit: "c".repeat(40), by: "push by bob" })]);
  });

  test("the push an Update or a first clone makes is not deployed twice", async () => {
    await apps.put(app("pages"));
    apps.history.set("pages", [{ id: "r0", app: "pages", kind: "deploy", target: { kind: "prod" }, ref: "main", by: "x", state: "running", done: [], warnings: [], queuedAt: "", merge: { source: { owner: "celsoft-com", name: "pages" }, ref: "v2", commit: "2".repeat(40), clone: false, author: "x" } }]);
    await githubEvent(ctx(), "push", push);
    expect(apps.queued).toEqual([]);
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
