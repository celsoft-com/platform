import CloudflareClient from "cloudflare";
import { LEGACY_BUCKET_MARKER, LEGACY_PLATFORM_TAG } from "../legacy.js";
import type { Cloudflare, DnsRecord, Hyperdrive, LegacyWorker, Zone, ZoneRecord } from "../ports.js";
import { R2S3 } from "./r2.js";
import { originOf } from "../target.js";

const EXPIRY_RULE = "platform-expiry";

export class CloudflareApi implements Cloudflare {
  private readonly client: CloudflareClient;
  private account: string | undefined;
  readonly s3: R2S3;

  constructor(apiToken: string) {
    this.client = new CloudflareClient({ apiToken });
    this.s3 = new R2S3(apiToken, () => this.accountId());
  }

  async accountId(): Promise<string> {
    if (this.account) return this.account;
    const accounts = [];
    for await (const account of this.client.accounts.list()) accounts.push(account);
    if (accounts.length !== 1) {
      throw new Error(`the Cloudflare token must reach exactly one account, but reaches ${accounts.length}; set Account Resources to a single account`);
    }
    this.account = accounts[0]!.id;
    return this.account;
  }

  async findZone(hostname: string): Promise<Zone | undefined> {
    const labels = hostname.split(".");
    for (let i = 0; i < labels.length - 1; i++) {
      const name = labels.slice(i).join(".");
      const page = await this.client.zones.list({ name });
      const zone = page.result[0];
      if (zone) return { id: zone.id, name: zone.name };
    }
    return undefined;
  }

  async findHyperdrive(name: string): Promise<Hyperdrive | undefined> {
    const account_id = await this.accountId();
    for await (const config of this.client.hyperdrive.configs.list({ account_id })) {
      if (config.name === name) {
        const origin = config.origin as { user: string; host: string; database: string; port?: number };
        return { id: config.id, name, origin: `${origin.user}@${origin.host}/${origin.database}`, cached: !config.caching?.disabled };
      }
    }
    return undefined;
  }

  async listHyperdrives(namePrefix: string): Promise<Hyperdrive[]> {
    const account_id = await this.accountId();
    const found: Hyperdrive[] = [];
    for await (const config of this.client.hyperdrive.configs.list({ account_id })) {
      if (config.name.startsWith(namePrefix)) found.push((await this.findHyperdrive(config.name))!);
    }
    return found;
  }

  async createHyperdrive(name: string, connectionUri: string): Promise<Hyperdrive> {
    const account_id = await this.accountId();
    const created = await this.client.hyperdrive.configs.create({ account_id, name, origin: originParams(connectionUri), caching: { disabled: true } });
    return { id: created.id, name, origin: originOf(connectionUri), cached: false };
  }

  async updateHyperdrive(id: string, connectionUri: string): Promise<Hyperdrive> {
    const account_id = await this.accountId();
    const updated = await this.client.hyperdrive.configs.edit(id, { account_id, origin: originParams(connectionUri), caching: { disabled: true } });
    return { id, name: updated.name, origin: originOf(connectionUri), cached: false };
  }

  async deleteHyperdrive(id: string): Promise<void> {
    await this.client.hyperdrive.configs.delete(id, { account_id: await this.accountId() });
  }

  async findWorker(name: string): Promise<boolean> {
    const account_id = await this.accountId();
    for await (const script of this.client.workers.scripts.list({ account_id })) {
      if (script.id === name) return true;
    }
    return false;
  }

  async legacyWorker(name: string): Promise<LegacyWorker | undefined> {
    if (!(await this.findWorker(name))) return undefined;
    const account_id = await this.accountId();
    const { tags } = await this.client.workers.scripts.settings.get(name, { account_id });
    const { bindings = [] } = await this.client.workers.scripts.scriptAndVersionSettings.get(name, { account_id });
    const app = tags?.includes(LEGACY_PLATFORM_TAG) ? (tags.find((t) => t.startsWith("app:"))?.slice(4) ?? null) : null;
    const hyperdriveIds = (bindings as { type: string; id?: string }[]).filter((b) => b.type === "hyperdrive" && b.id).map((b) => b.id!);
    return { app, hyperdriveIds };
  }

  async listWorkers(namePrefix: string): Promise<string[]> {
    const account_id = await this.accountId();
    const names: string[] = [];
    for await (const script of this.client.workers.scripts.list({ account_id })) {
      if (script.id?.startsWith(namePrefix)) names.push(script.id);
    }
    return names;
  }

  async deleteWorker(name: string): Promise<void> {
    await this.client.workers.scripts.delete(name, { account_id: await this.accountId(), force: true });
  }

  async workerSecretNames(worker: string): Promise<string[]> {
    if (!(await this.findWorker(worker))) return [];
    const names: string[] = [];
    for await (const secret of this.client.workers.scripts.secrets.list(worker, { account_id: await this.accountId() })) {
      if (secret.name) names.push(secret.name);
    }
    return names;
  }

  async dnsRecords(zoneId: string, name: string): Promise<ZoneRecord[]> {
    return this.listRecords({ zone_id: zoneId, name: { exact: name } });
  }

  async commentedDnsRecords(zoneId: string, comment: string): Promise<ZoneRecord[]> {
    return this.listRecords({ zone_id: zoneId, comment: { exact: comment } });
  }

  async setDnsRecordComment(zoneId: string, id: string, comment: string): Promise<void> {
    await this.client.dns.records.edit(id, { zone_id: zoneId, comment } as Parameters<typeof this.client.dns.records.edit>[1]);
  }

  async findBucket(name: string): Promise<boolean> {
    const { buckets = [] } = await this.client.r2.buckets.list({ account_id: await this.accountId(), name_contains: name });
    return buckets.some((b) => b.name === name);
  }

  async createBucket(name: string): Promise<void> {
    await this.client.r2.buckets.create({ account_id: await this.accountId(), name });
  }

  async legacyBucketApp(name: string): Promise<string | null | undefined> {
    if (!(await this.findBucket(name))) return undefined;
    const response = await this.client.r2.buckets.objects.get(LEGACY_BUCKET_MARKER, { account_id: await this.accountId(), bucket_name: name }).catch(() => undefined);
    return response?.ok ? (await response.text()).trim() : null;
  }

  async deleteBucket(name: string): Promise<void> {
    await this.client.r2.buckets.delete(name, { account_id: await this.accountId() });
  }

  async bucketExpiryDays(name: string): Promise<number | undefined> {
    const { rules = [] } = await this.client.r2.buckets.lifecycle.get(name, { account_id: await this.accountId() });
    const condition = rules.find((r) => r.id === EXPIRY_RULE && r.enabled)?.deleteObjectsTransition?.condition;
    return condition?.type === "Age" ? condition.maxAge / 86400 : undefined;
  }

  async setBucketExpiry(name: string, days: number): Promise<void> {
    await this.client.r2.buckets.lifecycle.update(name, {
      account_id: await this.accountId(),
      rules: [{ id: EXPIRY_RULE, enabled: true, conditions: { prefix: "" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: days * 86400 } } }],
    });
  }

  async deleteObjects(bucket: string, prefix: string): Promise<number> {
    const keys = await this.listObjects(bucket, prefix);
    await this.s3.deleteMany(bucket, keys);
    return keys.length;
  }

  async listObjects(bucket: string, prefix: string): Promise<string[]> {
    return this.s3.list(bucket, prefix);
  }

  async copyObject(from: string, key: string, to: string): Promise<void> {
    await this.s3.copy(from, key, to);
  }

  async deleteDnsRecord(zoneId: string, id: string): Promise<void> {
    await this.client.dns.records.delete(id, { zone_id: zoneId });
  }

  private async listRecords(params: Parameters<typeof this.client.dns.records.list>[0]): Promise<ZoneRecord[]> {
    const records: ZoneRecord[] = [];
    for await (const r of this.client.dns.records.list(params)) {
      const priority = "priority" in r ? r.priority : undefined;
      records.push({ id: r.id, type: r.type, name: r.name, content: String(r.content ?? ""), ...(priority !== undefined && { priority }), comment: r.comment ?? undefined });
    }
    return records;
  }

  async createDnsRecord(zoneId: string, record: DnsRecord, comment: string): Promise<void> {
    await this.client.dns.records.create({
      zone_id: zoneId,
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: 1,
      comment,
      ...(record.priority !== undefined && { priority: record.priority }),
    } as Parameters<typeof this.client.dns.records.create>[0]);
  }
}

function originParams(connectionUri: string) {
  const url = new URL(connectionUri);
  return {
    scheme: "postgresql" as const,
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
