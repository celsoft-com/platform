// The Neon calls deploying an app makes: each app gets a Neon project of its own, prod on its
// default branch, previews and backups as branches copied from it.

import { SetupError } from "./cloudflare.ts";

export const POSTGRES = 18;
export const DEFAULT_REGION = "aws-us-east-2";

export interface Branch {
  id: string;
  name: string;
  default: boolean;
  created_at?: string;
}

export interface Project {
  id: string;
  region_id: string;
  pg_version: number;
}

export class Neon {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call<T>(what: string, method: string, path: string, body?: unknown): Promise<T> {
    const fetcher = this.fetcher;
    const response = await fetcher(`https://console.neon.tech/api/v2${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json().catch(() => undefined)) as (T & { message?: string }) | undefined;
    if (response.status === 401) throw new SetupError("Neon no longer accepts the instance's key; replace it in Settings, Database.");
    if (!response.ok) throw new NeonFailure(what, response.status, result?.message ?? "");
    return result as T;
  }

  // An organization key makes projects in its organization; a personal key in one of the
  // person's, so it names the only one it has.
  async createProject(name: string, region = DEFAULT_REGION): Promise<Project> {
    const project = { name, pg_version: POSTGRES, region_id: region };
    try {
      return (await this.call<{ project: Project }>(`make the Neon project ${name}`, "POST", "/projects", { project })).project;
    } catch (error) {
      if (!(error instanceof NeonFailure) || !/org_id/i.test(error.message)) throw error;
      const { organizations } = await this.call<{ organizations: { id: string }[] }>("list your Neon organizations", "GET", "/users/me/organizations");
      if (organizations.length !== 1) throw new SetupError("The Neon key reaches more than one organization; use an organization API key instead, from the organization's Settings, API keys.");
      return (await this.call<{ project: Project }>(`make the Neon project ${name}`, "POST", "/projects", { project: { ...project, org_id: organizations[0]!.id } })).project;
    }
  }

  async project(id: string): Promise<Project | undefined> {
    try {
      return (await this.call<{ project: Project }>("read the app's Neon project", "GET", `/projects/${id}`)).project;
    } catch (error) {
      if (error instanceof NeonFailure && error.status === 404) return undefined;
      throw error;
    }
  }

  deleteProject(id: string) {
    return this.call<unknown>("delete the app's Neon project", "DELETE", `/projects/${id}`);
  }

  async branches(project: string): Promise<Branch[]> {
    return (await this.call<{ branches: Branch[] }>("list the app's database branches", "GET", `/projects/${project}/branches`)).branches;
  }

  async createBranch(project: string, name: string, parent: string, endpoint: boolean): Promise<Branch> {
    const body = { branch: { name, parent_id: parent }, ...(endpoint ? { endpoints: [{ type: "read_write" }] } : {}) };
    return (await this.call<{ branch: Branch }>(`make the database branch ${name}`, "POST", `/projects/${project}/branches`, body)).branch;
  }

  deleteBranch(project: string, id: string) {
    return this.call<unknown>("delete a database branch", "DELETE", `/projects/${project}/branches/${id}`);
  }

  // The direct (unpooled) address of a branch's database: Hyperdrive pools connections itself.
  async connectionUri(project: string, branch: string): Promise<string> {
    const { databases } = await this.call<{ databases: { name: string; owner_name: string }[] }>("read the database's name", "GET", `/projects/${project}/branches/${branch}/databases`);
    const db = databases[0];
    if (!db) throw new SetupError("The app's Neon branch has no database.");
    const query = new URLSearchParams({ branch_id: branch, database_name: db.name, role_name: db.owner_name, pooled: "false" });
    return (await this.call<{ uri: string }>("read the database's address", "GET", `/projects/${project}/connection_uri?${query}`)).uri;
  }
}

export class NeonFailure extends SetupError {
  constructor(
    what: string,
    readonly status: number,
    said: string,
  ) {
    super(`Neon refused to ${what} (${status}${said ? `: ${said}` : ""}).`);
  }
}

// Cloudflare's placement hint for a Neon region, such as aws-us-east-2 to aws:us-east-2.
export function placement(region: string): string | undefined {
  const [, provider, rest] = /^(aws|azure|gcp)-(.+)$/.exec(region) ?? [];
  if (!provider || !rest) return undefined;
  return `${provider}:${provider === "azure" && rest === "gwc" ? "germanywestcentral" : rest}`;
}
