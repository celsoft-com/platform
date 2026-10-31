import { AUTH_PATH } from "./auth.js";

export const PUBLIC_API = "/api/public/";

const FORM_TYPES = ["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"];
const UNSAFE = ["POST", "PUT", "PATCH", "DELETE"];

// OAuth endpoints AI clients post forms to directly; they prove themselves with a code or token,
// never a cookie, so a forged browser form gains nothing.
const OAUTH_FORM_PATHS = ["/oauth2/token", "/oauth2/revoke", "/oauth2/introspect"].map((p) => `${AUTH_PATH}${p}`);

// A browser sends any site's form to any other without asking, cookies included; it always
// sends an Origin with it, so a missing or foreign one is refused.
export function isCrossSiteForm(request: Request, url: URL): boolean {
  if (!UNSAFE.includes(request.method)) return false;
  if (OAUTH_FORM_PATHS.includes(url.pathname)) return false;
  // A form cannot set Authorization, so a script uploading with an API token is never a forged one.
  if (request.headers.has("authorization")) return false;
  const type = request.headers.get("content-type")?.split(";", 1)[0]!.trim().toLowerCase() ?? "";
  if (!FORM_TYPES.includes(type)) return false;
  return request.headers.get("origin") !== url.origin;
}

// Every /api route needs a signed-in user unless its path says otherwise.
export function needsSession(pathname: string): boolean {
  if (!pathname.startsWith("/api/")) return false;
  // Live rooms ask the app's canJoin instead, which may welcome visitors who are not signed in.
  return !(pathname.startsWith(`${AUTH_PATH}/`) || pathname.startsWith(PUBLIC_API) || pathname.startsWith("/api/live/"));
}

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Guessing passwords is limited per account, signing up per address.
const LIMITED: Record<string, "email" | "ip"> = {
  [`${AUTH_PATH}/sign-in/email`]: "email",
  [`${AUTH_PATH}/request-password-reset`]: "email",
  [`${AUTH_PATH}/reset-password`]: "ip",
  [`${AUTH_PATH}/sign-up/email`]: "ip",
};

export async function rateLimited(request: Request, pathname: string, limiter: RateLimiter | undefined): Promise<boolean> {
  const by = LIMITED[pathname];
  if (!limiter || !by || request.method !== "POST") return false;
  let subject = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (by === "email") {
    const body = (await request.clone().json().catch(() => ({}))) as { email?: unknown };
    if (typeof body.email === "string") subject = body.email.trim().toLowerCase();
  }
  return !(await limiter.limit({ key: `${pathname}:${subject}` })).success;
}
