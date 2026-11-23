import { beforeEach, describe, expect, test } from "vitest";
import { readConfig, type App } from "./apps.ts";
import { Cloudflare, SetupError } from "./cloudflare.ts";
import { deploy, cleanup, namespaceId, pendingMigrations, remove, type Builder, type DeployEnv, type Run, type Wrangler } from "./deploy.ts";
import { Neon } from "./neon.ts";
import { Resend } from "./resend.ts";

const PAGES = JSON.stringify({
  name: "pages",
  hostname: "pages-dev.celsoft.com",
  worker: "src/worker.ts",
  frontend: { dir: "dist" },
  compatibilityDate: "2026-10-01",
  database: true,
  email: true,
  auth: { signup: "invite", apiTokens: true },
  files: true,
  mcp: true,
  access: true,
});

const COMMIT = "a".repeat(40);
const PR_COMMIT = "b".repeat(40);
const DB_URI = "postgresql://neondb_owner:pw@ep-1.us-east-2.aws.neon.tech/neondb?sslmode=require";
const BRANCH_URI = "postgresql://neondb_owner:pw@ep-2.us-east-2.aws.neon.tech/neondb?sslmode=require";

// What the app's own framework would hand back: some of it hostile, as any app's could be.
const WRANGLER: Wrangler = {
  compatibility_date: "2026-10-01",
  compatibility_flags: ["nodejs_compat"],
  vars: { APP_NAME: "pages", AUTH_SIGNUP: "invite", MCP: "on", "bad name": "x" },
  assets: { not_found_handling: "404-page", run_worker_first: ["/api/*"] },
  durable_objects: { bindings: [{ name: "LIVE", class_name: "LiveRoom" }, { name: "STEAL", class_name: "InstanceState", script_name: "platform" }] },
  migrations: [{ tag: "live-rooms-v1", new_sqlite_classes: ["LiveRoom"] }],
  ratelimits: [
    { name: "AUTH_LIMIT", simple: { limit: 10, period: 60 } },
    { name: "API_LIMIT", simple: { limit: 1200, period: 60 } },
  ],
};

type Call = { method: string; url: URL; body: unknown };

class World {
  calls: Call[] = [];
  scripts = new Map<string, { migration_tag?: string; secrets: string[] }>();
  domains: { id: string; hostname: string; service: string; zone_id: string }[] = [];
  records: { id: string; type: string; name: string; content: string; comment?: string }[] = [];
  hyperdrives: { id: string; name: string; origin: { host: string; user: string; database: string } }[] = [];
  buckets = new Set<string>();
  projects = new Map<string, { branches: { id: string; name: string; default: boolean }[] }>();
  mailDomains: { id: string; name: string; status: string; records: unknown[] }[] = [];
  keys: { id: string; name: string }[] = [];
  upload?: { metadata: Record<string, any>; modules: string[] };
  files: Record<string, string> = { "platform.jsonc": PAGES };

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    if (body instanceof FormData) {
      const metadata = JSON.parse(await (body.get("metadata") as Blob).text());
      const modules = [...body.keys()].filter((k) => k !== "metadata");
      body = { metadata, modules };
    }
    this.calls.push({ method, url, body });
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    const path = url.pathname;
    const host = url.host;

    if (host === "api.cloudflare.com") {
      let m: RegExpExecArray | null;
      if (path === "/client/v4/accounts/acct/workers/scripts" && method === "GET") return ok([...this.scripts].map(([id, s]) => ({ id, migration_tag: s.migration_tag })));
      if ((m = /\/workers\/scripts\/([^/]+)\/secrets$/.exec(path))) return ok(this.scripts.get(decodeURIComponent(m[1]!))?.secrets.map((name) => ({ name })) ?? []);
      if ((m = /\/workers\/scripts\/([^/]+)\/assets-upload-session$/.exec(path))) return ok({ jwt: "session-jwt", buckets: [["h1"]] });
      if ((m = /\/workers\/scripts\/([^/]+)\/subdomain$/.exec(path))) return ok({});
      if ((m = /\/workers\/scripts\/([^/?]+)$/.exec(path))) {
        const name = decodeURIComponent(m[1]!);
        if (method === "DELETE") {
          this.scripts.delete(name);
          this.domains = this.domains.filter((d) => d.service !== name);
          return ok({});
        }
        const upload = body as { metadata: Record<string, any>; modules: string[] };
        this.upload = upload;
        const secrets = upload.metadata.bindings.filter((b: any) => b.type === "secret_text").map((b: any) => b.name);
        const before = this.scripts.get(name);
        this.scripts.set(name, { migration_tag: upload.metadata.migrations?.new_tag ?? before?.migration_tag, secrets: [...new Set([...(before?.secrets ?? []), ...secrets])] });
        return ok({ id: name });
      }
      if (path.endsWith("/workers/domains") && method === "GET") return ok(this.domains.filter((d) => d.hostname === url.searchParams.get("hostname")));
      if (path.endsWith("/workers/domains") && method === "PUT") {
        const b = body as { hostname: string; service: string; zone_id: string };
        this.domains.push({ id: `d${this.domains.length}`, ...b });
        return ok({});
      }
      if (path.endsWith("/hyperdrive/configs") && method === "GET") return ok(this.hyperdrives);
      if (path.endsWith("/hyperdrive/configs") && method === "POST") {
        const b = body as { name: string; origin: { host: string; user: string; database: string } };
        const h = { id: `h-${b.name}`, name: b.name, origin: b.origin };
        this.hyperdrives.push(h);
        return ok(h);
      }
      if ((m = /\/hyperdrive\/configs\/([^/]+)$/.exec(path)) && method === "DELETE") {
        this.hyperdrives = this.hyperdrives.filter((h) => h.id !== m![1]);
        return ok({});
      }
      if ((m = /\/r2\/buckets\/([^/]+)$/.exec(path))) {
        if (method === "GET") return this.buckets.has(m[1]!) ? ok({}) : Response.json({ success: false, errors: [{ code: 10006, message: "not found" }] }, { status: 404 });
        if (method === "DELETE") return this.buckets.delete(m[1]!), ok({});
      }
      if (path.endsWith("/lifecycle")) return ok({});
      if (path.endsWith("/r2/buckets") && method === "POST") return this.buckets.add((body as { name: string }).name), ok({});
      if (path === "/client/v4/zones/z1/dns_records" && method === "GET") {
        const name = url.searchParams.get("name");
        const comment = url.searchParams.get("comment");
        return ok(this.records.filter((r) => (name ? r.name === name : true) && (comment ? r.comment === comment : true)));
      }
      if (path === "/client/v4/zones/z1/dns_records" && method === "POST") {
        const r = { id: `r${this.records.length}`, ...(body as { type: string; name: string; content: string; comment: string }) };
        this.records.push(r);
        return ok(r);
      }
      if ((m = /\/dns_records\/([^/]+)$/.exec(path)) && method === "DELETE") return (this.records = this.records.filter((r) => r.id !== m![1])), ok({});
    }

    if (host === "console.neon.tech") {
      let m: RegExpExecArray | null;
      if (path === "/api/v2/projects" && method === "POST") {
        this.projects.set("proj-1", { branches: [{ id: "br-main", name: "main", default: true }] });
        return Response.json({ project: { id: "proj-1", region_id: "aws-us-east-2", pg_version: 18 } });
      }
      if ((m = /^\/api\/v2\/projects\/([^/]+)$/.exec(path))) {
        if (method === "DELETE") return this.projects.delete(m[1]!), Response.json({});
        return this.projects.has(m[1]!) ? Response.json({ project: { id: m[1], region_id: "aws-us-east-2", pg_version: 18 } }) : Response.json({ message: "not found" }, { status: 404 });
      }
      if ((m = /^\/api\/v2\/projects\/([^/]+)\/branches$/.exec(path))) {
        const project = this.projects.get(m[1]!)!;
        if (method === "GET") return Response.json({ branches: project.branches });
        const b = (body as { branch: { name: string } }).branch;
        const branch = { id: `br-${b.name}`, name: b.name, default: false };
        project.branches.push(branch);
        return Response.json({ branch });
      }
      if ((m = /^\/api\/v2\/projects\/([^/]+)\/branches\/([^/]+)$/.exec(path)) && method === "DELETE") {
        const project = this.projects.get(m[1]!)!;
        project.branches = project.branches.filter((b) => b.id !== m![2]);
        return Response.json({});
      }
      if (path.endsWith("/databases")) return Response.json({ databases: [{ name: "neondb", owner_name: "neondb_owner" }] });
      if (path.endsWith("/connection_uri")) return Response.json({ uri: url.searchParams.get("branch_id") === "br-main" ? DB_URI : BRANCH_URI });
    }

    if (host === "api.resend.com") {
      if (path === "/domains" && method === "GET") return Response.json({ data: this.mailDomains });
      if (path === "/domains" && method === "POST") {
        const d = { id: "md1", name: (body as { name: string }).name, status: "not_started", records: [{ record: "DKIM", name: "resend._domainkey.pages", type: "TXT", value: "p=key" }, { record: "SPF", name: "send.pages", type: "MX", value: "feedback-smtp.amazonses.com", priority: 10 }] };
        this.mailDomains.push(d);
        return Response.json(d);
      }
      if (/^\/domains\/[^/]+$/.test(path) && method === "GET") return Response.json(this.mailDomains.find((d) => path.endsWith(d.id)));
      if (/^\/domains\/[^/]+\/verify$/.test(path)) {
        for (const d of this.mailDomains) d.status = "verified";
        return Response.json({});
      }
      if (/^\/domains\/[^/]+$/.test(path) && method === "DELETE") return (this.mailDomains = this.mailDomains.filter((d) => !path.endsWith(d.id))), Response.json({});
      if (path === "/api-keys" && method === "GET") return Response.json({ data: this.keys });
      if (path === "/api-keys" && method === "POST") {
        this.keys.push({ id: `k${this.keys.length}`, name: (body as { name: string }).name });
        return Response.json({ id: "k", token: "re_send_only" });
      }
      if (/^\/api-keys\//.test(path)) return (this.keys = this.keys.filter((k) => !path.endsWith(k.id))), Response.json({});
    }

    if (host === "api.github.com") {
      if (path.endsWith("/installation")) return new Response(null, { status: 404 });
      if (path.includes("/commits/")) return new Response(path.endsWith("/main") ? COMMIT : PR_COMMIT);
      if (path.includes("/contents/")) {
        const file = this.files[decodeURIComponent(path.split("/contents/")[1]!)];
        return file === undefined ? new Response(null, { status: 404 }) : new Response(file);
      }
      if (path.includes("/tarball/")) return new Response("tarball-bytes");
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
}

// The build machine, answering as the real one does, and recording what it was handed.
class FakeBuilder implements Builder {
  received: Record<string, unknown> = {};
  destroyed = false;
  failAt?: string;
  upToDate = true;

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const body = path === "/source" ? await request.text() : await request.text().then((t) => (t ? JSON.parse(t) : {}));
    this.received[path] = body;
    if (path === this.failAt) return Response.json({ error: "`npm run build` failed with code 1", log: ["> vite build", "error: nope"] }, { status: 400 });
    if (path === "/build") return Response.json({ framework: "0.58.1", manager: "npm", upToDate: this.upToDate, pages: ["/"], wrangler: WRANGLER });
    if (path === "/bundle") return Response.json({ main: "entry.js", modules: [{ name: "entry.js", type: "application/javascript+module", content: btoa("export default {}") }], assets: { manifest: { "/index.html": { hash: "h1", size: 10 } } } });
    if (path === "/upload") return Response.json({ jwt: "completion-jwt" });
    return Response.json({});
  }

  async destroy() {
    this.destroyed = true;
  }
}

let world: World;
let builder: FakeBuilder;

const APP: App = {
  name: "pages",
  repo: { owner: "celsoft-com", ownerId: 1, name: "pages", id: 7, private: false, defaultBranch: "main" },
  dir: "",
  address: "pages.acme.dev",
  zone: { id: "z1", name: "acme.dev" },
  admins: [],
  build: {},
  updates: "branch",
  resources: {},
  previews: [],
  addedBy: "ann@example.com",
  addedAt: "2026-11-22T00:00:00.000Z",
};

const env = (over: Partial<DeployEnv> = {}): DeployEnv => ({
  account: "acct",
  host: "platform.acme.workers.dev",
  cf: new Cloudflare("wide", world.fetch, true),
  neon: new Neon("neon", world.fetch),
  resend: new Resend("resend", world.fetch),
  builder: () => builder,
  appSecrets: {},
  fetcher: world.fetch,
  now: () => new Date("2026-11-22T12:00:00Z"),
  sleep: async () => {},
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({ id: "r1", app: "pages", kind: "deploy", target: { kind: "prod" }, ref: "main", by: "ann@example.com", state: "running", done: [], warnings: [], queuedAt: "", ...over });

const binding = (type: string) => world.upload!.metadata.bindings.filter((b: { type: string }) => b.type === type);

beforeEach(() => {
  world = new World();
  builder = new FakeBuilder();
});

describe("deploying to prod", () => {
  test("provisions only in the app's namespace and uploads the Worker with only its bindings", async () => {
    const r = run();
    const { patch } = await deploy(env(), APP, r, async () => {});

    expect(patch.resources).toEqual({ neonProject: "proj-1", region: "aws-us-east-2" });
    expect(patch.deployed).toEqual({ ref: "main", commit: COMMIT, at: "2026-11-22T12:00:00.000Z" });
    expect(world.hyperdrives.map((h) => h.name)).toEqual(["pages"]);
    expect([...world.buckets]).toEqual(["pages--files"]);
    expect(world.projects.get("proj-1")!.branches.map((b) => b.name)).toEqual(["main", "backup-20261122T120000"]);
    expect(world.domains).toEqual([expect.objectContaining({ hostname: "pages.acme.dev", service: "pages", zone_id: "z1" })]);
    expect(world.records.every((rec) => rec.comment === "managed by @celsoft/platform for pages")).toBe(true);
    expect(world.records.map((rec) => rec.name)).toEqual(["resend._domainkey.pages.acme.dev", "send.pages.acme.dev"]);

    const m = world.upload!.metadata;
    expect(m.main_module).toBe("entry.js");
    expect(m.keep_bindings).toEqual(["secret_text"]);
    expect(m.placement).toEqual({ region: "aws:us-east-2" });
    expect(m.migrations).toEqual({ new_tag: "live-rooms-v1", steps: [{ new_sqlite_classes: ["LiveRoom"] }] });
    expect(m.assets).toEqual({ jwt: "completion-jwt", config: { not_found_handling: "404-page", run_worker_first: ["/api/*"] } });
    expect(binding("hyperdrive")).toEqual([{ type: "hyperdrive", name: "DB", id: "h-pages" }]);
    expect(binding("r2_bucket")).toEqual([{ type: "r2_bucket", name: "FILES", bucket_name: "pages--files" }]);
    // A Durable Object binding into another Worker, such as the instance's own state, is never taken.
    expect(binding("durable_object_namespace")).toEqual([{ type: "durable_object_namespace", name: "LIVE", class_name: "LiveRoom" }]);
    expect(binding("ratelimit").map((b: { namespace_id: string }) => b.namespace_id)).toEqual([await namespaceId("pages"), await namespaceId("pages:api")]);
    expect(binding("secret_text").map((b: { name: string }) => b.name).sort()).toEqual(["BETTER_AUTH_SECRET", "EMAIL_API_KEY"]);
    const vars = Object.fromEntries(binding("plain_text").map((b: { name: string; text: string }) => [b.name, b.text]));
    expect(vars).toMatchObject({ APP_NAME: "pages", APP_URL: "https://pages.acme.dev", EMAIL_MODE: "send", EMAIL_FROM: "noreply@pages.acme.dev", DEPLOY_COMMIT: COMMIT, DEPLOY_TARGET: "production" });
    expect(vars["bad name"]).toBeUndefined();

    expect(r.done.join("\n")).toContain("https://pages.acme.dev serves the app.");
    expect(r.url).toBe("https://pages.acme.dev");
    expect(builder.destroyed).toBe(true);
  });

  test("the build machine gets the source, the instance's reading of platform.jsonc and the app's own database, nothing else", async () => {
    await deploy(env(), APP, run(), async () => {});
    expect(builder.received["/source"]).toBe("tarball-bytes");
    const sent = builder.received["/build"] as { config: string };
    expect(JSON.parse(sent.config)).toMatchObject({ name: "pages", hostname: "pages.acme.dev" });
    expect(builder.received["/migrate"]).toEqual({ uri: DB_URI, forgetKeys: true });
    expect(builder.received["/upload"]).toEqual({ account: "acct", jwt: "session-jwt", buckets: [["h1"]] });
    const everything = JSON.stringify(builder.received);
    for (const secret of ["wide", "neon", "resend", "re_send_only"]) expect(everything).not.toContain(`"${secret}"`);
  });

  test("a second deploy keeps the secrets and the Durable Object migration it already has", async () => {
    await deploy(env(), APP, run(), async () => {});
    const app = { ...APP, resources: { neonProject: "proj-1", region: "aws-us-east-2" } };
    const r = run({ id: "r2" });
    await deploy(env(), app, r, async () => {});
    expect(binding("secret_text")).toEqual([]);
    expect(world.upload!.metadata.migrations).toBeUndefined();
    expect(builder.received["/migrate"]).toEqual({ uri: DB_URI, forgetKeys: false });
    expect(world.domains).toHaveLength(1);
  });

  test("keeps the newest three backups", async () => {
    world.projects.set("proj-1", { branches: [{ id: "br-main", name: "main", default: true }, ...["a", "b", "c"].map((x) => ({ id: `br-${x}`, name: `backup-2026010${x === "a" ? 1 : x === "b" ? 2 : 3}T000000`, default: false }))] });
    await deploy(env(), { ...APP, resources: { neonProject: "proj-1" } }, run(), async () => {});
    expect(world.projects.get("proj-1")!.branches.map((b) => b.name)).toEqual(["main", "backup-20260102T000000", "backup-20260103T000000", "backup-20261122T120000"]);
  });

  test("hands the app the secrets its admins set", async () => {
    world.files["platform.jsonc"] = JSON.stringify({ ...JSON.parse(PAGES), secrets: ["STRIPE_KEY"] });
    await expect(deploy(env(), APP, run(), async () => {})).rejects.toThrow("The app needs STRIPE_KEY; set it under the app's Secrets");
    await deploy(env({ appSecrets: { STRIPE_KEY: "sk_live" } }), APP, run(), async () => {});
    expect(binding("secret_text")).toContainEqual({ type: "secret_text", name: "STRIPE_KEY", text: "sk_live" });
  });
});

describe("refusals", () => {
  test("an address another Worker serves", async () => {
    world.domains.push({ id: "d0", hostname: "pages.acme.dev", service: "blog", zone_id: "z1" });
    await expect(deploy(env(), APP, run(), async () => {})).rejects.toThrow("pages.acme.dev already serves the Worker blog");
    expect(world.upload).toBeUndefined();
  });

  test("an address with a DNS record the instance did not make", async () => {
    world.records.push({ id: "x", type: "CNAME", name: "pages.acme.dev", content: "elsewhere.example.com" });
    await expect(deploy(env(), APP, run(), async () => {})).rejects.toThrow("already has a DNS record (CNAME elsewhere.example.com)");
  });

  test("a database with no Neon key", async () => {
    const { neon: _neon, ...noNeon } = env();
    await expect(deploy(noNeon, APP, run(), async () => {})).rejects.toThrow("no Neon key");
  });

  test("a failed build shows the build's last lines and destroys the machine", async () => {
    builder.failAt = "/build";
    const r = run();
    await expect(deploy(env(), APP, r, async () => {})).rejects.toThrow("The build stopped: `npm run build` failed with code 1.");
    expect(r.log).toEqual(["> vite build", "error: nope"]);
    expect(builder.destroyed).toBe(true);
    expect(world.upload).toBeUndefined();
  });

  test("schema changes with no migration", async () => {
    builder.upToDate = false;
    await expect(deploy(env(), APP, run(), async () => {})).rejects.toThrow("db generate");
  });
});

describe("previews", () => {
  test("a pull request gets its own Worker, address and copy of the prod database, and captures email", async () => {
    world.projects.set("proj-1", { branches: [{ id: "br-main", name: "main", default: true }] });
    const r = run({ target: { kind: "preview", pr: 4 }, ref: "feature", commit: PR_COMMIT });
    const { patch } = await deploy(env(), { ...APP, resources: { neonProject: "proj-1" } }, r, async () => {});
    expect(patch).toEqual({ previews: [4] });
    expect(world.domains).toEqual([expect.objectContaining({ hostname: "pr-4.pages.acme.dev", service: "pages--pr-4" })]);
    expect(builder.received["/migrate"]).toEqual({ uri: BRANCH_URI, forgetKeys: true });
    expect([...world.buckets]).toEqual(["pages--previews"]);
    const vars = Object.fromEntries(binding("plain_text").map((b: { name: string; text: string }) => [b.name, b.text]));
    expect(vars).toMatchObject({ EMAIL_MODE: "capture", FILES_PREFIX: "pr-4/", DEPLOY_TARGET: "preview" });
    expect(world.mailDomains).toEqual([]);

    const done = await cleanup(env(), { ...APP, resources: { neonProject: "proj-1" }, previews: [4] }, run({ kind: "cleanup", target: { kind: "preview", pr: 4 } }), async () => {});
    expect(done.patch).toEqual({ previews: [] });
    expect(world.scripts.has("pages--pr-4")).toBe(false);
    expect(world.hyperdrives).toEqual([]);
    expect(world.projects.get("proj-1")!.branches.map((b) => b.name)).toEqual(["main"]);
  });
});

describe("removing", () => {
  test("deletes what the instance made, keeping data unless asked", async () => {
    await deploy(env(), APP, run(), async () => {});
    const app = { ...APP, resources: { neonProject: "proj-1" } };
    const done: string[] = [];
    await remove(env(), app, false, done);
    expect(world.scripts.size).toBe(0);
    expect(world.hyperdrives).toEqual([]);
    expect(world.records).toEqual([]);
    expect(world.mailDomains).toEqual([]);
    expect(world.projects.has("proj-1")).toBe(true);
    expect(world.buckets.has("pages--files")).toBe(true);
    await remove(env(), app, true, []);
    expect(world.projects.has("proj-1")).toBe(false);
    expect(world.buckets.has("pages--files")).toBe(false);
  });
});

describe("platform.jsonc", () => {
  test("name and hostname are ignored with a warning, and replaced for the build", () => {
    const config = readConfig(PAGES, "docs", "docs.acme.dev");
    expect(config.warnings).toHaveLength(2);
    expect(JSON.parse(config.text)).toMatchObject({ name: "docs", hostname: "docs.acme.dev", database: true });
  });

  test("variables are refused", () => {
    expect(() => readConfig(PAGES.replace("pages-dev.celsoft.com", "${HOSTNAME}"), "p", "p.acme.dev")).toThrow(SetupError);
  });

  test("a file with neither name nor hostname gets both", () => {
    const config = readConfig(`{ // the app\n "worker": "src/worker.ts", "compatibilityDate": "2026-10-01" }`, "p", "p.acme.dev");
    expect(config.warnings).toEqual([]);
    expect(config.text).toContain('"name": "p"');
    expect(config.text).toContain("// the app");
  });
});

test("Durable Object migrations pick up after the Worker's last tag", () => {
  const all = [{ tag: "a" }, { tag: "b" }, { tag: "c" }];
  expect(pendingMigrations(all, undefined)).toEqual(all);
  expect(pendingMigrations(all, "b")).toEqual([{ tag: "c" }]);
  expect(pendingMigrations(all, "c")).toEqual([]);
});
