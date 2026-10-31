import { and, eq, sql as drizzleSql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { apikey, user } from "../schema.js";
import { hashToken, LEVELS, type Level } from "./access.js";
import { AUTH_PATH } from "./auth.js";
import type { RateLimiter } from "./guard.js";
import type { Session } from "./types.js";

// Personal API tokens: who a token proves, the rate limit it spends, and the token routes the
// tokens screen may call.

type Db = NodePgDatabase<Record<string, unknown>>;

export const READ_METHODS = ["GET", "HEAD", "OPTIONS"];

export const tooMany = () => Response.json({ error: "too many requests; slow down" }, { status: 429, headers: { "retry-after": "60" } });

export const callerAddress = (request: Request) => `address ${request.headers.get("cf-connecting-ip") ?? "unknown"}`;

// The API token a request carries, when tokens are on: on /api/ outside /api/auth/, where a
// token can never make more tokens or change the account, and on page reads.
function apiToken(request: Request, url: URL, tokens: boolean, onPage: boolean): string | null {
  if (!tokens) return null;
  const onApi = url.pathname.startsWith("/api/") && !url.pathname.startsWith(`${AUTH_PATH}/`);
  if (!onApi && !onPage) return null;
  return /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? null;
}

// The owner and cap an API token proves, a refusal, or null for a request that carries no token.
// `tokens` says tokens are on; `onPage` that the request reads a server page. A token's own
// allowance is spent before it is looked up, so a refused token costs no query.
export async function tokenCaller(request: Request, db: () => Db, limiter: RateLimiter | undefined, { tokens, onPage }: { tokens: boolean; onPage: boolean }): Promise<{ session: Session; cap: Level } | Response | null> {
  const token = apiToken(request, new URL(request.url), tokens, onPage);
  if (token === null) return null;
  const address = callerAddress(request);
  if (limiter && (badTokenSenders.blocked(address) || !(await limiter.limit({ key: `token ${(await hashToken(token)).slice(0, 32)}` })).success)) return tooMany();
  const holder = await tokenHolder(db(), token);
  if (!holder) {
    // Fresh fake tokens would each get an allowance of their own, so a bad one spends its sender's.
    if (limiter && !(await limiter.limit({ key: address })).success) badTokenSenders.block(address);
    return Response.json({ error: "that API token is not valid; it may have expired or been revoked" }, { status: 401 });
  }
  if (holder.cap === "read" && !READ_METHODS.includes(request.method)) return Response.json({ error: "this API token can only read" }, { status: 403 });
  return holder;
}

// Addresses whose bad tokens spent their allowance, refused for a minute before any lookup; kept
// per Worker instance, so the rate limit itself stays the authority.
const badTokenSenders = (() => {
  const until = new Map<string, number>();
  return {
    blocked: (address: string) => (until.get(address) ?? 0) > Date.now(),
    block(address: string) {
      if (until.size >= 10_000) until.clear();
      until.set(address, Date.now() + 60_000);
    },
  };
})();

// How often a token's last use is written, at most; the tokens screen shows it to this accuracy.
const TOKEN_USE_EVERY_MS = 60 * 60 * 1000;

// The token's owner and cap, or null for a token that is unknown, disabled, expired, revoked,
// capped at no known level, or whose owner is gone or banned. One query reads the key and its
// owner together, where Better Auth's own check would read and write the key's row on every call;
// the last use is written at most hourly.
async function tokenHolder(db: Db, token: string): Promise<{ session: Session; cap: Level } | null> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  const hashed = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const [row] = await db
    .select({ id: apikey.id, metadata: apikey.metadata, lastRequest: apikey.lastRequest, owner: user })
    .from(apikey)
    .innerJoin(user, eq(user.id, apikey.referenceId))
    .where(
      and(
        eq(apikey.key, hashed),
        drizzleSql`${apikey.enabled} is not false`,
        drizzleSql`(${apikey.expiresAt} is null or ${apikey.expiresAt} > now())`,
        drizzleSql`(${apikey.remaining} is null or ${apikey.remaining} > 0)`,
        drizzleSql`(${user.banned} is not true or (${user.banExpires} is not null and ${user.banExpires} <= now()))`,
      ),
    );
  if (!row) return null;
  const cap = (JSON.parse(row.metadata ?? "null") as { cap?: unknown } | null)?.cap;
  if (!LEVELS.includes(cap as Level)) return null;
  if (!row.lastRequest || Date.now() - row.lastRequest.getTime() > TOKEN_USE_EVERY_MS) await db.update(apikey).set({ lastRequest: new Date() }).where(eq(apikey.id, row.id));
  const now = new Date();
  const session = { id: `api-token ${row.id}`, userId: row.owner.id, token: "", expiresAt: new Date(now.getTime() + 60_000), createdAt: now, updatedAt: now };
  return { session: { user: row.owner, session } as unknown as Session, cap: cap as Level };
}

const TOKEN_ROUTES = ["create", "list", "delete", "get"];
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The request to hand Better Auth for a token route, a refusal, or undefined for any other path.
// Only the calls the tokens screen needs; updating could remove a token's expiry.
export async function guardTokenRoutes(request: Request, path: string, tokens: boolean): Promise<Request | Response | undefined> {
  if (!path.startsWith(`${AUTH_PATH}/api-key/`)) return undefined;
  const notFound = () => Response.json({ error: "not found" }, { status: 404 });
  if (!tokens || !TOKEN_ROUTES.includes(path.slice(`${AUTH_PATH}/api-key/`.length))) return notFound();
  if (path === `${AUTH_PATH}/api-key/create`) return tokenCreateRequest(request);
  // A token id that is not a UUID names nothing; Better Auth would fail on it instead.
  const keyId = path.endsWith("/delete") ? ((await request.clone().json().catch(() => ({}))) as { keyId?: unknown }).keyId : path.endsWith("/get") ? new URL(request.url).searchParams.get("id") : undefined;
  if (keyId !== undefined && (typeof keyId !== "string" || !UUID_TEXT.test(keyId))) return notFound();
  return request;
}

// What a person may send when making a token: a name, a lifetime and a cap, and nothing else,
// so no token is made without an expiry or with Better Auth's server-only settings.
async function tokenCreateRequest(request: Request): Promise<Request | Response> {
  const body = (await request.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "send a JSON object" }, { status: 400 });
  const cap = (body.metadata as { cap?: unknown } | undefined)?.cap ?? "manage";
  if (!LEVELS.includes(cap as Level)) return Response.json({ error: `a token's cap is one of ${LEVELS.join(", ")}` }, { status: 400 });
  if (body.expiresIn !== undefined && body.expiresIn !== null && typeof body.expiresIn !== "number") return Response.json({ error: "expiresIn is a number of seconds" }, { status: 400 });
  const clean = { name: body.name, ...(typeof body.expiresIn === "number" && { expiresIn: body.expiresIn }), metadata: { cap } };
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify(clean) });
}
