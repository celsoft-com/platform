import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { z } from "zod";
import { EndpointError } from "./endpoint-error.js";
import { runEndpoint, type Endpoint } from "./endpoints.js";
import { servesMcp } from "./mcp.js";

// Loaded only when /mcp is called, so the MCP SDK never costs a Worker's startup otherwise.

// A stateless MCP server: each request lists or calls the app's MCP endpoints as tools, with the
// same checks the API applies, and a failure reported as a tool error, as MCP asks.
export async function serveMcp<App>(request: Request, app: App, name: string, endpoints: Record<string, Endpoint<z.ZodType, z.ZodType, App>>): Promise<Response> {
  const server = new McpServer({ name, version: "1.0.0" });
  for (const [tool, e] of Object.entries(endpoints)) {
    if (!servesMcp(e)) continue;
    // The SDK's types expect its own Zod shape; the app's Zod 4 object schema is what it validates against.
    const register = server.registerTool.bind(server) as (name: string, config: object, handler: (args: unknown) => Promise<object>) => void;
    register(tool, { description: e.description ?? tool, inputSchema: e.input }, async (args) => {
      try {
        const output = e.output.parse(await runEndpoint(e, args, app));
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text" as const, text: await toolError(tool, error) }] };
      }
    });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

async function toolError(tool: string, error: unknown): Promise<string> {
  if (error instanceof EndpointError) return error.message;
  if (error instanceof Response) return ((await error.json().catch(() => ({}))) as { error?: string }).error ?? error.statusText;
  console.error(`MCP tool ${tool} failed`, error);
  return "the tool failed; see the app's logs";
}
