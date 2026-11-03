import { createHash, createHmac } from "node:crypto";

// R2's S3 API, for what its REST API cannot do: writing only if absent (the REST API ignores
// If-None-Match), copying objects with their metadata, and listing and deleting in bulk, which the
// REST API does one object per request against an account-wide limit of 1,200 every five minutes. Its keys come from the API token
// itself: the token's id is the access key, and the SHA-256 of its value is the secret.
export class R2S3 {
  private keys: Promise<{ accessKey: string; secretKey: string }> | undefined;

  constructor(
    private readonly apiToken: string,
    private readonly accountId: () => Promise<string>,
  ) {}

  // False when ifAbsent is set and the key already exists.
  async put(bucket: string, key: string, body: string, { ifAbsent = false } = {}): Promise<boolean> {
    const response = await this.request("PUT", bucket, key, { body, headers: { "content-type": "application/json", ...(ifAbsent && { "if-none-match": "*" }) } });
    if (response.status === 412) return false;
    await expectOk(response, `write ${bucket}/${key}`);
    return true;
  }

  async get(bucket: string, key: string): Promise<string | undefined> {
    const response = await this.request("GET", bucket, key);
    if (response.status === 404) return undefined;
    await expectOk(response, `read ${bucket}/${key}`);
    return response.text();
  }

  async delete(bucket: string, key: string): Promise<void> {
    const response = await this.request("DELETE", bucket, key);
    if (response.status !== 404) await expectOk(response, `delete ${bucket}/${key}`);
  }

  async copy(from: string, key: string, to: string): Promise<void> {
    const source = `/${from}/${key.split("/").map(encodeURIComponent).join("/")}`;
    await expectOk(await this.request("PUT", to, key, { headers: { "x-amz-copy-source": source } }), `copy ${key} from ${from} to ${to}`);
  }

  // At most 1,000 keys per request, as S3's DeleteObjects allows.
  async deleteMany(bucket: string, keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_BATCH) {
      const batch = keys.slice(i, i + DELETE_BATCH);
      const body = `<Delete><Quiet>true</Quiet>${batch.map((k) => `<Object><Key>${escapeXml(k)}</Key></Object>`).join("")}</Delete>`;
      const response = await this.request("POST", bucket, "", { body, query: { delete: "" }, headers: { "content-type": "application/xml", "content-md5": md5(body) } });
      await expectOk(response, `delete ${batch.length} objects from ${bucket}`);
      const failed = [...(await response.text()).matchAll(/<Error>[\s\S]*?<Key>([^<]*)<\/Key>[\s\S]*?<\/Error>/g)].map((m) => unescapeXml(m[1]!));
      if (failed.length > 0) throw new Error(`R2 could not delete ${failed.length} objects from ${bucket}, such as ${failed[0]}`);
    }
  }

  async list(bucket: string, prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix, ...(token && { "continuation-token": token }) };
      const response = await this.request("GET", bucket, "", { query });
      await expectOk(response, `list ${bucket}`);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(match[1]!));
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? "") : undefined;
    } while (token);
    return keys;
  }

  private async request(method: string, bucket: string, key: string, options: { body?: string; headers?: Record<string, string>; query?: Record<string, string> } = {}): Promise<Response> {
    const { accessKey, secretKey } = await (this.keys ??= this.credentials());
    const host = `${await this.accountId()}.r2.cloudflarestorage.com`;
    const path = `/${bucket}${key ? `/${key.split("/").map(encodeRfc3986).join("/")}` : ""}`;
    const query = Object.entries(options.query ?? {})
      .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
      .sort()
      .join("&");

    const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, "");
    const day = now.slice(0, 8);
    const payload = sha256(options.body ?? "");
    const headers: Record<string, string> = { host, "x-amz-content-sha256": payload, "x-amz-date": now, ...options.headers };
    const names = Object.keys(headers).sort();
    const canonical = [method, path, query, names.map((n) => `${n}:${headers[n]!.trim()}\n`).join(""), names.join(";"), payload].join("\n");
    const scope = `${day}/auto/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", now, scope, sha256(canonical)].join("\n");
    let signingKey: Buffer = Buffer.from(`AWS4${secretKey}`);
    for (const part of [day, "auto", "s3", "aws4_request"]) signingKey = hmac(signingKey, part);
    const signature = hmac(signingKey, toSign).toString("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
    delete headers.host;

    return fetch(`https://${host}${path}${query ? `?${query}` : ""}`, { method, headers, ...(options.body !== undefined && { body: options.body }) });
  }

  private async credentials(): Promise<{ accessKey: string; secretKey: string }> {
    const response = await fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers: { authorization: `Bearer ${this.apiToken}` } });
    const { result } = (await response.json()) as { result?: { id?: string } };
    if (!result?.id) throw new Error("could not read the Cloudflare token's id, which R2's S3 API uses as its access key");
    return { accessKey: result.id, secretKey: sha256(this.apiToken) };
  }
}

async function expectOk(response: Response, what: string): Promise<void> {
  if (!response.ok) throw new Error(`R2 could not ${what}: ${response.status} ${(await response.text()).slice(0, 200)}`);
}

const DELETE_BATCH = 1000;

function md5(value: string): string {
  return createHash("md5").update(value).digest("base64");
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function unescapeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
