import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCall, EndpointError, linkFromPage } from "./client.js";
import { defineApp, endpoint } from "./index.js";

const app = defineApp(undefined, {
  endpoints: {
    getNote: endpoint(
      { method: "GET", path: "/api/public/notes/:id", input: z.object({ id: z.number(), urgent: z.boolean().default(false) }), output: z.object({ id: z.number(), urgent: z.boolean(), at: z.date() }) },
      ({ id, urgent }) => {
        if (id === 404) throw new Error("unreachable");
        return { id, urgent, at: new Date("2026-10-25T00:00:00Z") };
      },
    ),
    addNote: endpoint(
      { method: "POST", path: "/api/public/folders/:folder/notes", input: z.object({ folder: z.string(), body: z.string().min(1) }), output: z.object({ folder: z.string(), body: z.string() }) },
      (input) => input,
    ),
  },
});

const seen: string[] = [];
const links: (string | null)[] = [];
const fetcher = async (request: Request) => {
  seen.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
  links.push(request.headers.get("x-access-link"));
  return app.fetch(new Request(request, { headers: { ...Object.fromEntries(request.headers), origin: "https://app.test" } }), {}, { waitUntil: () => {} });
};
vi.stubGlobal("fetch", fetcher);
afterEach(() => {
  seen.length = 0;
  links.length = 0;
  vi.unstubAllGlobals();
  vi.stubGlobal("fetch", fetcher);
});

const call = createCall<typeof app>({ getNote: ["GET", "/api/public/notes/{id}"], addNote: ["POST", "/api/public/folders/{folder}/notes"] }, { url: "https://app.test" });

describe("call", () => {
  it("calls an endpoint by name over its REST path", async () => {
    expect(await call("getNote", { id: 7, urgent: true })).toEqual({ id: 7, urgent: true, at: "2026-10-25T00:00:00.000Z" });
    expect(await call("addNote", { folder: "work", body: "hi" })).toEqual({ folder: "work", body: "hi" });
    expect(seen).toEqual(["GET /api/public/notes/7?urgent=true", "POST /api/public/folders/work/notes"]);
  });

  it("throws EndpointError with the server's status and message", async () => {
    await expect(call("addNote", { folder: "work", body: "" })).rejects.toMatchObject({ status: 400, name: "EndpointError" });
    await expect(call("addNote", { folder: "work", body: "" })).rejects.toBeInstanceOf(EndpointError);
  });

  it("sends the page's #link= token with every call, and none without one", async () => {
    vi.stubGlobal("location", { origin: "https://app.test", hash: "#note=7&link=tok_en-1" });
    expect(linkFromPage()).toBe("tok_en-1");
    await createCall<typeof app>({ getNote: ["GET", "/api/public/notes/{id}"] })("getNote", { id: 1 });
    vi.stubGlobal("location", { origin: "https://app.test", hash: "" });
    await createCall<typeof app>({ getNote: ["GET", "/api/public/notes/{id}"] })("getNote", { id: 1 });
    await call("getNote", { id: 1 });
    expect(links.filter((_, i) => !seen[i]!.startsWith("POST /api/platform/link"))).toEqual(["tok_en-1", null, null]);
  });

  it("in a browser, keeps the page's link as a cookie once per token, and never sends it elsewhere", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/api/platform/link") bodies.push(`${request.url} ${await request.text()}`);
      return fetcher(request);
    });
    vi.stubGlobal("location", { origin: "https://app.test", hash: "#/notes/7&link=tok_en-1" });
    const browser = createCall<typeof app>({ getNote: ["GET", "/api/public/notes/{id}"] });
    await browser("getNote", { id: 1 });
    await browser("getNote", { id: 2 });
    vi.stubGlobal("location", { origin: "https://app.test", hash: "#/notes/8&link=other" });
    await browser("getNote", { id: 3 });
    vi.stubGlobal("location", { origin: "https://app.test", hash: "#/notes" });
    await browser("getNote", { id: 4 });
    await new Promise((r) => setTimeout(r, 10));
    expect(bodies).toEqual(['https://app.test/api/platform/link {"link":"tok_en-1"}', 'https://app.test/api/platform/link {"link":"other"}']);
  });

  it("sends the token an app's own link option returns", async () => {
    await createCall<typeof app>({ getNote: ["GET", "/api/public/notes/{id}"] }, { url: "https://app.test", link: () => "mine" })("getNote", { id: 1 });
    expect(links).toEqual(["mine"]);
  });
});
