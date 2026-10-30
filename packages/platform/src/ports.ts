import type { StaticPoint } from "./runtime/access.js";
export interface Branch {
  id: string;
  name: string;
}

export interface Neon {
  // True when the key can list projects, which a project-scoped key cannot.
  listsProjects(): Promise<boolean>;
  endpointHosts(project: string): Promise<string[]>;
  postgresVersion(project: string): Promise<number>;
  // The project's region as Neon names it, such as aws-us-east-2.
  region(project: string): Promise<string>;
  defaultBranch(project: string): Promise<Branch>;
  findBranch(project: string, name: string): Promise<Branch | undefined>;
  listBranches(project: string, namePrefix: string): Promise<Branch[]>;
  createBranch(project: string, name: string, parentId: string, compute: boolean): Promise<Branch>;
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
  cached: boolean;
}

export interface DnsRecord {
  type: string;
  name: string;
  content: string;
  priority?: number;
}

export interface ZoneRecord extends DnsRecord {
  id: string;
  comment: string | undefined;
}

// What versions before the `--` names wrote on a Worker, read only to remove their old previews.
export interface LegacyWorker {
  app: string | null;
  hyperdriveIds: string[];
}

export interface Cloudflare {
  accountId(): Promise<string>;
  findZone(hostname: string): Promise<Zone | undefined>;
  findHyperdrive(name: string): Promise<Hyperdrive | undefined>;
  listHyperdrives(namePrefix: string): Promise<Hyperdrive[]>;
  createHyperdrive(name: string, connectionUri: string): Promise<Hyperdrive>;
  updateHyperdrive(id: string, connectionUri: string): Promise<Hyperdrive>;
  deleteHyperdrive(id: string): Promise<void>;
  findWorker(name: string): Promise<boolean>;
  legacyWorker(name: string): Promise<LegacyWorker | undefined>;
  listWorkers(namePrefix: string): Promise<string[]>;
  deleteWorker(name: string): Promise<void>;
  workerSecretNames(worker: string): Promise<string[]>;
  dnsRecords(zoneId: string, name: string): Promise<ZoneRecord[]>;
  createDnsRecord(zoneId: string, record: DnsRecord, comment: string): Promise<void>;
  setDnsRecordComment(zoneId: string, id: string, comment: string): Promise<void>;
  commentedDnsRecords(zoneId: string, comment: string): Promise<ZoneRecord[]>;
  findBucket(name: string): Promise<boolean>;
  createBucket(name: string): Promise<void>;
  legacyBucketApp(name: string): Promise<string | null | undefined>;
  deleteBucket(name: string): Promise<void>;
  bucketExpiryDays(name: string): Promise<number | undefined>;
  setBucketExpiry(name: string, days: number): Promise<void>;
  deleteObjects(bucket: string, prefix: string): Promise<number>;
  listObjects(bucket: string, prefix: string): Promise<string[]>;
  copyObject(from: string, key: string, to: string): Promise<void>;
  deleteDnsRecord(zoneId: string, id: string): Promise<void>;
}

export interface MailDomain {
  id: string;
  name: string;
  verified: boolean;
  records: DnsRecord[];
}

export interface Mail {
  findDomain(name: string): Promise<MailDomain | undefined>;
  createDomain(name: string): Promise<MailDomain>;
  verifyDomain(id: string): Promise<void>;
  deleteDomain(id: string): Promise<void>;
  findApiKey(name: string): Promise<string | undefined>;
  createSendKey(name: string, domainId: string): Promise<string>;
  deleteApiKey(id: string): Promise<void>;
}

// The repo that deploys an app, by GitHub's numeric id, which survives renames and transfers.
export interface Repo {
  id: number;
  name: string;
}

// One claim per app name in the account-wide registry.
export interface Registry {
  get(app: string): Promise<Repo | undefined>;
  // Writes only when the app has no claim yet; false when another write got there first.
  claim(app: string, repo: Repo): Promise<boolean>;
  set(app: string, repo: Repo): Promise<void>;
  release(app: string): Promise<void>;
}

export interface Wrangler {
  deploy(wranglerConfig: object, secrets: Record<string, string>): Promise<void>;
  dev(wranglerConfig: object, secrets: Record<string, string>, databaseUrl: string | undefined): Promise<void>;
}

// `custom` names an empty migration for the app's own SQL; `answers` says, for each name
// drizzle-kit asks about, that it was created or which name it was renamed from.
export type GenerateOptions = { custom?: string; answers?: Answers };
// Keyed by the name asked about: `renames` maps it to the old name, `creates` lists new ones.
export type Answers = { renames: Record<string, string>; creates: string[] };

export interface Migrator {
  generate(options?: GenerateOptions): Promise<void>;
  upToDate(): Promise<boolean>;
  migrate(databaseUrl: string): Promise<void>;
  // Installs the platform's access triggers and writes the app's static control points, read from
  // its Worker; run after migrations.
  prepareAccess(databaseUrl: string, points: Record<string, StaticPoint>): Promise<void>;
  // The tables page caching keys by, written at deploy and by dev for any app with a database.
  prepareCache(databaseUrl: string): Promise<void>;
  dropAll(databaseUrl: string): Promise<void>;
  forgetSigningKeys(databaseUrl: string): Promise<void>;
}

export interface GitHub {
  setSecret(name: string, value: string): Promise<void>;
  ensureEnvironment(name: string): Promise<void>;
  openPullRequests(): Promise<number[]>;
  repository(): Promise<Repo>;
}

export interface Ports {
  neon: Neon;
  cloudflare: Cloudflare;
  mail: Mail;
  registry: Registry;
  wrangler: Wrangler;
  migrator: Migrator;
}
