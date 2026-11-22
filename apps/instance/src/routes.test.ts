import { beforeEach, describe, expect, test } from "vitest";
import { PERMISSIONS } from "./cloudflare.ts";
import { handle } from "./routes.ts";
import { ADMIN_PATH, TOKEN_SECRET, type InstanceRecord, type Store } from "./setup.ts";

const TOKEN = "good-token";
const VERSION = "0f1e2d3c-4b5a-4687-9a1b-2c3d4e5f6071";
const HOST = "platform.acme.workers.dev";
const TEAM = "acme.cloudflareaccess.com";

// The slice of Cloudflare's API initial setup uses, for one token and two accounts.
class FakeCloudflare {
  denied = new Set<string>();
  onboarded = true;
  accessOn = false;
  organization: { auth_domain: string } | undefined;
  idps: { id: string; type: string }[] = [];
  policies: { id: string; name: string; include: unknown }[] = [];
  apps: { id: string; domain: string; aud: string; policies: unknown }[] = [];
  secrets: Record<string, string> = {};
  keys: CryptoKeyPair | undefined;
  private next = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.host === TEAM) {
      const jwk = await crypto.subtle.exportKey("jwk", this.keys!.publicKey);
      return Response.json({ keys: [{ ...jwk, kid: "k1" }] });
    }
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 401 });
    const method = init?.method ?? "GET";
    const path = url.pathname.replace("/client/v4", "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    const deny = (permission: string) => this.denied.has(permission) && Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
    const id = () => `id-${++this.next}`;

    if (path === "/accounts") return deny(PERMISSIONS.settings) || ok([{ id: "other" }, { id: "acct" }]);
    const match = path.match(/^\/accounts\/(\w+)(\/.*)$/);
    if (!match) return new Response(null, { status: 404 });
    const [, account, rest] = match as unknown as [string, string, string];
    if (rest === "/workers/scripts") return deny(PERMISSIONS.scripts) || ok(account === "acct" ? [{ id: "blog" }, { id: "platform" }] : [{ id: "elsewhere" }]);
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
      if (method === "GET") return ok(this.policies);
      const existing = this.policies.find((p) => rest.endsWith(`/${p.id}`));
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

const request = (path: string, init?: { form?: Record<string, string>; jwt?: string }) =>
  handle(
    new Request(`https://${HOST}${path}`, {
      method: init?.form ? "POST" : "GET",
      ...(init?.form ? { body: new URLSearchParams(init.form) } : {}),
      headers: init?.jwt ? { "cf-access-jwt-assertion": init.jwt } : {},
    }),
    store,
    { version: VERSION, deployedAt: "2026-11-22T20:15:42.123Z", host: HOST },
    strict as typeof fetch,
  );

const submit = (email: string, token = TOKEN, path = "/") => request(path, { form: { token, email } });

beforeEach(async () => {
  cf = new FakeCloudflare();
  cf.keys = await rsa();
  store = new MemoryStore();
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
    const response = await handle(new Request(`https://${HOST}/`, { method: "POST", body: new URLSearchParams({ token: TOKEN, email: "ann@example.com" }) }), store, { version: "not-deployed-here", host: HOST }, cf.fetch);
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
    const response = await handle(new Request(`https://${HOST}/`, { method: "POST", body: new URLSearchParams({ token: TOKEN, email: "ann@example.com" }) }), forgetful, { version: VERSION, host: HOST }, strict as typeof fetch);
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
    const response = await handle(new Request(`https://${HOST}/`, { method: "POST", body: new URLSearchParams({ token: TOKEN, email: "ann@example.com" }) }), store, { version: VERSION, host: HOST }, broken);
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
    expect(home).toContain("Initial setup is complete");
    expect(home).toContain("Next comes complete setup");
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
