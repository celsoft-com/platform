import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCall } from "./client.js";
import { EndpointError } from "./endpoint-error.js";
import { defineApp, endpoint } from "./index.js";
import { filesFromMcp, mcpInput, upload } from "./upload.js";

const ctx = { waitUntil: () => {} };
const input = z.object({ path: z.string(), count: z.number(), file: upload({ maxBytes: 10, types: ["image/*"] }), extra: upload().optional() });

const app = defineApp(undefined, {
  endpoints: {
    put: endpoint({ method: "POST", path: "/api/public/put", input, output: z.object({ path: z.string(), count: z.number(), name: z.string(), type: z.string(), text: z.string(), extra: z.boolean() }), access: "anon" }, async ({ path, count, file, extra }) => ({
      path,
      count,
      name: file.name,
      type: file.type,
      text: await file.text(),
      extra: extra !== undefined,
    })),
  },
});

// A browser on the app's own page, through the runtime's real API handling.
const env = {};
const call = createCall<typeof app>({ put: ["POST", "/api/public/put"] }, { url: "https://app.test", link: () => null, headers: { origin: "https://app.test" }, fetch: (request) => app.fetch(request, env as never, ctx) });
const image = (text: string, type = "image/png") => new File([text], "a.png", { type });

describe("Uploads", () => {
  it("U1: a File passed to call goes as multipart, and the handler gets a File with the other fields typed", async () => {
    expect(await call("put", { path: "/x", count: 2, file: image("hello") })).toEqual({ path: "/x", count: 2, name: "a.png", type: "image/png", text: "hello", extra: false });
  });

  it("U2: a file over maxBytes or of another type is a 400 before the handler runs", async () => {
    const big = await call("put", { path: "/x", count: 1, file: image("01234567890") }).catch((e: unknown) => e);
    expect((big as EndpointError).status).toBe(400);
    expect((big as EndpointError).message).toMatch(/at most 10/);
    const text = await call("put", { path: "/x", count: 1, file: image("hi", "text/plain") }).catch((e: unknown) => e);
    expect((text as EndpointError).message).toMatch(/not one of image\/\*/);
  });

  it("U3: a body larger than the endpoint's files allow is a 413 before it is read", async () => {
    const response = await app.fetch(new Request("https://app.test/api/public/put", { method: "POST", headers: { origin: "https://app.test", "content-length": String(100 * 1024 * 1024) }, body: "x" }), env as never, ctx);
    expect(response.status).toBe(413);
  });

  it("U4: maxBytes is 1 byte to 100 MB, 10 MB by default", () => {
    expect(() => upload({ maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => upload({ maxBytes: 100 * 1024 * 1024 + 1 })).toThrow(/100 MB/);
    expect(upload().safeParse(new File([new Uint8Array(10 * 1024 * 1024 + 1)], "f")).success).toBe(false);
  });

  it("U5: over MCP a file is { name, type, base64 }, checked the same and capped at 5 MB", () => {
    const sent = (mcpInput(input) as z.ZodObject).parse({ path: "/x", count: 1, file: { name: "a.png", type: "image/png", base64: btoa("hello") } });
    const args = filesFromMcp(input, sent as Record<string, unknown>);
    expect(args.file).toBeInstanceOf(File);
    expect((args.file as File).name).toBe("a.png");
    expect(() => filesFromMcp(input, { file: { name: "a", type: "image/png", base64: btoa("01234567890") } })).toThrow(/at most 10/);
    expect(() => filesFromMcp(input, { file: { name: "a", type: "text/plain", base64: btoa("x") } })).toThrow(/not one of/);
    expect((mcpInput(z.object({ f: upload({ maxBytes: 50 * 1024 * 1024 }) })) as z.ZodObject).safeParse({ f: { name: "a", base64: "A".repeat(8 * 1024 * 1024) } }).success).toBe(false);
  });
});
