export interface Branch {
  id: string;
  name: string;
}

export interface Neon {
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
  managed: boolean;
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
  workerSecretNames(worker: string): Promise<string[]>;
  dnsRecords(zoneId: string, name: string): Promise<ZoneRecord[]>;
  createDnsRecord(zoneId: string, record: DnsRecord): Promise<void>;
  managedDnsRecords(zoneId: string): Promise<ZoneRecord[]>;
  findBucket(name: string): Promise<boolean>;
  createBucket(name: string): Promise<void>;
  bucketExpiryDays(name: string): Promise<number | undefined>;
  setBucketExpiry(name: string, days: number): Promise<void>;
  deleteObjects(bucket: string, prefix: string): Promise<number>;
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
  findApiKey(name: string): Promise<string | undefined>;
  createSendKey(name: string, domainId: string): Promise<string>;
  deleteApiKey(id: string): Promise<void>;
}

export interface Wrangler {
  deploy(wranglerConfig: object, secrets: Record<string, string>): Promise<void>;
  dev(wranglerConfig: object, secrets: Record<string, string>, databaseUrl: string | undefined): Promise<void>;
}

export interface Migrator {
  migrate(command: string, databaseUrl: string): Promise<void>;
  migrateAuth(databaseUrl: string): Promise<void>;
}

export interface GitHub {
  setSecret(name: string, value: string): Promise<void>;
  ensureEnvironment(name: string): Promise<void>;
}

export interface Ports {
  neon: Neon;
  cloudflare: Cloudflare;
  mail: Mail;
  wrangler: Wrangler;
  migrator: Migrator;
}
