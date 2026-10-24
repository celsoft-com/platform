import type { Mail, MailDomain } from "../ports.js";

interface ResendDomain {
  id: string;
  name: string;
  status: string;
  records?: { type: string; name: string; value: string; priority?: number }[];
}

export class ResendApi implements Mail {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async findDomain(name: string): Promise<MailDomain | undefined> {
    const { data } = await this.call<{ data: ResendDomain[] }>("GET", "/domains");
    const found = data.find((d) => d.name === name);
    return found && this.toDomain(await this.call<ResendDomain>("GET", `/domains/${found.id}`));
  }

  async createDomain(name: string): Promise<MailDomain> {
    return this.toDomain(await this.call<ResendDomain>("POST", "/domains", { name }));
  }

  async verifyDomain(id: string): Promise<void> {
    await this.call("POST", `/domains/${id}/verify`);
  }

  async deleteDomain(id: string): Promise<void> {
    await this.call("DELETE", `/domains/${id}`);
  }

  async findApiKey(name: string): Promise<string | undefined> {
    const { data } = await this.call<{ data: { id: string; name: string }[] }>("GET", "/api-keys");
    return data.find((k) => k.name === name)?.id;
  }

  async createSendKey(name: string, domainId: string): Promise<string> {
    const { token } = await this.call<{ token: string }>("POST", "/api-keys", { name, permission: "sending_access", domain_id: domainId });
    return token;
  }

  async deleteApiKey(id: string): Promise<void> {
    await this.call("DELETE", `/api-keys/${id}`);
  }

  private toDomain(d: ResendDomain): MailDomain {
    return {
      id: d.id,
      name: d.name,
      verified: d.status === "verified",
      records: (d.records ?? []).map((r) => ({ type: r.type, name: r.name, content: r.value, ...(r.priority !== undefined && { priority: r.priority }) })),
    };
  }

  private async call<T = unknown>(method: string, path: string, body?: object): Promise<T> {
    const response = await this.fetcher(`https://api.resend.com${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Resend ${method} ${path} failed: ${response.status} ${await response.text()}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }
}
