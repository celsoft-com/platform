// The Cloudflare API calls initial setup makes, each naming the token permission it needs so a
// refusal can say which one is missing.

export const PERMISSIONS = {
  scripts: "Workers Scripts Edit",
  settings: "Account Settings Read",
  apps: "Access: Apps and Policies Edit",
  organizations: "Access: Organizations, Identity Providers, and Groups Edit",
} as const;

type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export class SetupError extends Error {}

export class MissingPermission extends SetupError {
  constructor(readonly permission: Permission) {
    super(`The token is missing the ${permission} permission.`);
  }
}

// Any other refusal, kept with what Cloudflare said so the form can show it.
export class CloudflareFailure extends SetupError {
  constructor(method: string, path: string, status: number, detail: string) {
    super(`Cloudflare refused ${method} ${path.split("?")[0]} (${status}${detail ? `: ${detail}` : ""}).`);
  }
}

// Raised when Cloudflare will not make a Zero Trust organization until the account finishes onboarding.
export class ZeroTrustOnboarding extends SetupError {
  constructor() {
    super("This account must finish Zero Trust onboarding first: open Zero Trust in the Cloudflare dashboard, choose the Free plan, then submit again.");
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
}

export interface AccessApp {
  id: string;
  domain: string;
  aud: string;
}

export class Cloudflare {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
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
    if (response.status === 401) throw new SetupError("Cloudflare did not accept this token; check it was copied whole and has not expired.");
    if (response.status === 403) throw new MissingPermission(permission);
    if (!response.ok || !envelope?.success) {
      throw new CloudflareFailure(method, path, response.status, envelope?.errors?.map((e) => `${e.code} ${e.message}`).join("; ") ?? "");
    }
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

  setSecret(account: string, script: string, name: string, text: string) {
    return this.call<unknown>(PERMISSIONS.scripts, "PUT", `/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/secrets`, { name, text, type: "secret_text" });
  }

  async organization(account: string): Promise<Organization | undefined> {
    try {
      const org = await this.call<Organization | null>(PERMISSIONS.organizations, "GET", `/accounts/${account}/access/organizations`);
      return org?.auth_domain ? org : undefined;
    } catch (error) {
      if (error instanceof CloudflareFailure) return undefined;
      throw error;
    }
  }

  async createOrganization(account: string): Promise<Organization> {
    try {
      return await this.call<Organization>(PERMISSIONS.organizations, "POST", `/accounts/${account}/access/organizations`, {});
    } catch (error) {
      if (error instanceof CloudflareFailure) throw new ZeroTrustOnboarding();
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

  savePolicy(account: string, id: string | undefined, name: string, email: string) {
    const body = { name, decision: "allow", include: [{ email: { email } }] };
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
}
