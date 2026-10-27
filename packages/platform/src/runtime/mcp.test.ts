import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EndpointError } from "./endpoint-error.js";
import { endpoint } from "./endpoints.js";
import { serveMcp } from "./mcp-server.js";

const endpoints = {
  addNote: endpoint(
    { serve: ["api", "mcp"], method: "POST", path: "/api/notes", description: "Add a note", input: z.object({ body: z.string().min(1) }), output: z.object({ id: z.number(), body: z.string() }) },
    ({ body }) => {
      if (body === "nope") throw new EndpointError(403, "not your note");
      return { id: 1, body };
    },
  ),
  apiOnly: endpoint({ method: "GET", path: "/api/x", input: z.object({}), output: z.object({}) }, () => ({})),
  broken: endpoint({ serve: ["mcp"], input: z.object({}), output: z.object({ id: z.number() }) }, () => ({ id: "x" }) as never),
};

let id = 0;
async function rpc(method: string, params: object = {}) {
  const request = new Request("https://app.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
  const response = await serveMcp(request, {} as never, "demo", endpoints as never);
  return (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
}

describe("MCP", () => {
  it("lists only endpoints served over MCP, with their input schemas", async () => {
    const { result } = await rpc("tools/list");
    const tools = result!.tools as { name: string; description: string; inputSchema: { properties: object } }[];
    expect(tools.map((t) => t.name).sort()).toEqual(["addNote", "broken"]);
    expect(tools.find((t) => t.name === "addNote")).toMatchObject({ description: "Add a note", inputSchema: { properties: { body: { type: "string" } } } });
  });

  it("calls an endpoint with the tool's arguments and returns its output", async () => {
    const { result } = await rpc("tools/call", { name: "addNote", arguments: { body: "hi" } });
    expect(result).toMatchObject({ content: [{ type: "text", text: JSON.stringify({ id: 1, body: "hi" }) }] });
    expect(result!.isError).toBeFalsy();
  });

  it("reports bad input, a thrown EndpointError and a bad output as tool errors", async () => {
    expect((await rpc("tools/call", { name: "addNote", arguments: { body: "" } })).result).toMatchObject({ isError: true });
    expect((await rpc("tools/call", { name: "addNote", arguments: { body: "nope" } })).result).toMatchObject({ isError: true, content: [{ text: "not your note" }] });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await rpc("tools/call", { name: "broken", arguments: {} })).result).toMatchObject({ isError: true });
    log.mockRestore();
  });
});
