import { createApiClient, EndpointType } from "@neondatabase/api-client";
import type { Branch, Neon } from "../ports.js";

export class NeonApi implements Neon {
  private readonly api: ReturnType<typeof createApiClient>;

  constructor(apiKey: string) {
    this.api = createApiClient({ apiKey });
  }

  async endpointHosts(project: string): Promise<string[]> {
    const { data } = await this.api.listProjectEndpoints(project);
    return data.endpoints.map((e) => e.host);
  }

  async postgresVersion(project: string): Promise<number> {
    const { data } = await this.api.getProject(project);
    return Number(data.project.pg_version);
  }

  async defaultBranch(project: string): Promise<Branch> {
    const { data } = await this.api.listProjectBranches({ projectId: project });
    const branch = data.branches.find((b) => b.default);
    if (!branch) throw new Error(`Neon project ${project} has no default branch`);
    return { id: branch.id, name: branch.name };
  }

  async findBranch(project: string, name: string): Promise<Branch | undefined> {
    const { data } = await this.api.listProjectBranches({ projectId: project, search: name });
    const branch = data.branches.find((b) => b.name === name);
    return branch && { id: branch.id, name: branch.name };
  }

  async listBranches(project: string, namePrefix: string): Promise<Branch[]> {
    const { data } = await this.api.listProjectBranches({ projectId: project, search: namePrefix });
    return data.branches.filter((b) => b.name.startsWith(namePrefix)).map((b) => ({ id: b.id, name: b.name }));
  }

  async createBranch(project: string, name: string, parentId: string, compute: boolean): Promise<Branch> {
    const { data } = await this.api.createProjectBranch(project, {
      branch: { name, parent_id: parentId },
      endpoints: compute ? [{ type: EndpointType.ReadWrite }] : [],
    });
    return { id: data.branch.id, name: data.branch.name };
  }

  async deleteBranch(project: string, branchId: string): Promise<void> {
    await this.api.deleteProjectBranch({ projectId: project, branchId });
  }

  async connectionUri(project: string, branchId: string): Promise<string> {
    const { data } = await this.api.listProjectBranchDatabases(project, branchId);
    const database = data.databases[0];
    if (!database) throw new Error(`Neon branch ${branchId} has no database`);
    const { data: uri } = await this.api.getConnectionUri({
      projectId: project,
      branch_id: branchId,
      database_name: database.name,
      role_name: database.owner_name,
      // Hyperdrive does its own pooling, so it needs Neon's direct endpoint.
      pooled: false,
    });
    return uri.uri;
  }
}
