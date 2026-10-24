import type { Branch, Cloudflare, DnsRecord, Hyperdrive, Mail, MailDomain, Migrator, Neon, Ports, Wrangler, Zone, ZoneRecord } from "./ports.js";
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
  workerSecrets = new Map<string, Set<string>>();
  records: ZoneRecord[] = [];
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
    const hyperdrive = { id: `hd-${this.next++}`, name, origin: originOf(uri), cached: false };
    this.hyperdrives.push(hyperdrive);
    return hyperdrive;
  }
  async updateHyperdrive(id: string, uri: string) {
    const hyperdrive = this.hyperdrives.find((h) => h.id === id)!;
    hyperdrive.origin = originOf(uri);
    hyperdrive.cached = false;
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
    this.workerSecrets.delete(name);
  }
  async workerSecretNames(worker: string) {
    return [...(this.workerSecrets.get(worker) ?? [])];
  }
  async dnsRecords(_zoneId: string, name: string) {
    return this.records.filter((r) => r.name === name);
  }
  buckets = new Map<string, { expiryDays?: number; keys: string[] }>();
  async findBucket(name: string) {
    return this.buckets.has(name);
  }
  async createBucket(name: string) {
    this.buckets.set(name, { keys: [] });
  }
  async bucketExpiryDays(name: string) {
    return this.buckets.get(name)?.expiryDays;
  }
  async setBucketExpiry(name: string, days: number) {
    this.buckets.get(name)!.expiryDays = days;
  }
  async deleteObjects(bucket: string, prefix: string) {
    const b = this.buckets.get(bucket)!;
    const before = b.keys.length;
    b.keys = b.keys.filter((k) => !k.startsWith(prefix));
    return before - b.keys.length;
  }
  async managedDnsRecords() {
    return this.records.filter((r) => r.managed);
  }
  async deleteDnsRecord(_zoneId: string, id: string) {
    this.records = this.records.filter((r) => r.id !== id);
  }
  async createDnsRecord(_zoneId: string, record: DnsRecord) {
    this.records.push({ ...record, id: `rec-${this.next++}`, managed: true });
  }
}

export class FakeMail implements Mail {
  domains: MailDomain[] = [];
  keys: { id: string; name: string; domainId: string }[] = [];
  private next = 1;

  async findDomain(name: string) {
    return this.domains.find((d) => d.name === name);
  }
  async createDomain(name: string) {
    const domain = {
      id: `dom-${this.next++}`,
      name,
      verified: false,
      records: [
        { type: "TXT", name: `resend._domainkey.${name.split(".")[0]}`, content: "p=KEY" },
        { type: "MX", name: `send.${name.split(".")[0]}`, content: "feedback-smtp.example.net", priority: 10 },
      ],
    };
    this.domains.push(domain);
    return domain;
  }
  async verifyDomain(id: string) {
    this.domains.find((d) => d.id === id)!.verified = true;
  }
  async findApiKey(name: string) {
    return this.keys.find((k) => k.name === name)?.id;
  }
  async createSendKey(name: string, domainId: string) {
    const id = `key-${this.next++}`;
    this.keys.push({ id, name, domainId });
    return `re_${id}`;
  }
  async deleteApiKey(id: string) {
    this.keys = this.keys.filter((k) => k.id !== id);
  }
}

export class FakeWrangler implements Wrangler {
  deploys: { config: Record<string, unknown>; secrets: Record<string, string> }[] = [];

  devRuns: { config: Record<string, unknown>; secrets: Record<string, string>; databaseUrl: string | undefined }[] = [];

  constructor(private readonly cloudflare: FakeCloudflare) {}

  async dev(config: object, secrets: Record<string, string>, databaseUrl: string | undefined) {
    this.devRuns.push({ config: config as Record<string, unknown>, secrets, databaseUrl });
  }

  async deploy(config: object, secrets: Record<string, string>) {
    const c = config as Record<string, unknown>;
    const name = c.name as string;
    this.deploys.push({ config: c, secrets });
    this.cloudflare.workers.add(name);
    const stored = this.cloudflare.workerSecrets.get(name) ?? new Set<string>();
    for (const key of Object.keys(secrets)) stored.add(key);
    this.cloudflare.workerSecrets.set(name, stored);
  }
}

export class FakeMigrator implements Migrator {
  runs: string[] = [];
  authRuns: string[] = [];
  failWith: Error | undefined;

  async migrate(_command: string, databaseUrl: string) {
    if (this.failWith) throw this.failWith;
    this.runs.push(databaseUrl);
  }
  async migrateAuth(databaseUrl: string) {
    this.authRuns.push(databaseUrl);
  }
}

export function fakePorts() {
  const neon = new FakeNeon();
  const cloudflare = new FakeCloudflare();
  const mail = new FakeMail();
  const wrangler = new FakeWrangler(cloudflare);
  const migrator = new FakeMigrator();
  return { neon, cloudflare, mail, wrangler, migrator } satisfies Ports;
}
