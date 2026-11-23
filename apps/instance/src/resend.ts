// The Resend calls deploying an app makes: a sending domain at the app's address, and a key that
// can only send from it, kept as the app Worker's secret.

import { SetupError } from "./cloudflare.ts";

export interface MailRecord {
  record: string;
  name: string;
  type: string;
  value: string;
  priority?: number;
}

export interface MailDomain {
  id: string;
  name: string;
  status: string;
  records?: MailRecord[];
}

export class Resend {
  constructor(
    private readonly key: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call<T>(what: string, method: string, path: string, body?: unknown): Promise<T> {
    const fetcher = this.fetcher;
    const response = await fetcher(`https://api.resend.com${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = (await response.json().catch(() => undefined)) as (T & { message?: string }) | undefined;
    if (response.status === 401) throw new SetupError("Resend no longer accepts the instance's key; replace it in Settings, Email.");
    if (!response.ok) throw new SetupError(`Resend refused to ${what} (${response.status}${result?.message ? `: ${result.message}` : ""}).`);
    return result as T;
  }

  async findDomain(name: string): Promise<MailDomain | undefined> {
    const { data } = await this.call<{ data: MailDomain[] }>("list sending domains", "GET", "/domains");
    const found = data.find((d) => d.name === name);
    return found && this.call<MailDomain>(`read the sending domain ${name}`, "GET", `/domains/${found.id}`);
  }

  createDomain(name: string) {
    return this.call<MailDomain>(`add the sending domain ${name}`, "POST", "/domains", { name });
  }

  verify(id: string) {
    return this.call<unknown>("ask for the sending domain's verification", "POST", `/domains/${id}/verify`);
  }

  deleteDomain(id: string) {
    return this.call<unknown>("delete the sending domain", "DELETE", `/domains/${id}`);
  }

  async findKey(name: string): Promise<string | undefined> {
    const { data } = await this.call<{ data: { id: string; name: string }[] }>("list API keys", "GET", "/api-keys");
    return data.find((k) => k.name === name)?.id;
  }

  async sendingKey(name: string, domain: string): Promise<string> {
    return (await this.call<{ token: string }>("make a sending key", "POST", "/api-keys", { name, permission: "sending_access", domain_id: domain })).token;
  }

  deleteKey(id: string) {
    return this.call<unknown>("delete a sending key", "DELETE", `/api-keys/${id}`);
  }
}
