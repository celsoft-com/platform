import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { Auth } from "./auth.js";

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
