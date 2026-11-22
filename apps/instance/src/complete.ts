// Complete setup: the six steps the super admin takes on the admin page so the instance can
// deploy apps. Each step checks its own work and adds what it confirmed to `done`.

import { APP_PERMISSIONS, Cloudflare, MissingPermission, SetupError, type Zone } from "./cloudflare.ts";
import { convert, installations, manifest, manifestAction, type GitHubApp } from "./github.ts";
import { EMAIL, policyName, TOKEN_SECRET, type InstanceRecord, type Progress, type Self, type Store } from "./setup.ts";

export const SECRETS = { github: "GITHUB_APP", neon: "NEON_API_KEY", resend: "RESEND_API_KEY" } as const;

// The Worker's secrets as this request's version sees them.
export interface Secrets {
  CLOUDFLARE_API_TOKEN?: string;
  GITHUB_APP?: string;
  NEON_API_KEY?: string;
  RESEND_API_KEY?: string;
}

export interface Context {
  store: Store;
  self: Self;
  secrets: Secrets;
  fetcher: typeof fetch;
}

async function claimed(ctx: Context): Promise<InstanceRecord> {
  const record = await ctx.store.get();
  if (record?.state !== "claimed") throw new SetupError("This instance is not claimed yet.");
  return record;
}

function stored(ctx: Context): Cloudflare {
  const token = ctx.secrets.CLOUDFLARE_API_TOKEN;
  if (!token) throw new SetupError("This instance has no Cloudflare token. If you just saved one, wait a few seconds for the new version to deploy, then reload; otherwise create one on the Wider token step.");
  return new Cloudflare(token, ctx.fetcher, true);
}

// Whether the instance's own token still works for its account, checked on every visit to the home page.
export async function tokenWorks(ctx: Context): Promise<boolean> {
  const record = await claimed(ctx);
  try {
    return (await stored(ctx).accounts()).some((a) => a.id === record.account);
  } catch (error) {
    if (error instanceof SetupError) return false;
    throw error;
  }
}

async function progress(ctx: Context, record: InstanceRecord, change: Partial<Progress>, admins = record.admins): Promise<void> {
  const next = { ...record, admins, setup: { ...record.setup, ...change } };
  await ctx.store.put(next);
  if (JSON.stringify(await ctx.store.get()) !== JSON.stringify(next)) throw new SetupError("This step could not be saved in this instance's storage; try again.");
}

async function saveSecret(cf: Cloudflare, record: InstanceRecord, name: string, value: string, done: string[], what: string): Promise<void> {
  await cf.setSecret(record.account, record.script, name, value);
  if (!(await cf.secrets(record.account, record.script)).some((s) => s.name === name)) throw new SetupError(`Cloudflare accepted ${what} as a secret but does not list it; try again.`);
  done.push(`Saved ${what} as this instance's secret ${name}.`);
}

export async function widerToken(ctx: Context, input: string, done: string[]): Promise<void> {
  const record = await claimed(ctx);
  const token = input.trim();
  if (!token) throw new SetupError("Paste the token you created.");
  const cf = new Cloudflare(token, ctx.fetcher);
  if (!(await cf.accounts()).some((a) => a.id === record.account)) throw new SetupError("This token does not reach the Cloudflare account running this instance; create it in that account.");
  done.push("Reaches the account running this instance.");

  // Every permission is checked, so one edit of the token can fix all that is missing.
  const missing = new Set<string>();
  const check = async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run();
      if (label) done.push(`${label}: reachable.`);
      return true;
    } catch (error) {
      if (!(error instanceof MissingPermission)) throw error;
      missing.add(error.permission);
      return false;
    }
  };
  await check("Workers", () => cf.servingVersions(record.account, record.script));
  await check("Cloudflare Access", async () => {
    await cf.identityProviders(record.account);
    await cf.apps(record.account);
  });
  await check("Hyperdrive", () => cf.hyperdrives(record.account));
  await check("R2 storage", () => cf.buckets(record.account));
  let zones: Zone[] = [];
  if (await check("", async () => (zones = await cf.zones(record.account)))) {
    if (!zones.length) throw new SetupError("The token reaches none of this account's domains; edit it in Cloudflare so its zone permissions cover all zones, then paste it again.");
    let reached = true;
    for (const zone of zones) {
      reached = (await check("", () => cf.dnsRecords(zone.id))) && reached;
      reached = (await check("", () => cf.routes(zone.id))) && reached;
    }
    if (reached) done.push(`DNS and Worker routes: reachable on all ${zones.length} domains (${zones.map((z) => z.name).join(", ")}).`);
  }
  if (missing.size) {
    const unchecked = missing.has(APP_PERMISSIONS.zones) ? ` Without ${APP_PERMISSIONS.zones}, ${APP_PERMISSIONS.dns} and ${APP_PERMISSIONS.routes} could not be checked; make sure it has those too.` : "";
    throw new SetupError(
      `The token is missing ${[...missing].join(", ")}.${unchecked} In Cloudflare, open Manage Account, then Account API Tokens, edit this token, add ${missing.size === 1 ? "that permission" : "those permissions"} (zone ones on all zones), save, and paste the same token here again; editing keeps its value.`,
    );
  }
  await saveSecret(cf, record, TOKEN_SECRET, token, done, "the wider token");
  await progress(ctx, record, { token: true });
}

// The form that sends the manifest to GitHub, and the state GitHub must hand back with its code.
export async function githubStart(ctx: Context, owner: string): Promise<{ action: string; manifest: string }> {
  const record = await claimed(ctx);
  const name = owner.trim();
  if (!/^[A-Za-z0-9-]*$/.test(name)) throw new SetupError("Enter a GitHub org name, or leave it empty for your own account.");
  const state = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await progress(ctx, record, { githubState: state });
  return { action: manifestAction(name, state), manifest: manifest(ctx.self.host, record.script) };
}

export async function githubCreated(ctx: Context, code: string, state: string, done: string[]): Promise<void> {
  const record = await claimed(ctx);
  if (!state || state !== record.setup?.githubState) throw new SetupError("This link did not come from this instance's latest GitHub step; start the GitHub App step again.");
  const app = await convert(code, ctx.fetcher);
  done.push(`GitHub App ${app.slug} created under ${app.owner}.`);
  await saveSecret(stored(ctx), record, SECRETS.github, JSON.stringify(app), done, "the GitHub App's credentials");
  await progress(ctx, record, { githubState: undefined, github: { slug: app.slug, owner: app.owner, installations: [] } });
}

export async function githubInstalled(ctx: Context, done: string[]): Promise<void> {
  const record = await claimed(ctx);
  if (!record.setup?.github) throw new SetupError("Create the GitHub App first.");
  const secret = ctx.secrets.GITHUB_APP;
  if (!secret) throw new SetupError("The GitHub App's credentials are still deploying; wait a few seconds, then reload this page.");
  const found = await installations(JSON.parse(secret) as GitHubApp, ctx.fetcher);
  await progress(ctx, record, { github: { ...record.setup.github, installations: found } });
  if (!found.length) throw new SetupError(`${record.setup.github.slug} is not installed anywhere yet; click Install on GitHub.`);
  done.push(`Installed on ${found.join(", ")}.`);
}

async function keyCheck(ctx: Context, url: string, key: string, refused: (status: number, body: Record<string, unknown> | undefined) => string | undefined): Promise<void> {
  // Called unbound, as Workers' fetch requires.
  const response = await (0, ctx.fetcher)(url, { headers: { authorization: `Bearer ${key}`, accept: "application/json" } });
  if (response.ok) return;
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  throw new SetupError(refused(response.status, body) ?? `Refused (${response.status}${body?.message ? `: ${String(body.message)}` : ""}).`);
}

export async function neon(ctx: Context, input: string, done: string[]): Promise<void> {
  const record = await claimed(ctx);
  const key = input.trim();
  if (!key) throw new SetupError("Paste the Neon API key.");
  await keyCheck(ctx, "https://console.neon.tech/api/v2/projects?limit=1", key, (status, body) =>
    status === 401 ? "Neon did not accept this key; check it was copied whole." : `Neon refused the key (${status}${body?.message ? `: ${String(body.message)}` : ""}).`,
  );
  done.push("Neon accepted the key and lists the organization's projects.");
  await saveSecret(stored(ctx), record, SECRETS.neon, key, done, "the Neon key");
  await progress(ctx, record, { neon: true });
}

export async function resend(ctx: Context, input: string, done: string[]): Promise<void> {
  const record = await claimed(ctx);
  const key = input.trim();
  if (!key) throw new SetupError("Paste the Resend API key.");
  await keyCheck(ctx, "https://api.resend.com/domains", key, (status, body) =>
    body?.name === "restricted_api_key" ? "This key can only send email; create one with Full access." : status === 401 || status === 400 ? "Resend did not accept this key; check it was copied whole." : undefined,
  );
  done.push("Resend accepted the key with full access.");
  await saveSecret(stored(ctx), record, SECRETS.resend, key, done, "the Resend key");
  await progress(ctx, record, { resend: true });
}

export async function admins(ctx: Context, input: string, done: string[]): Promise<void> {
  const record = await claimed(ctx);
  const emails = [...new Set(input.split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))].filter((e) => e !== record.email);
  const bad = emails.filter((e) => !EMAIL.test(e));
  if (bad.length) throw new SetupError(`Not valid email addresses: ${bad.join(", ")}.`);
  const cf = stored(ctx);
  const name = policyName(record.script);
  const policy = (await cf.policies(record.account)).find((p) => p.name === name);
  if (!policy) throw new SetupError("This instance's Access rule is missing; reset the super admin at /reset to make it again.");
  await cf.savePolicy(record.account, policy.id, name, [record.email, ...emails]);
  const allowed = new Set((await cf.policy(record.account, policy.id)).include?.map((r) => r.email?.email));
  const missing = [record.email, ...emails].filter((e) => !allowed.has(e));
  if (missing.length) throw new SetupError(`Cloudflare Access saved the rule but does not list ${missing.join(", ")}; try again.`);
  done.push(emails.length ? `Cloudflare Access lets in ${emails.join(", ")} as platform admins.` : "No platform admins; only you can sign in.");
  await progress(ctx, record, {}, emails);
}
