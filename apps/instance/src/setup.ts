// Initial setup: reserving the instance with a token and an email, and claiming it when that
// email signs in through Cloudflare Access. docs/design.md section 16 is the design.

import { accessEmail } from "./access.ts";
import { Cloudflare, SetupError } from "./cloudflare.ts";

// No record means Unclaimed.
export interface InstanceRecord {
  state: "reserved" | "claimed";
  email: string;
  account: string;
  script: string;
  authDomain: string;
  aud: string;
  admins?: string[];
  setup?: Progress;
}

// Complete setup's steps, each kept once the instance has confirmed it.
export interface Progress {
  token?: boolean;
  githubState?: string;
  github?: { slug: string; owner: string; installations: string[] };
  neon?: boolean;
  resend?: boolean;
}

export interface Store {
  get(): Promise<InstanceRecord | undefined>;
  put(record: InstanceRecord): Promise<void>;
}

// What the Worker knows about itself: the version serving this request, when it was deployed, and the address it was reached at.
export interface Self {
  version: string;
  deployedAt?: string;
  host: string;
}

export const ADMIN_PATH = "/admin";
export const TOKEN_SECRET = "CLOUDFLARE_API_TOKEN";

export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const policyName = (script: string) => `${script} super admin`;

// Each step it finishes is added to `done`, in words for the person setting up, so a failure shows how far it got.
export async function reserve(store: Store, self: Self, input: { token: string; email: string }, done: string[] = [], fetcher: typeof fetch = fetch): Promise<InstanceRecord> {
  const token = input.token.trim();
  const email = input.email.trim().toLowerCase();
  if (!token) throw new SetupError("Paste the token you created.");
  if (!EMAIL.test(email)) throw new SetupError("Enter a valid email address.");
  const cf = new Cloudflare(token, fetcher);
  const { account, script } = await findSelf(cf, self.version);
  done.push(`Token accepted: it reaches the account running this instance, the Worker ${script}.`);

  const org = (await cf.organization(account)) ?? (await cf.createOrganization(account));
  done.push(`Cloudflare Access is on for the account, team ${org.auth_domain}.`);
  const idp = (await cf.identityProviders(account)).find((p) => p.type === "onetimepin") ?? (await cf.createOneTimePin(account));
  done.push("Sign-in with an emailed code is on.");
  // A reset keeps complete setup's progress and the platform admins, who keep signing in.
  const before = await store.get();
  const admins = before?.admins ?? [];
  const name = policyName(script);
  const policy = await cf.savePolicy(account, (await cf.policies(account)).find((p) => p.name === name)?.id, name, [email, ...admins]);
  done.push(admins.length ? `Only ${email} and the platform admins may sign in.` : `Only ${email} may sign in.`);
  const domain = `${self.host}${ADMIN_PATH}`;
  const app = await cf.saveApp(account, (await cf.apps(account)).find((a) => a.domain === domain)?.id, { name: script, domain, idp: idp.id, policy: policy.id });
  if (!(await cf.apps(account)).some((a) => a.domain === domain)) throw new SetupError(`Cloudflare accepted the Access application for ${domain} but does not list it; submit again.`);
  done.push(`Cloudflare Access protects ${domain}.`);

  // Saved before the token: saving the token deploys a new version of this Worker, which restarts its storage.
  const record: InstanceRecord = { ...before, state: "reserved", email, account, script, authDomain: org.auth_domain, aud: app.aud };
  await store.put(record);
  if ((await store.get())?.email !== email) throw new SetupError("The reservation could not be saved in this instance's storage; submit again.");
  done.push(`Reserved for ${email}.`);

  await cf.setSecret(account, script, TOKEN_SECRET, token);
  if (!(await cf.secrets(account, script)).some((s) => s.name === TOKEN_SECRET)) throw new SetupError("Cloudflare accepted the token as this instance's secret but does not list it; submit again.");
  done.push("Token saved as this instance's secret.");
  return record;
}

// The token must reach the account running this very Worker: the script whose serving deployment is this version.
async function findSelf(cf: Cloudflare, version: string): Promise<{ account: string; script: string }> {
  for (const { id: account } of await cf.accounts()) {
    for (const { id: script } of await cf.scripts(account)) {
      if ((await cf.servingVersions(account, script)).includes(version)) return { account, script };
    }
  }
  throw new SetupError("This token does not reach the Cloudflare account running this instance; create it in that account.");
}

export interface Viewer {
  email: string;
  role: "super" | "platform";
}

// Who is signed in, when the request carries Cloudflare Access's signature for this instance: the
// super admin, claiming a reserved instance on their first sign-in, or a platform admin.
export async function viewer(store: Store, header: string | null, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Viewer | undefined> {
  const record = await store.get();
  if (!record) return undefined;
  const email = await accessEmail(header, record, fetcher, now);
  if (!email) return undefined;
  if (email === record.email) {
    if (record.state === "reserved") await store.put({ ...record, state: "claimed" });
    return { email, role: "super" };
  }
  if (record.state === "claimed" && record.admins?.includes(email)) return { email, role: "platform" };
  return undefined;
}
