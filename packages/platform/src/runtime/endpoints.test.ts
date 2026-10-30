import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineApp, endpoint, EndpointError } from "./index.js";
import { apiRoutes } from "./endpoints.js";

const ctx = { waitUntil: () => {} };
const Note = z.object({ id: z.number(), folder: z.string(), body: z.string(), urgent: z.boolean() });

const app = defineApp(() => new Response("handler"), {
  endpoints: {
    getNote: endpoint(
      { method: "GET", path: "/api/public/notes/:id", input: z.object({ id: z.number(), urgent: z.boolean().default(false) }), output: Note, access: "anon" },
      ({ id, urgent }) => {
        if (id === 404) throw new EndpointError(404, "note not found");
        return { id, folder: "inbox", body: "hello", urgent };
      },
    ),
    addNote: endpoint(
      { method: "POST", path: "/api/public/folders/:folder/notes", input: z.object({ folder: z.string(), body: z.string().min(1) }), output: Note, access: "anon" },
      ({ folder, body }) => ({ id: 1, folder, body, urgent: false }),
    ),
    broken: endpoint({ method: "GET", path: "/api/public/broken", input: z.object({}), output: Note, access: "anon" }, () => ({ id: "nope" }) as never),
    signedIn: endpoint({ method: "GET", path: "/api/public/me", input: z.object({}), output: z.object({}), access: "anon" }, async (_, a) => {
      await a.requireUser();
      return {};
    }),
    toolOnly: endpoint({ serve: ["mcp"], input: z.object({}), output: z.object({}), access: "anon" }, () => ({})),
  },
});

const call = async (path: string, init?: RequestInit) => {
  const response = await app.fetch(new Request(`https://app.test${path}`, init), {}, ctx);
  return { status: response.status, body: response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text() };
};

describe("endpoints over the API", () => {
  it("builds one input from the path and query, converting strings to the schema's types", async () => {
    expect(await call("/api/public/notes/42?urgent=true")).toEqual({ status: 200, body: { id: 42, folder: "inbox", body: "hello", urgent: true } });
  });

  it("merges path parameters with the JSON body", async () => {
    const response = await call("/api/public/folders/work/notes", { method: "POST", headers: { "content-type": "application/json", origin: "https://app.test" }, body: JSON.stringify({ body: "hi" }) });
    expect(response).toEqual({ status: 200, body: { id: 1, folder: "work", body: "hi", urgent: false } });
  });

  it("refuses bad input with 400 and an error", async () => {
    const response = await call("/api/public/notes/abc");
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/validation/i);
  });

  it("turns EndpointError into its status and message", async () => {
    expect(await call("/api/public/notes/404")).toMatchObject({ status: 404, body: { error: "note not found" } });
  });

  it("keeps the status of a thrown Response, as requireUser throws", async () => {
    expect(await call("/api/public/me")).toMatchObject({ status: 401, body: { error: "sign in first" } });
  });

  it("answers 500 when the output does not match its schema, and logs it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("/api/public/broken")).status).toBe(500);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("leaves every other request to the handler, including MCP-only endpoints", async () => {
    expect(await call("/api/public/other")).toEqual({ status: 200, body: "handler" });
  });
});

describe("endpoint routes", () => {
  const input = z.object({ id: z.number() });
  const output = z.object({});

  it("lists API endpoints with oRPC-style paths and skips MCP-only ones", () => {
    expect(apiRoutes(app.endpoints)).toMatchObject({ getNote: { method: "GET", path: "/api/public/notes/{id}" } });
    expect(apiRoutes(app.endpoints)).not.toHaveProperty("toolOnly");
  });

  it("refuses an API endpoint without a method and path, outside /api, or with an unknown path parameter", () => {
    expect(() => apiRoutes({ a: endpoint({ input, output }, () => ({})) })).toThrow(/method and a path/);
    expect(() => apiRoutes({ a: endpoint({ method: "GET", path: "/notes/:id", input, output }, () => ({})) })).toThrow(/start with \/api\//);
    expect(() => apiRoutes({ a: endpoint({ method: "GET", path: "/api/notes/:nope", input, output }, () => ({})) })).toThrow(/:nope/);
  });
});
