import { describe, expect, it } from "vitest";
import { createFiles, memoryBucket } from "./files.js";

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

    expect((await bucket.list({ prefix: "", delimiter: "" })).objects.map((o) => o.key)).toEqual(["pr-7/a/b.txt"]);
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

  it("keeps metadata with a file and returns it", async () => {
    const files = createFiles({ FILES: memoryBucket() });
    await files.put("assets/7f3a.png", new Uint8Array([1, 2, 3]).buffer, { contentType: "image/png", metadata: { name: "Logo.PNG" } });
    const stored = await files.get("assets/7f3a.png");
    expect(stored).toMatchObject({ size: 3, httpMetadata: { contentType: "image/png" }, metadata: { name: "Logo.PNG" } });
    await files.put("plain.txt", "x");
    expect((await files.get("plain.txt"))!.metadata).toEqual({});
  });

  it("lists a folder a page at a time, folders and files in key order", async () => {
    const files = createFiles({ FILES: memoryBucket(), FILES_PREFIX: "pr-7/" });
    for (const name of ["a", "b", "c", "d", "e"]) await files.put(`items/${name}.json`, "{}");
    await files.put("items/sub/x.json", "{}");
    const first = await files.list("items", { limit: 4 });
    expect(first.files.map((f) => f.path)).toEqual(["items/a.json", "items/b.json", "items/c.json", "items/d.json"]);
    expect(first.cursor).toBeTypeOf("string");
    const second = await files.list("items", { limit: 4, cursor: first.cursor });
    expect(second).toMatchObject({ files: [{ path: "items/e.json" }], folders: ["items/sub/"] });
    expect(second.cursor).toBeUndefined();
    await expect(files.list("items", { limit: 1001 })).rejects.toThrow(/1 to 1000/);
  });
});
