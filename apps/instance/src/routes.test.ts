import { beforeEach, describe, expect, test } from "vitest";
import { APP_PERMISSIONS, PERMISSIONS } from "./cloudflare.ts";
import type { Secrets } from "./complete.ts";
import { handle } from "./routes.ts";
import { ADMIN_PATH, TOKEN_SECRET, type InstanceRecord, type Self, type Store } from "./setup.ts";

const TOKEN = "good-token";
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
    if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${WIDE}`) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 });
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    const narrow = auth === `Bearer ${TOKEN}`;
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
const context = (over: Partial<{ store: Store; self: Self; fetcher: typeof fetch }> = {}) => ({
  store,
  self: SELF,
  secrets: cf.secrets,
  fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => (await elsewhere(new URL(String(input)), init)) ?? strict(input, init)) as typeof fetch,
  ...over,
});

const request = (path: string, init?: { form?: Record<string, string> | URLSearchParams; jwt?: string; method?: string; body?: string; headers?: Record<string, string> }) =>
  handle(
    new Request(`https://${HOST}${path}`, {
      method: init?.method ?? (init?.form ? "POST" : "GET"),
      ...(init?.form ? { body: new URLSearchParams(init.form) } : init?.body ? { body: init.body } : {}),
      headers: { ...(init?.jwt ? { "cf-access-jwt-assertion": init.jwt } : {}), ...init?.headers },
    }),
    context(),
  );

const submit = (email: string, token = TOKEN, path = "/") => request(path, { form: { token, email } });

beforeEach(async () => {
  cf = new FakeCloudflare();
  cf.keys = await rsa();
  store = new MemoryStore();
  elsewhere = () => undefined;
});

describe("unclaimed", () => {
  test("shows the setup form with a link that creates the token", async () => {
    const response = await request("/");
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Set up this instance");
    expect(html).toContain("permissionGroupKeys");
    for (const permission of Object.values(PERMISSIONS)) expect(html).toContain(permission.replace(/&/g, "&amp;"));
  });

  test("every page shows which build is serving", async () => {
    expect(await (await request("/")).text()).toContain("Build 0f1e2d3c · 2026-11-22 20:15 UTC");
  });

  test("a valid token and email reserve it and set up Access for that email alone", async () => {
    const response = await submit("Ann@Example.com");
    expect(response.status).toBe(200);
    const shown = await response.text();
    for (const step of ["Token accepted", "Cloudflare Access is on", "Sign-in with an emailed code is on", "Only ann@example.com may sign in", "Cloudflare Access protects", "Reserved for ann@example.com", "Token saved"]) expect(shown).toContain(step);
    expect(store.record).toEqual({ state: "reserved", email: "ann@example.com", account: "acct", script: "platform", authDomain: TEAM, aud: "aud-1" });
    expect(cf.secrets[TOKEN_SECRET]).toBe(TOKEN);
    expect(cf.idps).toEqual([{ id: expect.any(String), type: "onetimepin" }]);
    expect(cf.policies).toEqual([expect.objectContaining({ include: [{ email: { email: "ann@example.com" } }], decision: "allow" })]);
    expect(cf.apps).toEqual([expect.objectContaining({ domain: `${HOST}${ADMIN_PATH}`, policies: [{ id: cf.policies[0]!.id, precedence: 1 }] })]);
    const waiting = await (await request("/")).text();
    expect(waiting).toContain("One step left: sign in");
    expect(waiting).toContain(`href="${ADMIN_PATH}">Sign in as ann@example.com</a>`);
    expect(waiting).toContain("Wrong email, or no code arriving?");
    expect(waiting).toContain("Reserve again");
  });

  test("switches Access on when the account has never used it", async () => {
    expect((await submit("ann@example.com")).status).toBe(200);
    expect(cf.accessOn).toBe(true);
    expect(store.record?.authDomain).toBe(TEAM);
  });

  test("reuses a Zero Trust organization and one-time PIN login the account already has", async () => {
    cf.organization = { auth_domain: "existing.cloudflareaccess.com" };
    cf.idps.push({ id: "otp", type: "onetimepin" });
    await submit("ann@example.com");
    expect(store.record?.authDomain).toBe("existing.cloudflareaccess.com");
    expect(cf.idps).toHaveLength(1);
  });
});

describe("refused tokens", () => {
  test("a token Cloudflare does not accept", async () => {
    const response = await submit("ann@example.com", "typo");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Cloudflare did not accept this token");
    expect(store.record).toBeUndefined();
  });

  test.each(Object.values(PERMISSIONS))("a token missing %s names it", async (permission) => {
    cf.denied.add(permission);
    const html = await (await submit("ann@example.com")).text();
    expect(html).toContain(`missing the ${permission.replace(/&/g, "&amp;")} permission (Cloudflare said: 10000 Authentication error)`);
    expect(store.record).toBeUndefined();
  });

  test("a token for an account not running this instance", async () => {
    const response = await handle(new Request(`https://${HOST}/`, { method: "POST", body: new URLSearchParams({ token: TOKEN, email: "ann@example.com" }) }), context({ self: { version: "not-deployed-here", host: HOST } }));
    expect(await response.text()).toContain("does not reach the Cloudflare account running this instance");
    expect(store.record).toBeUndefined();
  });

  test("a failure shows the steps that finished and the one that stopped it", async () => {
    cf.denied.add(PERMISSIONS.apps);
    const html = await (await submit("ann@example.com")).text();
    expect(html).toContain('<li class="instance-done">Token accepted');
    expect(html).toContain('<li class="instance-done">Sign-in with an emailed code is on.');
    expect(html).toContain(`<li class="instance-failed" role="alert">The token is missing the ${PERMISSIONS.apps}`);
  });

  test("a reservation the instance cannot read back is reported, not lost", async () => {
    const forgetful: Store = { get: async () => undefined, put: async () => {} };
    const response = await handle(new Request(`https://${HOST}/`, { method: "POST", body: new URLSearchParams({ token: TOKEN, email: "ann@example.com" }) }), context({ store: forgetful }));
    expect(await response.text()).toContain("could not be saved in this instance");
    expect(cf.secrets[TOKEN_SECRET]).toBeUndefined();
  });

  test("an account whose Access is off and that Cloudflare will not switch on says to click Enable Access", async () => {
    cf.onboarded = false;
    const html = await (await submit("ann@example.com")).text();
    expect(html).toContain("Access is not switched on for this Cloudflare account");
    expect(html).toContain("click Enable Access");
    expect(html).not.toContain("missing the");
    expect(store.record).toBeUndefined();
  });

  test("an unexpected failure shows on the form instead of an error page", async () => {
    const broken: typeof fetch = async (input, init) => (String(input).includes("/deployments") ? Response.json({ success: true, result: null }) : cf.fetch(input, init));
    const response = await handle(new Request(`https://${HOST}/`, { method: "POST", body: new URLSearchParams({ token: TOKEN, email: "ann@example.com" }) }), context({ fetcher: broken }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Something went wrong that setup did not expect: TypeError");
  });

  test("an invalid email, keeping what was typed", async () => {
    const html = await (await submit("not-an-email")).text();
    expect(html).toContain("Enter a valid email address");
    expect(html).toContain('value="not-an-email"');
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
    const response = await request(ADMIN_PATH, { jwt: await jwt(cf.keys!, { email: "ann@exmaple.com" }) });
    const home = await response.text();
    expect(home).toContain("Complete setup");
    expect(home).toContain("Signed in as <strong>ann@exmaple.com</strong>, the super admin");
    expect(store.record?.state).toBe("claimed");
  });

  test("any other sign-in leaves it reserved", async () => {
    const response = await request(ADMIN_PATH, { jwt: await jwt(cf.keys!, { email: "eve@example.com" }) });
    expect(response.status).toBe(303);
    expect(store.record?.state).toBe("reserved");
  });

  test("/reset is only for a claimed instance", async () => {
    expect((await request("/reset")).headers.get("location")).toBe("/");
  });
});

describe("claimed", () => {
  beforeEach(async () => {
    await submit("ann@example.com");
    await request(ADMIN_PATH, { jwt: await jwt(cf.keys!, { email: "ann@example.com" }) });
  });

  test("the setup form is gone: / leads to the home page and a submit to it changes nothing", async () => {
    expect((await request("/")).headers.get("location")).toBe(ADMIN_PATH);
    expect((await submit("eve@example.com")).headers.get("location")).toBe(ADMIN_PATH);
    expect(store.record?.email).toBe("ann@example.com");
  });

  test.each([
    ["no Access header", async () => undefined],
    ["an expired one", async () => jwt(cf.keys!, { email: "ann@example.com", exp: Date.now() / 1000 - 1 })],
    ["one for another Access app", async () => jwt(cf.keys!, { email: "ann@example.com", aud: ["other"] })],
    ["one from another team", async () => jwt(cf.keys!, { email: "ann@example.com", iss: "https://evil.cloudflareaccess.com" })],
    ["one signed by another key", async () => jwt(await rsa(), { email: "ann@example.com" })],
    ["another email", async () => jwt(cf.keys!, { email: "eve@example.com" })],
  ])("home refuses %s", async (_, header) => {
    const token = await header();
    const response = await request(ADMIN_PATH, token ? { jwt: token } : undefined);
    expect(response.status).toBe(403);
  });

  test("a fresh token at /reset reserves it again for a new email", async () => {
    expect((await request("/reset")).status).toBe(200);
    expect((await submit("ann@new.example", TOKEN, "/reset")).status).toBe(200);
    expect(store.record).toMatchObject({ state: "reserved", email: "ann@new.example" });
    expect(cf.policies[0]!.include).toEqual([{ email: { email: "ann@new.example" } }]);
  });

  test("/reset refuses a token that is not valid", async () => {
    expect((await submit("eve@example.com", "stolen-cookie", "/reset")).status).toBe(400);
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

describe("complete setup", () => {
  let ann: string;
  const admin = (step: string, form?: Record<string, string> | URLSearchParams) => request(`${ADMIN_PATH}/${step}`, { jwt: ann, ...(form ? { form } : {}) });
  const home = async () => (await request(ADMIN_PATH, { jwt: ann })).text();

  beforeEach(async () => {
    await submit("ann@example.com");
    ann = await jwt(cf.keys!, { email: "ann@example.com" });
    await request(ADMIN_PATH, { jwt: ann });
  });

  test("home is a checklist of six steps, none done", async () => {
    const html = await home();
    for (const step of ["token", "domains", "github", "database", "email", "admins"]) expect(html).toContain(`<li class="instance-todo"><a href="/admin/${step}">`);
  });

  test("a revoked token is reported on the home page and every step that uses it, with the way to a new one", async () => {
    cf.secrets[TOKEN_SECRET] = "revoked";
    const html = await home();
    expect(html).toContain("Cloudflare token no longer works");
    expect(html).toContain('<a href="/admin/token">Create a new token</a>');
    expect(await (await admin("token")).text()).toContain("token stopped working");
    expect(await (await admin("admins", { emails: "bob@example.com" })).text()).toContain("Cloudflare token no longer works");
    expect(await (await admin("token", { token: WIDE })).text()).toContain("Saved the wider token");
    expect(await home()).not.toContain("no longer works");
  });

  test("the setup token is refused as the wider token, listing everything it lacks at once and how to add it", async () => {
    const html = await (await admin("token", { token: TOKEN })).text();
    expect(html).toContain('<li class="instance-done">Workers: reachable.');
    expect(html).toContain('<li class="instance-done">Cloudflare Access: reachable.');
    expect(html).toContain(`The token is missing ${APP_PERMISSIONS.hyperdrive}, ${APP_PERMISSIONS.r2}, ${APP_PERMISSIONS.zones}.`);
    expect(html).toContain(`${APP_PERMISSIONS.dns} and ${APP_PERMISSIONS.routes} could not be checked`);
    expect(html).toContain("paste the same token here again");
    expect(store.record?.setup?.token).toBeUndefined();
  });

  test("a token missing only some zone permissions names just those", async () => {
    cf.denied.add(APP_PERMISSIONS.routes);
    const html = await (await admin("token", { token: WIDE })).text();
    expect(html).toContain('<li class="instance-done">Hyperdrive: reachable.');
    expect(html).toContain(`The token is missing ${APP_PERMISSIONS.routes}. In Cloudflare`);
    expect(cf.secrets[TOKEN_SECRET]).toBe(TOKEN);
  });

  test("a wider token is checked on every domain and replaces the setup token", async () => {
    const html = await (await admin("token", { token: WIDE })).text();
    expect(html).toContain("reachable on all 2 domains (acme.dev, acme.app)");
    expect(cf.secrets[TOKEN_SECRET]).toBe(WIDE);
    expect(await home()).toContain('<li class="instance-done"><a href="/admin/token">');
  });

  test("domains wait for the wider token, then save the ones picked", async () => {
    expect(await (await admin("domains", { domain: "acme.dev" })).text()).toContain("Finish the wider token step first");
    await admin("token", { token: WIDE });
    const page = await (await admin("domains")).text();
    expect(page).toContain('value="acme.app"');
    expect(await (await admin("domains", {})).text()).toContain("Pick at least one domain");
    const html = await (await admin("domains", new URLSearchParams([["domain", "acme.dev"]]))).text();
    expect(html).toContain("Apps may use acme.dev.");
    expect(store.record?.setup?.domains).toEqual(["acme.dev"]);
  });

  test("right after the wider token is saved, a version still holding the setup token says to wait", async () => {
    await admin("token", { token: WIDE });
    cf.secrets[TOKEN_SECRET] = TOKEN;
    expect(await (await admin("domains")).text()).toContain("The wider token is still deploying");
  });

  test("the GitHub App is created from a manifest, saved, installed and its webhooks checked", async () => {
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

    const send = await (await admin("github", { owner: "acme" })).text();
    const state = send.match(/state=([0-9a-f]{32})/)![1]!;
    expect(send).toContain('action="https://github.com/organizations/acme/settings/apps/new?state=');
    expect(send).toContain(`redirect_url&#34;:&#34;https://${HOST}/admin/github/created`);

    expect(await (await admin(`github/created?code=good-code&state=forged`)).text()).toContain("did not come from this instance");
    expect(await (await admin(`github/created?code=stale&state=${state}`)).text()).toContain("GitHub refused to finish creating the app");
    const created = await (await admin(`github/created?code=good-code&state=${state}`)).text();
    expect(created).toContain("GitHub App platform-acme created under acme.");
    expect(created).toContain("https://github.com/apps/platform-acme/installations/new");
    expect(JSON.parse(cf.secrets.GITHUB_APP!).id).toBe(7);

    expect(await (await admin("github/installed")).text()).toContain("not installed anywhere yet");
    installed = ["acme"];
    expect(await (await admin("github/installed")).text()).toContain("Installed on acme.");
    expect(await home()).toContain('<li class="instance-done"><a href="/admin/github">GitHub App</a>: platform-acme, installed on acme.');

    const event = JSON.stringify({ zen: "hi" });
    expect((await request("/github/webhook", { method: "POST", body: event, headers: { "x-hub-signature-256": `sha256=${await hmac("hook", event)}` } })).status).toBe(202);
    expect((await request("/github/webhook", { method: "POST", body: event, headers: { "x-hub-signature-256": `sha256=${await hmac("wrong", event)}` } })).status).toBe(401);
  });

  test("Neon and Resend keys are checked before they are kept", async () => {
    elsewhere = async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (url.host === "console.neon.tech") return auth === "Bearer neon-good" ? Response.json({ projects: [] }) : Response.json({ message: "authorization failed" }, { status: 401 });
      if (url.host === "api.resend.com") return auth === "Bearer re_full" ? Response.json({ data: [] }) : auth === "Bearer re_send" ? Response.json({ name: "restricted_api_key", message: "This API key is restricted to only send emails" }, { status: 401 }) : Response.json({ name: "validation_error" }, { status: 400 });
      return undefined;
    };
    expect(await (await admin("database", { key: "neon-typo" })).text()).toContain("Neon did not accept this key");
    expect(await (await admin("database", { key: "neon-good" })).text()).toContain("Saved the Neon key as this instance&#39;s secret NEON_API_KEY.");
    expect(await (await admin("email", { key: "re_send" })).text()).toContain("This key can only send email; create one with Full access.");
    expect(await (await admin("email", { key: "re_full" })).text()).toContain("Resend accepted the key with full access.");
    expect(cf.secrets).toMatchObject({ NEON_API_KEY: "neon-good", RESEND_API_KEY: "re_full" });
    expect(store.record?.setup).toMatchObject({ neon: true, resend: true });
  });

  test("platform admins sign in to their own page and never reach setup, and a reset keeps them", async () => {
    expect(await (await admin("admins", { emails: "bob@example.com, not-an-email" })).text()).toContain("Not valid email addresses: not-an-email.");
    expect(await (await admin("admins", { emails: "Bob@Example.com\nann@example.com" })).text()).toContain("lets in bob@example.com as platform admins");
    expect(cf.policies[0]!.include).toEqual([{ email: { email: "ann@example.com" } }, { email: { email: "bob@example.com" } }]);

    const bob = await jwt(cf.keys!, { email: "bob@example.com" });
    expect(await (await request(ADMIN_PATH, { jwt: bob })).text()).toContain("You are a platform admin");
    for (const step of ["token", "domains", "github", "database", "email", "admins"]) expect((await request(`${ADMIN_PATH}/${step}`, { jwt: bob })).status).toBe(403);

    await submit("ann@new.example", TOKEN, "/reset");
    expect(store.record?.admins).toEqual(["bob@example.com"]);
    expect(cf.policies[0]!.include).toEqual([{ email: { email: "ann@new.example" } }, { email: { email: "bob@example.com" } }]);
  });
});
