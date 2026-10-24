import CloudflareClient from "cloudflare";
import type { Cloudflare, Hyperdrive, Zone } from "../ports.js";
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
        return { id: config.id, name, origin: `${origin.user}@${origin.host}/${origin.database}` };
      }
    }
    return undefined;
  }

  async createHyperdrive(name: string, connectionUri: string): Promise<Hyperdrive> {
    const account_id = await this.accountId();
    const created = await this.client.hyperdrive.configs.create({ account_id, name, origin: originParams(connectionUri) });
    return { id: created.id, name, origin: originOf(connectionUri) };
  }

  async updateHyperdrive(id: string, connectionUri: string): Promise<Hyperdrive> {
    const account_id = await this.accountId();
    const updated = await this.client.hyperdrive.configs.edit(id, { account_id, origin: originParams(connectionUri) });
    return { id, name: updated.name, origin: originOf(connectionUri) };
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
