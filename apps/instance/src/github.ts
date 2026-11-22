// The instance's own GitHub App: the manifest that creates it, turning GitHub's code into its
// credentials, signing in as it, and checking its webhooks.

import { SetupError } from "./cloudflare.ts";

export interface GitHubApp {
  id: number;
  slug: string;
  owner: string;
  pem: string;
  webhook_secret: string;
  client_id: string;
  client_secret: string;
}

const API = "https://api.github.com";
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "celsoft-platform-instance", "x-github-api-version": "2022-11-28" };

// GitHub's form that creates an app from a manifest, under a person or an org.
export function manifestAction(owner: string, state: string): string {
  const base = owner ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new` : "https://github.com/settings/apps/new";
  return `${base}?state=${encodeURIComponent(state)}`;
}

export function manifest(host: string, script: string): string {
  const account = host.split(".")[1] ?? "";
  return JSON.stringify({
    name: `${script}-${account}`.slice(0, 34),
    url: `https://${host}`,
    hook_attributes: { url: `https://${host}/github/webhook` },
    redirect_url: `https://${host}/admin/github/created`,
    setup_url: `https://${host}/admin/github/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: { contents: "read", metadata: "read", pull_requests: "write", statuses: "write" },
    default_events: ["push", "pull_request"],
  });
}

// `what` names the call in an error, in words, so a refusal never shows a one-time code.
async function github<T>(fetcher: typeof fetch, what: string, method: string, path: string, auth?: string): Promise<T> {
  const response = await fetcher(`${API}${path}`, { method, headers: { ...HEADERS, ...(auth ? { authorization: auth } : {}) } });
  const body = (await response.json().catch(() => undefined)) as (T & { message?: string }) | undefined;
  if (!response.ok) throw new SetupError(`GitHub refused to ${what} (${response.status}${body?.message ? `: ${body.message}` : ""}).`);
  return body as T;
}

// GitHub hands back a one-time code after the app is created; it is good for an hour.
export async function convert(code: string, fetcher: typeof fetch = fetch): Promise<GitHubApp> {
  const app = await github<Omit<GitHubApp, "owner"> & { owner: { login: string } }>(fetcher, "finish creating the app; codes last an hour, so create it again if this one is old", "POST", `/app-manifests/${encodeURIComponent(code)}/conversions`);
  return { id: app.id, slug: app.slug, owner: app.owner.login, pem: app.pem, webhook_secret: app.webhook_secret, client_id: app.client_id, client_secret: app.client_secret };
}

export async function installations(app: GitHubApp, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string[]> {
  const list = await github<{ account: { login: string } }[]>(fetcher, "list the app's installations", "GET", "/app/installations", `Bearer ${await appJwt(app, now)}`);
  return list.map((i) => i.account.login);
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const text = (s: string) => b64url(new TextEncoder().encode(s));

export async function appJwt(app: GitHubApp, now = Date.now()): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const unsigned = `${text(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${text(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: String(app.id) }))}`;
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(app.pem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${b64url(signature)}`;
}

function derLength(n: number): number[] {
  if (n < 128) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

// GitHub gives a PKCS#1 key ("BEGIN RSA PRIVATE KEY"); Web Crypto imports only PKCS#8, which wraps it.
export function pkcs8(pem: string): Uint8Array<ArrayBuffer> {
  const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  if (pem.includes("BEGIN PRIVATE KEY")) return der;
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octets = [0x04, ...derLength(der.length), ...der];
  const body = [0x02, 0x01, 0x00, ...algorithm, ...octets];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

export async function webhookSigned(app: GitHubApp, body: string, signature: string | null): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(app.webhook_secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const hex = signature.slice(7);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
}
