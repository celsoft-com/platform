import { AUTH_PATH } from "./auth.js";
import { INVITES_PATH } from "./invites.js";
import { LIVE_PATH } from "./live.js";
import { MCP_PATH, WELL_KNOWN } from "./mcp.js";
import { PLATFORM_API } from "./organizations.js";
import { SCREEN_PATHS, TOKENS_PATH } from "./screens.js";

// The settings that decide which paths the platform answers, read from the Worker's vars, which
// featureVars writes from platform.jsonc for deploys, `dev` and tests alike.
export interface Features {
  auth: boolean;
  apiTokens: boolean;
  live: boolean;
  mcp: boolean;
}

export const features = (vars: { AUTH_SIGNUP?: string; AUTH_API_TOKENS?: string; LIVE_ROOMS?: string; MCP?: string }): Features => ({
  auth: vars.AUTH_SIGNUP !== undefined,
  apiTokens: vars.AUTH_API_TOKENS === "on",
  live: vars.LIVE_ROOMS === "on",
  mcp: vars.MCP === "on",
});

// Every path the platform answers itself, and the setting that turns it on; a path ending in /*
// is everything below it. The one list the Worker's routing, page claims, `serves` and the skill
// read, so none of them can miss a path.
export const PLATFORM_PATHS: readonly { path: string; on: (f: Features) => boolean }[] = [
  ...SCREEN_PATHS.map((path) => ({ path, on: (f: Features) => f.auth })),
  { path: INVITES_PATH, on: (f) => f.auth },
  { path: TOKENS_PATH, on: (f) => f.apiTokens },
  { path: `${AUTH_PATH}/*`, on: (f) => f.auth },
  { path: `${PLATFORM_API}*`, on: (f) => f.auth },
  { path: `${LIVE_PATH}*`, on: (f) => f.live },
  { path: MCP_PATH, on: (f) => f.mcp },
  { path: `${WELL_KNOWN}*`, on: (f) => f.mcp },
];

// What a page may never claim: every platform path outside /api/, whatever is on, and /api itself.
export const RESERVED = ["/api", ...PLATFORM_PATHS.map(({ path }) => path.replace(/\/\*$/, "")).filter((path) => !path.startsWith("/api/"))];

// The paths that reach the Worker before static files: all of /api/ and each platform path that is on.
export const workerFirst = (f: Features) => ["/api/*", ...PLATFORM_PATHS.filter(({ path, on }) => on(f) && !path.startsWith("/api/")).map(({ path }) => path)];

export const covers = (pattern: string, pathname: string) => (pattern.endsWith("/*") ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern);

// The paths a frontend folder's files answer, as Cloudflare's default html handling serves them:
// /about for about.html or about/index.html, and / for index.html.
export function servedFiles(files: readonly string[]): string[] {
  const served = new Set<string>();
  for (const file of files) {
    const path = `/${file}`;
    served.add(path);
    if (path.endsWith("/index.html")) {
      const dir = path.slice(0, -"index.html".length);
      served.add(dir);
      if (dir !== "/") served.add(dir.slice(0, -1));
    } else if (path.endsWith(".html")) served.add(path.slice(0, -".html".length));
  }
  return [...served].sort();
}

export type Served = "platform" | "page" | "endpoint" | "file" | "fallback";

export interface Routes {
  // What answers a GET of `path`, or null for a 404; free, since it reads lists built into the
  // Worker. A query or a #fragment is ignored. A hand-written handler's paths are not known.
  serves(path: string): Served | null;
}

export function createRoutes(input: {
  features: Features;
  // "spa" when unknown paths get the frontend's index.html, "files" for real 404s, absent with no frontend.
  frontend: string | undefined;
  files: ReadonlySet<string>;
  page: (pathname: string) => boolean;
  endpoint: (pathname: string) => boolean;
}): Routes {
  return {
    serves(path) {
      const { pathname } = new URL(path, "http://app.invalid");
      if (PLATFORM_PATHS.some(({ path: pattern, on }) => on(input.features) && covers(pattern, pathname))) return "platform";
      if (input.page(pathname)) return "page";
      if (pathname.startsWith("/api/")) return input.endpoint(pathname) ? "endpoint" : null;
      if (!input.frontend) return null;
      if (input.files.has(pathname)) return "file";
      return input.frontend === "spa" ? "fallback" : null;
    },
  };
}
