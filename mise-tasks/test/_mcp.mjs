// Connects to a preview's MCP server the way an AI client does: discovery, client registration,
// sign-in and consent through the platform's own screens' APIs, a PKCE token, then tool calls.
// Usage: node _mcp.mjs <preview url> <email> <password>
import { createHash, randomBytes } from "node:crypto";

const [base, email, password] = process.argv.slice(2);
const check = (label, value) => console.log(`${label.padEnd(44)} ${value}`);
const json = (r) => r.json().catch(() => ({}));
const cookies = new Map();
const keep = (r) => {
  for (const c of r.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const [name, value] = pair.split("=");
    cookies.set(name, value);
  }
  return r;
};
const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
const post = (url, body) => fetch(url, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", origin: base, cookie: cookie() }, body: JSON.stringify(body) }).then(keep);

check("MCP without a token refused (401)", await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => `${r.status} ${r.headers.get("www-authenticate")?.includes("resource_metadata") ? "challenge" : "no challenge"}`));

const resource = await json(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`));
const issuer = resource.authorization_servers?.[0];
check("protected resource metadata", issuer ? "issuer found" : JSON.stringify(resource).slice(0, 120));
const issuerPath = new URL(issuer).pathname.replace(/\/$/, "");
const server = await json(await fetch(`${base}/.well-known/oauth-authorization-server${issuerPath}`));
check("authorization server metadata", server.registration_endpoint ? "has registration" : JSON.stringify(server).slice(0, 120));

const redirectUri = "http://127.0.0.1:9/callback";
const client = await json(await post(server.registration_endpoint, { client_name: "Smoke Test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }));
check("client registered", client.client_id ? "yes" : JSON.stringify(client).slice(0, 120));

const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authorize = new URL(server.authorization_endpoint);
for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, scope: "openid profile email offline_access", code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: `${base}/mcp` })) authorize.searchParams.set(k, v);
// A browser navigation, as when an AI client opens the authorize URL for the person.
const toLogin = await fetch(authorize, { redirect: "manual", headers: { "sec-fetch-mode": "navigate", accept: "text/html" } });
const login = new URL(toLogin.headers.get("location") ?? (await json(toLogin)).url ?? "", base);
check("authorize sends a signed-out user to /login", login.pathname === "/login" && login.searchParams.has("sig") ? "yes" : `${toLogin.status} ${login}`);

// What the /login screen sends: the signed parameters only.
const signedQuery = (params) => {
  const signed = new Set(params.getAll("ba_param"));
  return new URLSearchParams([...params].filter(([k]) => k === "sig" || k === "ba_param" || signed.has(k))).toString();
};
const signedIn = await json(await post(`${base}/api/auth/sign-in/email`, { email, password, oauth_query: signedQuery(login.searchParams) }));
const consentPage = new URL(signedIn.url ?? "", base);
check("sign-in continues to /consent", consentPage.pathname === "/consent" ? "yes" : JSON.stringify(signedIn).slice(0, 160));
check("consent screen served", await fetch(consentPage, { headers: { cookie: cookie() } }).then(async (r) => `${r.status} ${(await r.text()).includes("Allow access") ? "Allow access" : "missing"}`));

const consented = await json(await post(`${base}/api/auth/oauth2/consent`, { accept: true, oauth_query: signedQuery(consentPage.searchParams) }));
const callback = new URL(consented.url ?? "http://none/");
const code = callback.searchParams.get("code");
check("consent returns a code", code ? "yes" : JSON.stringify(consented).slice(0, 160));

const tokenResponse = await json(
  await fetch(server.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: verifier, resource: `${base}/mcp` }),
  }),
);
check("token issued", tokenResponse.access_token ? "yes" : JSON.stringify(tokenResponse).slice(0, 160));

let rpcId = 0;
const rpc = async (method, params = {}) => {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tokenResponse.access_token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  return json(r);
};
const tools = (await rpc("tools/list")).result?.tools?.map((t) => t.name).sort() ?? [];
check("tools listed", tools.join(", ") || "none");
const teams = await rpc("tools/call", { name: "listMyTeams", arguments: {} });
const team = JSON.parse(teams.result?.content?.[0]?.text ?? "[]")[0];
check("listMyTeams as the signed-in user", team?.id ? `team ${team.name}` : JSON.stringify(teams).slice(0, 160));
const added = await rpc("tools/call", { name: "addTeamNote", arguments: { team: team?.id, body: "from an AI client" } });
check("addTeamNote through MCP", JSON.parse(added.result?.content?.[0]?.text ?? "{}").body ?? JSON.stringify(added).slice(0, 160));
const bad = await rpc("tools/call", { name: "addTeamNote", arguments: { team: team?.id, body: "" } });
check("bad input is a tool error", bad.result?.isError ? "isError" : JSON.stringify(bad).slice(0, 160));
