import { BUCKET_MARKER } from "../ownership.js";

// The subset of Cloudflare's R2Bucket binding the helper uses, so the runtime needs no Workers types.
export interface FilesBucket {
  put(key: string, value: ReadableStream | ArrayBuffer | string | Blob, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; delimiter: string; cursor?: string }): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; delimitedPrefixes: string[]; truncated: boolean; cursor?: string }>;
}

export interface StoredObject {
  body: ReadableStream;
  size: number;
  httpMetadata?: { contentType?: string };
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

export interface Folder {
  files: FileEntry[];
  folders: string[];
}

export interface Files {
  put(path: string, body: ReadableStream | ArrayBuffer | string | Blob, contentType?: string): Promise<void>;
  get(path: string): Promise<StoredObject | null>;
  getJson<T = unknown>(path: string): Promise<T | null>;
  putJson(path: string, value: unknown): Promise<void>;
  list(folder?: string): Promise<Folder>;
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
    async put(path, body, contentType) {
      await bucket().put(key(path), body, contentType ? { httpMetadata: { contentType } } : undefined);
    },
    get: (path) => bucket().get(key(path)),
    async getJson<T>(path: string) {
      const object = await files.get(path);
      return object ? (JSON.parse(await object.text()) as T) : null;
    },
    putJson: (path, value) => files.put(path, JSON.stringify(value), "application/json"),
    async list(folder = "") {
      const inner = clean(folder);
      const base = prefix + (inner ? `${inner}/` : "");
      const result: Folder = { files: [], folders: [] };
      let cursor: string | undefined;
      do {
        const page = await bucket().list({ prefix: base, delimiter: "/", ...(cursor && { cursor }) });
        // The platform's ownership marker sits at the bucket root and is never the app's file.
        const objects = page.objects.filter((o) => o.key !== BUCKET_MARKER);
        result.files.push(...objects.map((o) => ({ path: o.key.slice(prefix.length), size: o.size, uploaded: o.uploaded })));
        result.folders.push(...page.delimitedPrefixes.map((p) => p.slice(prefix.length)));
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor);
      return result;
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
