import { describe, expect, it } from "vitest";
import { createFiles, type FilesBucket, type StoredObject } from "./files.js";

function memoryBucket(): FilesBucket & { keys(): string[] } {
  const store = new Map<string, { text: string; contentType?: string }>();
  return {
    keys: () => [...store.keys()].sort(),
    async put(key, value, options) {
      store.set(key, { text: String(value), ...(options?.httpMetadata?.contentType && { contentType: options.httpMetadata.contentType }) });
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return { body: new Response(item.text).body!, size: item.text.length, httpMetadata: { contentType: item.contentType }, text: async () => item.text } as StoredObject;
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix, delimiter }) {
      const objects = [];
      const folders = new Set<string>();
      for (const key of [...store.keys()].sort()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(delimiter);
        if (cut >= 0) folders.add(prefix + rest.slice(0, cut + 1));
        else objects.push({ key, size: store.get(key)!.text.length, uploaded: new Date(0) });
      }
      return { objects, delimitedPrefixes: [...folders], truncated: false };
    },
  };
}

describe("createFiles", () => {
  it("stores JSON and lists folders like a file browser", async () => {
    const bucket = memoryBucket();
    const files = createFiles({ FILES: bucket });
    await files.putJson("users/42/settings.json", { theme: "dark" });
    await files.put("users/42/avatar.png", "png", "image/png");
    await files.put("readme.txt", "hi");

    expect(await files.getJson("users/42/settings.json")).toEqual({ theme: "dark" });
    expect(await files.list()).toMatchObject({ files: [{ path: "readme.txt" }], folders: ["users/"] });
    expect((await files.list("users/42")).files.map((f) => f.path)).toEqual(["users/42/avatar.png", "users/42/settings.json"]);
  });

  it("keeps a preview's files under its prefix without the app seeing it", async () => {
    const bucket = memoryBucket();
    const files = createFiles({ FILES: bucket, FILES_PREFIX: "pr-7/" });
    await files.put("a/b.txt", "x");

    expect(bucket.keys()).toEqual(["pr-7/a/b.txt"]);
    expect(await files.list("a")).toMatchObject({ files: [{ path: "a/b.txt" }] });
  });

  it("rejects paths that climb out of their folder", async () => {
    const files = createFiles({ FILES: memoryBucket(), FILES_PREFIX: "pr-7/" });
    await expect(files.put("../pr-8/x", "y")).rejects.toThrow(/\.\./);
  });

  it("serves a stored file as a response", async () => {
    const files = createFiles({ FILES: memoryBucket() });
    await files.put("a.txt", "hello", "text/plain");
    const response = await files.response("a.txt");
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("hello");
    expect((await files.response("missing")).status).toBe(404);
  });
});
