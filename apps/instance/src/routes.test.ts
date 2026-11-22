import { beforeEach, describe, expect, test } from "vitest";
import { APP_PERMISSIONS, PERMISSIONS } from "./cloudflare.ts";
import type { Secrets } from "./complete.ts";
import { handle } from "./routes.ts";
import { ADMIN_PATH, TOKEN_SECRET, type InstanceRecord, type Self, type Store } from "./setup.ts";

const TOKEN = "good-token";
// A setup token whose characters can only appear in a reply if the token itself leaked.
const TOKEN_LIKE = "Tq8wE3rY6uI1oP4aS7dF";
// A token with the permissions deploying apps adds, which the setup token lacks.
const WIDE = "wide-token";
const VERSION = "0f1e2d3c-4b5a-4687-9a1b-2c3d4e5f6071";
const HOST = "platform.acme.workers.dev";
const TEAM = "acme.cloudflareaccess.com";

// The slice of Cloudflare's API setup uses, for two tokens and two accounts.
class FakeCloudflare {
  denied = new Set<string>();
  onboarded = true;
  accessOn = false;
  organization: { auth_domain: string } | undefined;
  idps: { id: string; type: string }[] = [];
  policies: { id: string; name: string; include: unknown }[] = [];
  apps: { id: string; domain: string; aud: string; policies: unknown }[] = [];
  secrets: Secrets & Record<string, string> = {};
  tokens = new Set<string>();
  zones = [
    { id: "z1", name: "acme.dev" },
    { id: "z2", name: "acme.app" },
  ];
  keys: CryptoKeyPair | undefined;
  private next = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === TEAM) {
      const jwk = await crypto.subtle.exportKey("jwk", this.keys!.publicKey);
      return Response.json({ keys: [{ ...jwk, kid: "k1" }] });
    }
    const auth = new Headers(init?.headers).get("authorization");
    if (![TOKEN, TOKEN_LIKE, WIDE, ...this.tokens].some((t) => auth === `Bearer ${t}`)) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 });
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    const narrow = auth === `Bearer ${TOKEN}` || auth === `Bearer ${TOKEN_LIKE}`;
    const deny = (permission: string) =>
      (this.denied.has(permission) || (narrow && (Object.values(APP_PERMISSIONS) as string[]).includes(permission))) && Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    const id = () => `id-${++this.next}`;

    if (path === "/accounts") return deny(PERMISSIONS.settings) || ok([{ id: "other" }, { id: "acct" }]);
    if (path === "/zones") return deny(APP_PERMISSIONS.zones) || ok(url.searchParams.get("account.id") === "acct" ? this.zones : []);
    if (path.match(/^\/zones\/z\d\/dns_records$/)) return deny(APP_PERMISSIONS.dns) || ok([]);
    if (path.match(/^\/zones\/z\d\/workers\/routes$/)) return deny(APP_PERMISSIONS.routes) || ok([]);
    const match = path.match(/^\/accounts\/(\w+)(\/.*)$/);
    if (!match) return new Response(null, { status: 404 });
    const [, account, rest] = match as unknown as [string, string, string];
    if (rest === "/workers/scripts") return deny(PERMISSIONS.scripts) || ok(account === "acct" ? [{ id: "blog" }, { id: "platform" }] : [{ id: "elsewhere" }]);
    if (rest === "/hyperdrive/configs") return deny(APP_PERMISSIONS.hyperdrive) || ok([]);
    if (rest === "/r2/buckets") return deny(APP_PERMISSIONS.r2) || ok({ buckets: [] });
    if (rest.endsWith("/deployments")) return ok({ deployments: [{ versions: [{ version_id: rest.includes("/platform/") ? VERSION : "other-version" }] }] });
    if (rest === "/workers/scripts/platform/secrets") return deny(PERMISSIONS.scripts) || (method === "PUT" ? ((this.secrets[body.name] = body.text), ok({ name: body.name })) : ok(Object.keys(this.secrets).map((name) => ({ name }))));
    if (rest === "/access/organizations") {
      if (deny(PERMISSIONS.organizations)) return deny(PERMISSIONS.organizations) as Response;
      // Cloudflare answers every Access call with this 403 until Access is switched on.
      const notEnabled = Response.json({ success: false, errors: [{ code: 9999, message: "access.api.error.not_enabled: Access is not enabled." }] }, { status: 403 });
      if (method === "GET") return this.organization ? ok(this.organization) : this.accessOn ? Response.json({ success: false, errors: [{ code: 12130, message: "access.api.error.not_found" }] }, { status: 404 }) : notEnabled;
      if (!this.onboarded) return notEnabled;
      this.accessOn = true;
      return ok((this.organization = { auth_domain: TEAM }));
    }
    if (rest === "/access/identity_providers") return deny(PERMISSIONS.organizations) || (method === "GET" ? ok(this.idps) : ok(this.idps[this.idps.push({ id: id(), type: body.type }) - 1]));
    if (rest.startsWith("/access/policies")) {
      if (deny(PERMISSIONS.apps)) return deny(PERMISSIONS.apps) as Response;
      const existing = this.policies.find((p) => rest.endsWith(`/${p.id}`));
      if (method === "GET") return existing ? ok(existing) : ok(this.policies);
      if (existing) return ok(Object.assign(existing, body));
      return ok(this.policies[this.policies.push({ id: id(), ...body }) - 1]);
    }
    if (rest.startsWith("/access/apps")) {
      if (deny(PERMISSIONS.apps)) return deny(PERMISSIONS.apps) as Response;
      if (method === "GET") return ok(this.apps);
      const existing = this.apps.find((a) => rest.endsWith(`/${a.id}`));
      if (existing) return ok(Object.assign(existing, body));
      return ok(this.apps[this.apps.push({ id: id(), aud: "aud-1", ...body }) - 1]);
    }
    return new Response(null, { status: 404 });
  };
}

class MemoryStore implements Store {
  record: InstanceRecord | undefined;
  async get() {
    return this.record;
  }
  async put(record: InstanceRecord) {
    this.record = record;
  }
}

const encode = (data: Uint8Array | string) => btoa(String.fromCharCode(...(typeof data === "string" ? new TextEncoder().encode(data) : data))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

async function jwt(keys: CryptoKeyPair, claims: Record<string, unknown>): Promise<string> {
  const head = encode(JSON.stringify({ alg: "RS256", kid: "k1" }));
  const body = encode(JSON.stringify({ iss: `https://${TEAM}`, aud: ["aud-1"], exp: Date.now() / 1000 + 600, ...claims }));
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${encode(signature)}`;
}

const rsa = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

let cf: FakeCloudflare;
let store: MemoryStore;

// Like Workers' fetch, refuses to run as another object's method.
function strict(this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
  return cf.fetch(input, init);
}

const SELF: Self = { version: VERSION, deployedAt: "2026-11-22T20:15:42.123Z", host: HOST };

// Every other service setup talks to, answered by the test's fakes.
let elsewhere: (url: URL, init?: RequestInit) => Promise<Response | undefined> | undefined = () => undefined;

// The Worker sees the secrets Cloudflare holds for it, as a new version would after each one is saved.
const context = (over: Partial<{ store: Store; self: Self; fetcher: typeof fetch; assets: { fetch: (r: Request) => Promise<Response> } }> = {}) => ({
  store,
  self: SELF,
  secrets: cf.secrets,
  fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => (await elsewhere(new URL(String(input)), init)) ?? strict(input, init)) as typeof fetch,
  ...over,
});

const request = (path: string, init?: { json?: unknown; jwt?: string; method?: string; body?: string; headers?: Record<string, string> }) =>
  handle(
    new Request(`https://${HOST}${path}`, {
      method: init?.method ?? (init?.json !== undefined ? "POST" : "GET"),
      ...(init?.json !== undefined ? { body: JSON.stringify(init.json) } : init?.body ? { body: init.body } : {}),
      headers: { ...(init?.jwt ? { "cf-access-jwt-assertion": init.jwt } : {}), ...init?.headers },
    }),
    context(),
  );

type Step = { done: string[]; error?: string };
const answer = async <T = Step>(response: Promise<Response> | Response) => (await (await response).json()) as T;
const submit = (email: string, token = TOKEN, path = "/api/reserve") => request(path, { json: { token, email } });

beforeEach(async () => {
  cf = new FakeCloudflare();
  cf.keys = await rsa();
  store = new MemoryStore();
  elsewhere = () => undefined;
});

describe("unclaimed", () => {
  test("the state names the stage, the build serving, and the link that creates the token", async () => {
    const state = await answer<{ stage: string; build: { version: string }; tokenUrl: string; permissions: string[] }>(request("/api/state"));
    expect(state.stage).toBe("unclaimed");
    expect(state.build.version).toBe(VERSION);
    expect(state.tokenUrl).toContain("permissionGroupKeys");
    expect(state.permissions).toEqual(Object.values(PERMISSIONS));
  });

  test("a valid token and email reserve it and set up Access for that email alone", async () => {
    const response = await submit("Ann@Example.com");
    expect(response.status).toBe(200);
    const { done } = await answer(response);
    for (const step of ["Token accepted", "Cloudflare Access is on", "Sign-in with an emailed code is on", "Only ann@example.com may sign in", "Cloudflare Access protects", "Reserved for ann@example.com", "Token saved"]) expect(done.join("\n")).toContain(step);
    expect(store.record).toEqual({ state: "reserved", email: "ann@example.com", account: "acct", script: "platform", authDomain: TEAM, aud: "aud-1" });
    expect(cf.secrets[TOKEN_SECRET]).toBe(TOKEN);
    expect(cf.idps).toEqual([{ id: expect.any(String), type: "onetimepin" }]);
    expect(cf.policies).toEqual([expect.objectContaining({ include: [{ email: { email: "ann@example.com" } }], decision: "allow" })]);
    expect(cf.apps).toEqual([expect.objectContaining({ domain: `${HOST}${ADMIN_PATH}`, policies: [{ id: cf.policies[0]!.id, precedence: 1 }] })]);
    expect(await answer(request("/api/state"))).toMatchObject({ stage: "reserved", reserved: "ann@example.com" });
  });

  test("switches Access on when the account has never used it", async () => {
    expect((await submit("ann@example.com")).status).toBe(200);
    expect(cf.accessOn).toBe(true);
  });

  test("reuses a Zero Trust organization and one-time PIN login the account already has", async () => {
    cf.organization = { auth_domain: "existing.cloudflareaccess.com" };
    cf.idps.push({ id: "otp", type: "onetimepin" });
    await submit("ann@example.com");
    expect(store.record?.authDomain).toBe("existing.cloudflareaccess.com");
    expect(cf.idps).toHaveLength(1);
  });

  test("every other path is the built pages", async () => {
    const pages = { fetch: async (r: Request) => new Response(`page ${new URL(r.url).pathname}`) };
    expect(await (await handle(new Request(`https://${HOST}/admin/settings`), context({ assets: pages }))).text()).toBe("page /admin/settings");
    expect((await request("/api/nothing")).status).toBe(404);
  });
});

describe("refused tokens", () => {
  test("a token Cloudflare does not accept", async () => {
    const response = await submit("ann@example.com", "typo");
    expect(response.status).toBe(400);
    expect((await answer(response)).error).toContain("Cloudflare did not accept this token");
    expect(store.record).toBeUndefined();
  });

  test.each(Object.values(PERMISSIONS))("a token missing %s names it", async (permission) => {
    cf.denied.add(permission);
    expect((await answer(submit("ann@example.com"))).error).toContain(`missing the ${permission} permission`);
    expect(store.record).toBeUndefined();
  });

  test("a token for an account not running this instance", async () => {
    const response = await handle(new Request(`https://${HOST}/api/reserve`, { method: "POST", body: JSON.stringify({ token: TOKEN, email: "ann@example.com" }) }), context({ self: { version: "not-deployed-here", host: HOST } }));
    expect((await answer(response)).error).toContain("does not reach the Cloudflare account running this instance");
    expect(store.record).toBeUndefined();
  });

  test("a failure reports the steps that finished and the one that stopped it", async () => {
    cf.denied.add(PERMISSIONS.apps);
    const { done, error } = await answer(submit("ann@example.com"));
    expect(done[0]).toContain("Token accepted");
    expect(done).toContain("Sign-in with an emailed code is on.");
    expect(error).toContain(`The token is missing the ${PERMISSIONS.apps}`);
  });

  test("a reservation the instance cannot read back is reported, not lost", async () => {
    const forgetful: Store = { get: async () => undefined, put: async () => {} };
    const response = await handle(new Request(`https://${HOST}/api/reserve`, { method: "POST", body: JSON.stringify({ token: TOKEN, email: "ann@example.com" }) }), context({ store: forgetful }));
    expect((await answer(response)).error).toContain("could not be saved in this instance's storage");
    expect(cf.secrets[TOKEN_SECRET]).toBeUndefined();
  });

  test("an account whose Access is off and that Cloudflare will not switch on says to click Enable Access", async () => {
    cf.onboarded = false;
    const { error } = await answer(submit("ann@example.com"));
    expect(error).toContain("Access is not switched on for this Cloudflare account");
    expect(error).toContain("click Enable Access");
    expect(store.record).toBeUndefined();
  });

  test("an unexpected failure is reported as one", async () => {
    const broken: typeof fetch = async (input, init) => (String(input).includes("/deployments") ? Response.json({ success: true, result: null }) : cf.fetch(input, init));
    const response = await handle(new Request(`https://${HOST}/api/reserve`, { method: "POST", body: JSON.stringify({ token: TOKEN, email: "ann@example.com" }) }), context({ fetcher: broken }));
    expect(response.status).toBe(400);
    expect((await answer(response)).error).toContain("Something went wrong that setup did not expect: TypeError");
  });

  test("an invalid email", async () => {
    expect((await answer(submit("not-an-email"))).error).toBe("Enter a valid email address.");
  });
});

describe("reserved", () => {
  beforeEach(async () => {
    await submit("ann@exmaple.com");
  });

  test("a new token and email replace the reservation without duplicating Access", async () => {
    expect((await submit("ann@example.com")).status).toBe(200);
    expect(store.record?.email).toBe("ann@example.com");
    expect(cf.policies).toHaveLength(1);
    expect(cf.policies[0]!.include).toEqual([{ email: { email: "ann@example.com" } }]);
    expect(cf.apps).toHaveLength(1);
  });

  test("the reserved email's sign-in claims it", async () => {
    const state = await answer<{ viewer: { email: string; role: string } }>(request("/admin/api/state", { jwt: await jwt(cf.keys!, { email: "ann@exmaple.com" }) }));
    expect(state.viewer).toEqual({ email: "ann@exmaple.com", role: "super" });
    expect(store.record?.state).toBe("claimed");
  });

  test("any other sign-in leaves it reserved", async () => {
    expect((await request("/admin/api/state", { jwt: await jwt(cf.keys!, { email: "eve@example.com" }) })).status).toBe(401);
    expect(store.record?.state).toBe("reserved");
  });

  test("reset is only for a claimed instance", async () => {
    expect((await submit("eve@example.com", TOKEN, "/api/reset")).status).toBe(409);
  });
});

describe("claimed", () => {
  beforeEach(async () => {
    await submit("ann@example.com");
    await request("/admin/api/state", { jwt: await jwt(cf.keys!, { email: "ann@example.com" }) });
  });

  test("reserving again is refused and changes nothing", async () => {
    expect((await submit("eve@example.com")).status).toBe(409);
    expect(store.record?.email).toBe("ann@example.com");
  });

  test.each([
    ["no Access header", async () => undefined],
    ["an expired one", async () => jwt(cf.keys!, { email: "ann@example.com", exp: Date.now() / 1000 - 1 })],
    ["one for another Access app", async () => jwt(cf.keys!, { email: "ann@example.com", aud: ["other"] })],
    ["one from another team", async () => jwt(cf.keys!, { email: "ann@example.com", iss: "https://evil.cloudflareaccess.com" })],
    ["one signed by another key", async () => jwt(await rsa(), { email: "ann@example.com" })],
    ["another email", async () => jwt(cf.keys!, { email: "eve@example.com" })],
  ])("the admin API refuses %s", async (_, header) => {
    const token = await header();
    expect((await request("/admin/api/state", token ? { jwt: token } : undefined)).status).toBe(401);
  });

  test("a fresh token at reset reserves it again for a new email", async () => {
    expect((await submit("ann@new.example", TOKEN, "/api/reset")).status).toBe(200);
    expect(store.record).toMatchObject({ state: "reserved", email: "ann@new.example" });
    expect(cf.policies[0]!.include).toEqual([{ email: { email: "ann@new.example" } }]);
  });

  test("reset refuses a token that is not valid", async () => {
    expect((await submit("eve@example.com", "stolen-cookie", "/api/reset")).status).toBe(400);
    expect(store.record?.state).toBe("claimed");
  });
});

// GitHub makes app keys as PKCS#1 PEM; Web Crypto exports PKCS#8, which wraps the PKCS#1 key after a fixed header.
async function githubStyleKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const keys = await rsa();
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  let i = 2 + (der[1]! & 0x80 ? der[1]! & 0x7f : 0) + 3 + 15;
  const lengthByte = der[i + 1]!;
  i += 2 + (lengthByte & 0x80 ? lengthByte & 0x7f : 0);
  const pkcs1 = der.slice(i);
  const base64 = btoa(String.fromCharCode(...pkcs1)).replace(/(.{64})/g, "$1\n");
  return { pem: `-----BEGIN RSA PRIVATE KEY-----\n${base64}\n-----END RSA PRIVATE KEY-----\n`, publicKey: keys.publicKey };
}

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface AdminState {
  viewer: { email: string; role: string };
  setup?: { token: boolean; tokenWorks: boolean; github?: { slug: string; owner: string } };
  settings?: Record<string, Record<string, unknown>>;
  tokenUrl?: string;
}

describe("setup and settings", () => {
  let ann: string;
  const admin = (route: string, json?: unknown) => request(`/admin/api/${route}`, { jwt: ann, ...(json !== undefined ? { json } : {}) });
  const state = () => answer<AdminState>(admin("state"));

  beforeEach(async () => {
    await submit("ann@example.com");
    ann = await jwt(cf.keys!, { email: "ann@example.com" });
    await admin("state");
  });

  test("a new instance's setup has neither step done, and names the wider token's link", async () => {
    const s = await state();
    expect(s.setup).toEqual({ token: false, tokenWorks: true, github: undefined });
    expect(s.tokenUrl).toContain("721b2f51fba74871bd361de65aeb7e03");
    expect(s.settings?.cloudflare).toEqual({ token: "" });
    expect(s).toMatchObject({ configured: { token: true, neonKey: false, resendKey: false } });
  });

  test("a revoked token is reported by the state, and every step that uses it says so", async () => {
    cf.secrets[TOKEN_SECRET] = "revoked";
    expect((await state()).setup?.tokenWorks).toBe(false);
    expect((await answer(admin("settings", { category: "admins", changes: { emails: ["bob@example.com"] } }))).error).toContain("Cloudflare token no longer works");
    expect((await answer(admin("token", { token: WIDE }))).done.join("\n")).toContain("Saved the wider token");
    expect((await state()).setup?.tokenWorks).toBe(true);
  });

  test("the setup token is refused as the wider token, listing everything it lacks at once and how to add it", async () => {
    const { done, error } = await answer(admin("token", { token: TOKEN }));
    expect(done).toContain("Workers: reachable.");
    expect(done).toContain("Cloudflare Access: reachable.");
    expect(error).toContain(`The token is missing ${APP_PERMISSIONS.hyperdrive}, ${APP_PERMISSIONS.r2}, ${APP_PERMISSIONS.zones}.`);
    expect(error).toContain(`${APP_PERMISSIONS.dns} and ${APP_PERMISSIONS.routes} could not be checked`);
    expect(store.record?.setup?.token).toBeUndefined();
  });

  test("a token missing only some zone permissions names just those", async () => {
    cf.denied.add(APP_PERMISSIONS.routes);
    const { done, error } = await answer(admin("token", { token: WIDE }));
    expect(done).toContain("Hyperdrive: reachable.");
    expect(error).toMatch(new RegExp(`^The token is missing ${APP_PERMISSIONS.routes}\\. In Cloudflare`));
    expect(cf.secrets[TOKEN_SECRET]).toBe(TOKEN);
  });

  test("a wider token is checked on every domain and replaces the setup token, also from Settings", async () => {
    expect((await answer(admin("token", { token: WIDE }))).done.join("\n")).toContain("reachable on all 2 domains (acme.dev, acme.app)");
    expect(cf.secrets[TOKEN_SECRET]).toBe(WIDE);
    expect((await state()).setup?.token).toBe(true);
    expect((await answer(admin("settings", { category: "cloudflare", changes: { token: TOKEN } }))).error).toContain(`missing ${APP_PERMISSIONS.hyperdrive}`);
  });

  test("the GitHub App is created from a manifest and saved, and its webhooks checked", async () => {
    const key = await githubStyleKey();
    let installed: string[] = [];
    elsewhere = async (url, init) => {
      if (url.host !== "api.github.com") return undefined;
      if (url.pathname === "/app-manifests/good-code/conversions") return Response.json({ id: 7, slug: "platform-acme", owner: { login: "acme" }, pem: key.pem, webhook_secret: "hook", client_id: "c", client_secret: "s" });
      if (url.pathname === "/app/installations") {
        const [head, body, signature] = new Headers(init?.headers).get("authorization")!.slice(7).split(".") as [string, string, string];
        const raw = Uint8Array.from(atob(signature.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
        const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key.publicKey, raw, new TextEncoder().encode(`${head}.${body}`));
        return valid ? Response.json(installed.map((login) => ({ account: { login } }))) : Response.json({ message: "Bad credentials" }, { status: 401 });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    };

    expect((await answer(admin("github/start", { owner: "not an org!" }))).error).toContain("Enter a GitHub org name");
    const sent = await answer<{ action: string; manifest: string }>(admin("github/start", { owner: "acme" }));
    const state_ = new URL(sent.action).searchParams.get("state")!;
    expect(sent.action).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{32}$/);
    expect(JSON.parse(sent.manifest)).toMatchObject({ redirect_url: `https://${HOST}/admin/github/created`, public: false });

    expect((await answer(admin("github/created", { code: "good-code", state: "forged" }))).error).toContain("did not come from this instance");
    expect((await answer(admin("github/created", { code: "stale", state: state_ }))).error).toContain("GitHub refused to finish creating the app");
    expect((await answer(admin("github/created", { code: "good-code", state: state_ }))).done).toContain("GitHub App platform-acme created under acme.");
    expect(JSON.parse(cf.secrets.GITHUB_APP!).id).toBe(7);
    expect((await state()).setup?.github).toEqual({ slug: "platform-acme", owner: "acme" });
    expect((await state()).settings?.github).toEqual({ app: "platform-acme", owner: "acme" });

    // Installing waits for adding an app; the page GitHub returns to after an install still lists where it is.
    expect((await answer(admin("github/installed", {}))).error).toContain("not installed on any repo yet");
    installed = ["acme"];
    expect((await answer(admin("github/installed", {}))).done).toContain("Installed on acme.");

    const event = JSON.stringify({ zen: "hi" });
    expect((await request("/github/webhook", { method: "POST", body: event, headers: { "x-hub-signature-256": `sha256=${await hmac("hook", event)}` } })).status).toBe(202);
    expect((await request("/github/webhook", { method: "POST", body: event, headers: { "x-hub-signature-256": `sha256=${await hmac("wrong", event)}` } })).status).toBe(401);
  });

  test("Neon and Resend keys are checked before they are kept, and only their last characters come back", async () => {
    elsewhere = async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (url.host === "console.neon.tech") return auth === "Bearer neon-good" ? Response.json({ projects: [] }) : Response.json({ message: "authorization failed" }, { status: 401 });
      if (url.host === "api.resend.com") return auth === "Bearer re_full" ? Response.json({ data: [] }) : auth === "Bearer re_send" ? Response.json({ name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 }) : Response.json({ name: "validation_error" }, { status: 400 });
      return undefined;
    };
    const save = (category: string, changes: Record<string, unknown>) => answer(admin("settings", { category, changes }));
    expect((await save("database", { neonKey: "neon-typo" })).error).toContain("Neon did not accept this key");
    expect((await save("database", { neonKey: "neon-good" })).done).toContain("Saved the Neon key as this instance's secret NEON_API_KEY.");
    expect((await save("email", { resendKey: "re_send" })).error).toBe("This key can only send email; create one with Full access.");
    expect((await save("email", { resendKey: "re_full" })).done).toContain("Resend accepted the key with full access.");
    expect(cf.secrets).toMatchObject({ NEON_API_KEY: "neon-good", RESEND_API_KEY: "re_full" });
    const after = await state();
    expect(after).toMatchObject({ configured: { neonKey: true, resendKey: true }, settings: { database: { neonKey: "" }, email: { resendKey: "" } } });
  });

  test("no response from any endpoint ever carries a secret or any part of one", async () => {
    // Random-looking secrets, so any run of their characters in a reply can only have come from them.
    const wide = "Zq7xKp9WmT3vLr8NjQ2b";
    const neonKey = "Hw4cRt6YuB1nMx5EkV9s";
    const resendKey = "re_Gf3Dp8LsA2qJw7ZtX4";
    const key = await githubStyleKey();
    const app = { webhook: "Wb5hN2kQ8rT4yU7iO1pL", client: "Cs9vB3nM6xZ2aS8dF4gH" };
    elsewhere = async (url) => {
      if (url.host === "console.neon.tech" || url.host === "api.resend.com") return Response.json({});
      if (url.pathname === "/app-manifests/code/conversions") return Response.json({ id: 7, slug: "platform-acme", owner: { login: "acme" }, pem: key.pem, webhook_secret: app.webhook, client_id: "c", client_secret: app.client });
      if (url.pathname === "/app/installations") return Response.json([]);
      return undefined;
    };
    cf.tokens.add(wide);
    const secrets = [TOKEN_LIKE, wide, neonKey, resendKey, app.webhook, app.client, key.pem.split("\n")[1]!];
    const replies: string[] = [];
    const keep = async (response: Promise<Response> | Response) => replies.push(await (await response).text());

    await keep(request("/api/state"));
    await keep(request("/api/reserve", { json: { token: TOKEN_LIKE, email: "ann@example.com" } }));
    await keep(admin("state"));
    await keep(admin("token", { token: wide }));
    await keep(admin("settings", { category: "cloudflare", changes: { token: wide } }));
    await keep(admin("settings", { category: "database", changes: { neonKey } }));
    await keep(admin("settings", { category: "email", changes: { resendKey } }));
    const started = await answer<{ action: string }>(admin("github/start", { owner: "acme" }));
    replies.push(JSON.stringify(started));
    await keep(admin("github/created", { code: "code", state: new URL(started.action).searchParams.get("state") }));
    await keep(admin("github/installed", {}));
    await keep(admin("settings", { category: "admins", changes: { emails: ["bob@example.com"] } }));
    await keep(admin("state"));
    await keep(request("/api/state"));
    await keep(request("/api/reset", { json: { token: TOKEN_LIKE, email: "ann@example.com" } }));
    await keep(request("/api/reserve", { json: { token: "Kj3mN8bV2cX7zL5qW9eR", email: "eve@example.com" } }));

    for (const reply of replies) for (const secret of secrets) for (let i = 0; i + 6 <= secret.length; i++) expect(reply).not.toContain(secret.slice(i, i + 6));
  });

  test("platform admins see only who they are and never reach setup, and a reset keeps them", async () => {
    const save = (emails: string[]) => answer(admin("settings", { category: "admins", changes: { emails } }));
    expect((await save(["bob@example.com", "not-an-email"])).error).toBe("Not valid email addresses: not-an-email.");
    expect((await save(["Bob@Example.com", "ann@example.com"])).done).toContain("Cloudflare Access lets in bob@example.com as platform admins.");
    expect(cf.policies[0]!.include).toEqual([{ email: { email: "ann@example.com" } }, { email: { email: "bob@example.com" } }]);
    expect((await state()).settings?.admins).toEqual({ emails: ["bob@example.com"] });

    const bob = await jwt(cf.keys!, { email: "bob@example.com" });
    expect(await answer(request("/admin/api/state", { jwt: bob }))).toEqual({ build: { version: VERSION, deployedAt: SELF.deployedAt }, viewer: { email: "bob@example.com", role: "platform" } });
    for (const route of ["token", "github/start", "settings"]) expect((await request(`/admin/api/${route}`, { jwt: bob, json: {} })).status).toBe(403);

    await submit("ann@new.example", TOKEN, "/api/reset");
    expect(store.record?.admins).toEqual(["bob@example.com"]);
    expect(cf.policies[0]!.include).toEqual([{ email: { email: "ann@new.example" } }, { email: { email: "bob@example.com" } }]);
  });
});
