import { EndpointError } from "./endpoint-error.js";
import { query, type QueryOptions, type QueryResult } from "./jsonpath.js";

// The subset of Cloudflare's R2Bucket binding the helper uses, so the runtime needs no Workers types.
export interface FilesBucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string | Blob, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; delimiter: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; delimitedPrefixes: string[]; truncated: boolean; cursor?: string }>;
}

export interface StoredObject {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  text(): Promise<string>;
}

export interface FilesBindings {
  FILES?: FilesBucket;
  FILES_PREFIX?: string;
}

export interface FileEntry {
  path: string;
  size: number;
  uploaded: Date;
}

// One page of a folder; `cursor` is set when there are more, and passed back gets the next page.
export interface Folder {
  files: FileEntry[];
  folders: string[];
  cursor?: string;
}

export interface PutOptions {
  contentType?: string;
  // Up to 2 KB of names and values, stored with the file and returned by `get`.
  metadata?: Record<string, string>;
}

export interface StoredFile extends StoredObject {
  metadata: Record<string, string>;
}

export const LIST_LIMIT = 1000;
// A query reads and parses the whole file each time, so a larger one belongs in app.db.
export const QUERY_FILE_LIMIT = 25 * 1024 * 1024;

export interface Files {
  put(path: string, body: ReadableStream | ArrayBuffer | string | Blob, options?: string | PutOptions): Promise<void>;
  get(path: string): Promise<StoredFile | null>;
  getJson<T = unknown>(path: string): Promise<T | null>;
  putJson(path: string, value: unknown): Promise<void>;
  list(folder?: string, options?: { cursor?: string; limit?: number }): Promise<Folder>;
  // A JSONPath (RFC 9535) query over one JSON file; null when the file is missing.
  query(path: string, expression: string, options?: QueryOptions): Promise<QueryResult | null>;
  delete(path: string): Promise<void>;
  response(path: string): Promise<Response>;
}

// Paths are "folder/sub/file.json"; "/" makes folders. Previews share one bucket, so each
// preview's prefix is added here and never seen by app code.
export function createFiles(env: FilesBindings): Files {
  const bucket = () => {
    if (!env.FILES) throw new Error("this app has no files; set `files: true` in platform.jsonc");
    return env.FILES;
  };
  const prefix = env.FILES_PREFIX ?? "";
  const key = (path: string) => prefix + clean(path);

  const files: Files = {
    async put(path, body, options) {
      const { contentType, metadata } = typeof options === "string" ? { contentType: options, metadata: undefined } : (options ?? {});
      await bucket().put(key(path), body, { ...(contentType && { httpMetadata: { contentType } }), ...(metadata && { customMetadata: metadata }) });
    },
    async get(path) {
      const object = await bucket().get(key(path));
      return object && Object.assign(object, { metadata: object.customMetadata ?? {} });
    },
    async getJson<T>(path: string) {
      const object = await files.get(path);
      return object ? (JSON.parse(await object.text()) as T) : null;
    },
    putJson: (path, value) => files.put(path, JSON.stringify(value), "application/json"),
    async list(folder = "", options = {}) {
      const limit = options.limit ?? LIST_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT) throw new Error(`a list's limit is 1 to ${LIST_LIMIT}`);
      const inner = clean(folder);
      const page = await bucket().list({ prefix: prefix + (inner ? `${inner}/` : ""), delimiter: "/", limit, ...(options.cursor && { cursor: options.cursor }) });
      return {
        files: page.objects.map((o) => ({ path: o.key.slice(prefix.length), size: o.size, uploaded: o.uploaded })),
        folders: page.delimitedPrefixes.map((p) => p.slice(prefix.length)),
        ...(page.truncated && page.cursor && { cursor: page.cursor }),
      };
    },
    async query(path, expression, options) {
      const object = await files.get(path);
      if (!object) return null;
      if (object.size > QUERY_FILE_LIMIT) {
        await object.body.cancel();
        throw new EndpointError(413, `${path} is ${object.size} bytes; a query reads files of at most ${QUERY_FILE_LIMIT}`);
      }
      let data: unknown;
      try {
        data = JSON.parse(await object.text());
      } catch {
        throw new EndpointError(422, `${path} is not JSON`);
      }
      return query(data, expression, options);
    },
    delete: (path) => bucket().delete(key(path)),
    async response(path) {
      const object = await files.get(path);
      if (!object) return new Response("not found", { status: 404 });
      return new Response(object.body, { headers: { "content-type": object.httpMetadata?.contentType ?? "application/octet-stream", "content-length": String(object.size) } });
    },
  };
  return files;
}

function clean(path: string): string {
  const parts = path.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`file paths cannot contain "..": ${path}`);
  return parts.join("/");
}

// A bucket kept in memory, behaving as R2 does for what the helper uses: tests and local runs.
export function memoryBucket(): FilesBucket {
  const store = new Map<string, { bytes: Uint8Array<ArrayBuffer>; uploaded: Date; contentType?: string; metadata?: Record<string, string> }>();
  return {
    async put(key, value, options) {
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      store.set(key, { bytes, uploaded: new Date(), contentType: options?.httpMetadata?.contentType, metadata: options?.customMetadata && { ...options.customMetadata } });
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: new Response(item.bytes).body!,
        size: item.bytes.length,
        httpMetadata: item.contentType ? { contentType: item.contentType } : {},
        ...(item.metadata && { customMetadata: { ...item.metadata } }),
        text: async () => new TextDecoder().decode(item.bytes),
      };
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix, delimiter, cursor, limit = LIST_LIMIT }) {
      // Entries in key order, a folder standing once where its first key falls, as R2 lists them.
      const entries: ({ key: string; folder: false } | { key: string; folder: true })[] = [];
      const seen = new Set<string>();
      for (const key of [...store.keys()].sort()) {
        if (!key.startsWith(prefix)) continue;
        const cut = delimiter ? key.slice(prefix.length).indexOf(delimiter) : -1;
        if (cut < 0) entries.push({ key, folder: false });
        else {
          const folder = key.slice(0, prefix.length + cut + 1);
          if (!seen.has(folder)) entries.push({ key: folder, folder: true });
          seen.add(folder);
        }
      }
      const start = cursor ? Number(cursor) : 0;
      const page = entries.slice(start, start + limit);
      const truncated = start + limit < entries.length;
      return {
        objects: page.filter((e) => !e.folder).map((e) => ({ key: e.key, size: store.get(e.key)!.bytes.length, uploaded: store.get(e.key)!.uploaded })),
        delimitedPrefixes: page.filter((e) => e.folder).map((e) => e.key),
        truncated,
        ...(truncated && { cursor: String(start + limit) }),
      };
    },
  };
}
