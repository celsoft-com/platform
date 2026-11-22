// Checks the Cf-Access-Jwt-Assertion header Cloudflare Access adds to every request it lets
// through, so the Worker trusts a signed-in email only when Cloudflare signed it for this app.

export interface AccessApp {
  authDomain: string;
  aud: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

const decoder = new TextDecoder();

function base64url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function json(part: string): Record<string, unknown> {
  return JSON.parse(decoder.decode(base64url(part))) as Record<string, unknown>;
}

// Returns the signed-in email, or undefined when the header is missing, forged, expired or for another app.
export async function accessEmail(header: string | null, app: AccessApp, fetcher: typeof fetch = fetch, now = Date.now()): Promise<string | undefined> {
  const parts = header?.split(".");
  if (parts?.length !== 3) return undefined;
  const [head, body, signature] = parts as [string, string, string];
  try {
    const { alg, kid } = json(head);
    if (alg !== "RS256" || typeof kid !== "string") return undefined;
    const response = await fetcher(`https://${app.authDomain}/cdn-cgi/access/certs`);
    const { keys } = (await response.json()) as { keys: Jwk[] };
    const jwk = keys.find((k) => k.kid === kid);
    if (!jwk) return undefined;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(signature), new TextEncoder().encode(`${head}.${body}`));
    if (!signed) return undefined;
    const claims = json(body);
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    const seconds = now / 1000;
    if (claims.iss !== `https://${app.authDomain}` || !audiences.includes(app.aud)) return undefined;
    if (typeof claims.exp !== "number" || claims.exp <= seconds) return undefined;
    if (typeof claims.nbf === "number" && claims.nbf > seconds) return undefined;
    return typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
