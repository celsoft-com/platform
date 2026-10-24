import CloudflareClient from "cloudflare";
import { MANAGED_COMMENT } from "../lifecycle.js";
import type { Cloudflare, DnsRecord, Hyperdrive, Zone, ZoneRecord } from "../ports.js";
import { originOf } from "../target.js";

export class CloudflareApi implements Cloudflare {
  private readonly client: CloudflareClient;
  private account: string | undefined;

  constructor(apiToken: string) {
    this.client = new CloudflareClient({ apiToken });
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

  async managedDnsRecords(zoneId: string): Promise<ZoneRecord[]> {
    return this.listRecords({ zone_id: zoneId, comment: { exact: MANAGED_COMMENT } });
  }

  async deleteDnsRecord(zoneId: string, id: string): Promise<void> {
    await this.client.dns.records.delete(id, { zone_id: zoneId });
  }

  private async listRecords(params: Parameters<typeof this.client.dns.records.list>[0]): Promise<ZoneRecord[]> {
    const records: ZoneRecord[] = [];
    for await (const r of this.client.dns.records.list(params)) {
      const priority = "priority" in r ? r.priority : undefined;
      records.push({ id: r.id, type: r.type, name: r.name, content: String(r.content ?? ""), ...(priority !== undefined && { priority }), managed: r.comment === MANAGED_COMMENT });
    }
    return records;
  }

  async createDnsRecord(zoneId: string, record: DnsRecord): Promise<void> {
    await this.client.dns.records.create({
      zone_id: zoneId,
      type: record.type,
      name: record.name,
      content: record.content,
      ttl: 1,
      comment: MANAGED_COMMENT,
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
