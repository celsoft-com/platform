import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { z } from "zod";
import type { Auth } from "./auth.js";
import { EndpointError } from "./endpoint-error.js";
import type { Endpoint } from "./endpoints.js";

export const MCP_PATH = "/mcp";
export const WELL_KNOWN = "/.well-known/";

export const servesMcp = (e: { serve?: readonly string[] }) => (e.serve ?? ["api"]).includes("mcp");

// The access token's subject, verified against the app's own signing keys, read from its database
// rather than fetched over the network, since a Worker cannot fetch its own hostname.
export async function mcpUserId(request: Request, auth: Auth, resource: string): Promise<string | undefined> {
  const token = /^Bearer (.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token) return undefined;
  const { baseURL } = await auth.$context;
  try {
    const claims = await verifyJwsAccessToken(token, {
      jwksFetch: async () => (await auth.api.getJwks()) as never,
      verifyOptions: { issuer: baseURL, audience: resource, requiredClaims: ["azp", "sub"] },
    });
    return typeof claims.sub === "string" ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

// RFC 9728: tells an MCP client where to find out how to sign in.
export function mcpChallenge(origin: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "sign in first" }, id: null },
    { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}${WELL_KNOWN}oauth-protected-resource${MCP_PATH}"` } },
  );
}

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
        const output = e.output.parse(await e.handler(args as z.output<z.ZodType>, app));
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
