// The Cloudflare API calls initial setup makes, each naming the token permission it needs so a
// refusal can say which one is missing.

export const PERMISSIONS = {
  scripts: "Workers Scripts Edit",
  settings: "Account Settings Read",
  apps: "Access: Apps and Policies Edit",
  organizations: "Access: Organizations, Identity Providers, and Groups Edit",
} as const;

// What deploying apps adds, asked for by complete setup's wider token.
export const APP_PERMISSIONS = {
  hyperdrive: "Hyperdrive Edit",
  r2: "Workers R2 Storage Edit",
  zones: "Zone Read",
  dns: "DNS Edit",
  routes: "Workers Routes Edit",
} as const;

type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS] | (typeof APP_PERMISSIONS)[keyof typeof APP_PERMISSIONS];

export class SetupError extends Error {}

export class MissingPermission extends SetupError {
  constructor(
    readonly permission: Permission,
    said: string,
  ) {
    super(`The token is missing the ${permission} permission${said ? ` (Cloudflare said: ${said})` : ""}.`);
  }
}

// Any other refusal, kept with what Cloudflare said so the form can show it.
export class CloudflareFailure extends SetupError {
  constructor(method: string, path: string, status: number, detail: string) {
    super(`Cloudflare refused ${method} ${path.split("?")[0]} (${status}${detail ? `: ${detail}` : ""}).`);
  }
}

export const REVOKED = "This instance's Cloudflare token no longer works: it was revoked, expired or deleted. Create a new one on the Wider token step.";

// The instance's own token stopped working, as opposed to a pasted one being wrong.
export class TokenRevoked extends SetupError {
  constructor() {
    super(REVOKED);
  }
}

// Access is off for the account, which Cloudflare answers with a 403 like a missing permission.
export class AccessNotEnabled extends SetupError {}

// Raised when Access is off and Cloudflare will not switch it on through the API.
export class ZeroTrustOnboarding extends SetupError {
  constructor() {
    super("Access is not switched on for this Cloudflare account. In the Cloudflare dashboard, open Zero Trust, click Enable Access and choose the Free plan, then submit again.");
  }
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

export interface Account {
  id: string;
}

export interface Organization {
  auth_domain: string;
}

export interface IdentityProvider {
  id: string;
  type: string;
}

export interface Policy {
  id: string;
  name: string;
  include?: { email?: { email: string } }[];
}

export interface Zone {
  id: string;
  name: string;
}

export interface AccessApp {
  id: string;
  domain: string;
  aud: string;
}

export class Cloudflare {
  // `stored` marks the instance's own token, kept as its secret, so a refusal says it stopped working rather than blaming what was pasted.
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly stored = false,
  ) {}

  private async call<T>(permission: Permission, method: string, path: string, body?: unknown): Promise<T> {
    // Called unbound: Workers' fetch throws "Illegal invocation" when called as another object's method.
    const fetcher = this.fetcher;
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const envelope = (await response.json().catch(() => undefined)) as Envelope<T> | undefined;
    if (response.status === 401) throw this.stored ? new TokenRevoked() : new SetupError("Cloudflare did not accept this token; check it was copied whole and has not expired.");
    const said = envelope?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "";
    if (envelope?.errors?.some((e) => e.message.includes("access.api.error.not_enabled"))) throw new AccessNotEnabled(said);
    if (response.status === 403) throw new MissingPermission(permission, said);
    if (!response.ok || !envelope?.success) throw new CloudflareFailure(method, path, response.status, said);
    return envelope.result;
  }

  accounts() {
    return this.call<Account[]>(PERMISSIONS.settings, "GET", "/accounts?per_page=50");
  }

  scripts(account: string) {
    return this.call<{ id: string }[]>(PERMISSIONS.scripts, "GET", `/accounts/${account}/workers/scripts`);
  }

  // The first deployment is the one serving traffic now.
  async servingVersions(account: string, script: string): Promise<string[]> {
    const { deployments } = await this.call<{ deployments: { versions: { version_id: string }[] }[] }>(PERMISSIONS.scripts, "GET", `/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/deployments`);
    return deployments[0]?.versions.map((v) => v.version_id) ?? [];
  }

  secrets(account: string, script: string) {
    return this.call<{ name: string }[]>(PERMISSIONS.scripts, "GET", `/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/secrets`);
  }

  setSecret(account: string, script: string, name: string, text: string) {
    return this.call<unknown>(PERMISSIONS.scripts, "PUT", `/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/secrets`, { name, text, type: "secret_text" });
  }

  async organization(account: string): Promise<Organization | undefined> {
    try {
      const org = await this.call<Organization | null>(PERMISSIONS.organizations, "GET", `/accounts/${account}/access/organizations`);
      return org?.auth_domain ? org : undefined;
    } catch (error) {
      if (error instanceof CloudflareFailure || error instanceof AccessNotEnabled) return undefined;
      throw error;
    }
  }

  async createOrganization(account: string): Promise<Organization> {
    try {
      return await this.call<Organization>(PERMISSIONS.organizations, "POST", `/accounts/${account}/access/organizations`, {});
    } catch (error) {
      if (error instanceof CloudflareFailure || error instanceof AccessNotEnabled) throw new ZeroTrustOnboarding();
      throw error;
    }
  }

  identityProviders(account: string) {
    return this.call<IdentityProvider[]>(PERMISSIONS.organizations, "GET", `/accounts/${account}/access/identity_providers`);
  }

  createOneTimePin(account: string) {
    return this.call<IdentityProvider>(PERMISSIONS.organizations, "POST", `/accounts/${account}/access/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} });
  }

  policies(account: string) {
    return this.call<Policy[]>(PERMISSIONS.apps, "GET", `/accounts/${account}/access/policies?per_page=1000`);
  }

  policy(account: string, id: string) {
    return this.call<Policy>(PERMISSIONS.apps, "GET", `/accounts/${account}/access/policies/${id}`);
  }

  savePolicy(account: string, id: string | undefined, name: string, emails: string[]) {
    const body = { name, decision: "allow", include: emails.map((email) => ({ email: { email } })) };
    return id
      ? this.call<Policy>(PERMISSIONS.apps, "PUT", `/accounts/${account}/access/policies/${id}`, body)
      : this.call<Policy>(PERMISSIONS.apps, "POST", `/accounts/${account}/access/policies`, body);
  }

  apps(account: string) {
    return this.call<AccessApp[]>(PERMISSIONS.apps, "GET", `/accounts/${account}/access/apps?per_page=1000`);
  }

  saveApp(account: string, id: string | undefined, app: { name: string; domain: string; idp: string; policy: string }) {
    const body = {
      name: app.name,
      type: "self_hosted",
      domain: app.domain,
      allowed_idps: [app.idp],
      auto_redirect_to_identity: true,
      session_duration: "24h",
      policies: [{ id: app.policy, precedence: 1 }],
    };
    return id
      ? this.call<AccessApp>(PERMISSIONS.apps, "PUT", `/accounts/${account}/access/apps/${id}`, body)
      : this.call<AccessApp>(PERMISSIONS.apps, "POST", `/accounts/${account}/access/apps`, body);
  }

  hyperdrives(account: string) {
    return this.call<unknown[]>(APP_PERMISSIONS.hyperdrive, "GET", `/accounts/${account}/hyperdrive/configs`);
  }

  buckets(account: string) {
    return this.call<unknown>(APP_PERMISSIONS.r2, "GET", `/accounts/${account}/r2/buckets`);
  }

  zones(account: string) {
    return this.call<Zone[]>(APP_PERMISSIONS.zones, "GET", `/zones?account.id=${account}&per_page=50`);
  }

  dnsRecords(zone: string) {
    return this.call<unknown[]>(APP_PERMISSIONS.dns, "GET", `/zones/${zone}/dns_records?per_page=1`);
  }

  routes(zone: string) {
    return this.call<unknown[]>(APP_PERMISSIONS.routes, "GET", `/zones/${zone}/workers/routes`);
  }
}
