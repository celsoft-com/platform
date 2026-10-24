import type { Branch, Cloudflare, Hyperdrive, Migrator, Neon, Ports, Wrangler, Zone } from "./ports.js";
import { originOf } from "./target.js";

export class FakeNeon implements Neon {
  branches: Branch[] = [{ id: "br-prod", name: "production" }];
  private next = 1;

  async defaultBranch() {
    return this.branches[0]!;
  }
  async findBranch(_project: string, name: string) {
    return this.branches.find((b) => b.name === name);
  }
  async listBranches(_project: string, namePrefix: string) {
    return this.branches.filter((b) => b.name.startsWith(namePrefix));
  }
  async createBranch(_project: string, name: string) {
    const branch = { id: `br-${this.next++}`, name };
    this.branches.push(branch);
    return branch;
  }
  async deleteBranch(_project: string, branchId: string) {
    this.branches = this.branches.filter((b) => b.id !== branchId);
  }
  async connectionUri(_project: string, branchId: string) {
    return `postgresql://owner:secret@${branchId}.neon.test/app`;
  }
}

export class FakeCloudflare implements Cloudflare {
  zones: Zone[] = [{ id: "zone-1", name: "example.com" }];
  hyperdrives: Hyperdrive[] = [];
  workers = new Set<string>();
  private next = 1;

  async accountId() {
    return "acct-1";
  }
  async findZone(hostname: string) {
    return this.zones.find((z) => hostname === z.name || hostname.endsWith(`.${z.name}`));
  }
  async findHyperdrive(name: string) {
    return this.hyperdrives.find((h) => h.name === name);
  }
  async createHyperdrive(name: string, uri: string) {
    const hyperdrive = { id: `hd-${this.next++}`, name, origin: originOf(uri) };
    this.hyperdrives.push(hyperdrive);
    return hyperdrive;
  }
  async updateHyperdrive(id: string, uri: string) {
    const hyperdrive = this.hyperdrives.find((h) => h.id === id)!;
    hyperdrive.origin = originOf(uri);
    return hyperdrive;
  }
  async deleteHyperdrive(id: string) {
    this.hyperdrives = this.hyperdrives.filter((h) => h.id !== id);
  }
  async findWorker(name: string) {
    return this.workers.has(name);
  }
  async deleteWorker(name: string) {
    this.workers.delete(name);
  }
}

export class FakeWrangler implements Wrangler {
  deploys: { config: Record<string, unknown>; secrets: Record<string, string> }[] = [];

  constructor(private readonly cloudflare: FakeCloudflare) {}

  async deploy(config: object, secrets: Record<string, string>) {
    const c = config as Record<string, unknown>;
    this.deploys.push({ config: c, secrets });
    this.cloudflare.workers.add(c.name as string);
  }
}

export class FakeMigrator implements Migrator {
  runs: string[] = [];
  failWith: Error | undefined;

  async migrate(_command: string, databaseUrl: string) {
    if (this.failWith) throw this.failWith;
    this.runs.push(databaseUrl);
  }
}

export function fakePorts() {
  const neon = new FakeNeon();
  const cloudflare = new FakeCloudflare();
  const wrangler = new FakeWrangler(cloudflare);
  const migrator = new FakeMigrator();
  return { neon, cloudflare, wrangler, migrator } satisfies Ports;
}
