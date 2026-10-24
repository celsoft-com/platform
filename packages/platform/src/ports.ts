export interface Branch {
  id: string;
  name: string;
}

export interface Neon {
  defaultBranch(project: string): Promise<Branch>;
  findBranch(project: string, name: string): Promise<Branch | undefined>;
  createBranch(project: string, name: string, parentId: string): Promise<Branch>;
  deleteBranch(project: string, branchId: string): Promise<void>;
  connectionUri(project: string, branchId: string): Promise<string>;
}

export interface Zone {
  id: string;
  name: string;
}

export interface Hyperdrive {
  id: string;
  name: string;
  origin: string;
}

export interface Cloudflare {
  accountId(): Promise<string>;
  findZone(hostname: string): Promise<Zone | undefined>;
  findHyperdrive(name: string): Promise<Hyperdrive | undefined>;
  createHyperdrive(name: string, connectionUri: string): Promise<Hyperdrive>;
  updateHyperdrive(id: string, connectionUri: string): Promise<Hyperdrive>;
  deleteHyperdrive(id: string): Promise<void>;
  findWorker(name: string): Promise<boolean>;
  deleteWorker(name: string): Promise<void>;
}

export interface Wrangler {
  deploy(wranglerConfig: object, secrets: Record<string, string>): Promise<void>;
}

export interface Migrator {
  migrate(command: string, databaseUrl: string): Promise<void>;
}

export interface Ports {
  neon: Neon;
  cloudflare: Cloudflare;
  wrangler: Wrangler;
  migrator: Migrator;
}
