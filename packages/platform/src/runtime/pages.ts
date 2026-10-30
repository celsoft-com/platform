import type { z } from "zod";
import { EndpointError } from "./endpoint-error.js";
import { checkAccessDeclaration, requireAccess, type AnyApp, type EndpointAccess } from "./endpoints.js";
import { LINK_EXCHANGE_PATH } from "./link-header.js";

// Pages the Worker renders on each request. An app claims a path such as `/notes`; the Worker then
// answers it and every path below it, and no static file is ever served there. A page renders only
// what is identical for everyone allowed to see it: its access gate decides who gets in, and its
// handler cannot ask who is looking, so anything personal is added by the browser. See
// docs/design.md, Server pages.

type ParamNames<S extends string> = S extends `${string}:${infer P}/${infer Rest}` ? P | ParamNames<`/${Rest}`> : S extends `${string}:${infer P}` ? P : S extends `${string}*${infer P}` ? P : never;

// The `:name` segments of a route, and its `*name` rest of the path, as strings.
export type PathParams<S extends string> = { [K in ParamNames<S>]: string };

// HTML, or a whole Response such as a redirect.
export type PageResult = string | Response;
export type PageHandler<Params = any, App = AnyApp> = (params: Params, app: App, request: Request) => PageResult | Promise<PageResult>;

export interface PageRoute<Params = any, App = AnyApp> {
  // Checks and converts the route's parameters, as an endpoint's input schema does; a failure is a 404.
  params?: z.ZodType;
  // Checked before the handler and the cache, as for an endpoint: `{ point, level }` names a
  // parameter or a function of the parameters; `{ level }` lets in anyone signed in, "anon" anyone
  // at all. With access on, every route says one of them.
  access?: EndpointAccess<Params>;
  // Keeps the answer, shared by every visitor who passes the gate, for 60 seconds or `seconds`, or until app.cache empties it.
  cache?: PageCacheOption;
  handler: PageHandler<Params, App>;
}

export type PageCacheOption = true | { seconds: number };

// Where cached answers live: Cloudflare's Cache API in a Worker. `version` is the deploy's and the
// page's current versions, so a deploy, a clear or an invalidate leaves old copies unasked for.
export interface PageCache {
  version(path: string): Promise<string>;
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): void;
}

export const DEFAULT_CACHE_SECONDS = 60;
// The longest a page may be kept, a backstop for a change the app never invalidates.
export const MAX_CACHE_SECONDS = 3600;

const cacheSeconds = (option: PageCacheOption) => (option === true ? DEFAULT_CACHE_SECONDS : option.seconds);

export interface Page {
  path: string;
  routes: Record<string, PageRoute>;
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
const REST = /^\*([A-Za-z_][A-Za-z0-9_]*)$/;

// Claimed by the platform itself; a page under one would never be reached, or would hide it.
const RESERVED = ["/api", "/mcp", "/.well-known", "/login", "/signup", "/forgot", "/reset", "/consent", "/tokens"];

// One route with typed, checked parameters, an access gate, or cached; plain functions in
// `routes` get their parameters as strings and declare no access.
export function route<Schema extends z.ZodType, App = AnyApp>(definition: { params: Schema; access?: EndpointAccess<z.output<Schema>>; cache?: PageCacheOption }, handler: PageHandler<z.output<Schema>, App>): PageRoute<z.output<Schema>, App>;
export function route<App = AnyApp>(definition: { access?: EndpointAccess<Record<string, string>>; cache?: PageCacheOption }, handler: PageHandler<Record<string, string>, App>): PageRoute<Record<string, string>, App>;
export function route(definition: { params?: z.ZodType; access?: EndpointAccess; cache?: PageCacheOption }, handler: PageHandler): PageRoute {
  return { ...definition, handler };
}

// The path a page claims, and its routes below it: "/" is the path itself, "/:id/edit" a path
// below it whose first segment is the parameter `id`, and "/*path" every path below it at any
// depth, its segments joined as the parameter `path`. The root page is a special claim: it answers
// `/` alone, never the paths below it, which stay static files.
export const ROOT = "/";

export function page<R extends Record<string, unknown>, App = AnyApp>(definition: { path: string; routes: { [K in keyof R]: PageRoute<any, App> | PageHandler<PathParams<K & string>, App> } }): Page {
  const { path } = definition;
  if (path === ROOT) {
    const keys = Object.keys(definition.routes);
    if (keys.length !== 1 || keys[0] !== "/") throw new Error(`the root page answers / alone, so its only route is "/"; put pages below it under paths of their own, such as /about`);
  } else if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
    throw new Error(`page path ${JSON.stringify(path)} must be "/" or like /notes or /docs/guide: segments of letters, digits and . _ ~ -, no parameters and no trailing slash`);
  }
  const reserved = RESERVED.find((r) => path === r || path.startsWith(`${r}/`));
  if (reserved) throw new Error(`page path ${path} is under ${reserved}, which the platform answers itself`);
  const routes: Record<string, PageRoute> = {};
  for (const [key, value] of Object.entries(definition.routes as Record<string, PageRoute | PageHandler>)) {
    const names = routeSegments(key, path).flatMap((s) => (s.param ? [s.param] : s.rest ? [s.rest] : []));
    const r: PageRoute = typeof value === "function" ? { handler: value } : value;
    if (!r || typeof r.handler !== "function") throw new Error(`page ${path}${key}: a route is a function or route({ ... }, handler)`);
    const shape = (r.params as { shape?: Record<string, unknown> } | undefined)?.shape;
    if (r.params) for (const name of names) if (!shape || !(name in shape)) throw new Error(`page ${path}${key} has ${key.includes(`*${name}`) ? "*" : ":"}${name}, which its params schema does not have`);
    checkAccessDeclaration(r.access, shape ? Object.keys(shape) : names, `page ${path}${key}`);
    if (r.cache !== undefined) {
      const seconds = cacheSeconds(r.cache);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_CACHE_SECONDS) throw new Error(`page ${path}${key}: cache.seconds is a whole number from 1 to ${MAX_CACHE_SECONDS}`);
    }
    routes[key] = r;
  }
  if (Object.keys(routes).length === 0) throw new Error(`page ${path} has no routes`);
  return { path, routes };
}

interface Segment {
  text?: string;
  param?: string;
  // The rest of the path, one or more segments; only ever the last.
  rest?: string;
}

function routeSegments(key: string, path: string): Segment[] {
  if (key === "/") return [];
  if (!key.startsWith("/") || key.endsWith("/")) throw new Error(`page ${path}: route ${JSON.stringify(key)} must be "/" or like "/:id/edit", with no trailing slash`);
  const seen = new Set<string>();
  const parts = key.slice(1).split("/");
  return parts.map((s, i) => {
    const param = PARAM.exec(s)?.[1];
    const rest = REST.exec(s)?.[1];
    const name = param ?? rest;
    if (name) {
      if (seen.has(name)) throw new Error(`page ${path}${key} names ${name} twice`);
      seen.add(name);
    }
    if (param) return { param };
    if (rest) {
      if (i !== parts.length - 1) throw new Error(`page ${path}${key}: *${rest} takes the rest of the path, so it must be the last segment; read the segments after it from *${rest} in the handler`);
      return { rest };
    }
    if (!SEGMENT.test(s) || s === "." || s === "..") throw new Error(`page ${path}: route ${JSON.stringify(key)} has a segment that is neither text, :name nor a last *name`);
    return { text: s };
  });
}

interface Compiled {
  path: string;
  key: string;
  segments: Segment[];
  route: PageRoute;
}

export interface PageServer {
  // Every claimed path, which the deploy routes to the Worker before static files.
  claims: string[];
  // Routes that say nothing about access, which an app with access on refuses to serve.
  undeclared: string[];
  // Whether a path is a claimed one.
  owns(pathname: string): boolean;
  // The answer for a claimed path, or undefined for any other. `canSignIn` says the app has
  // sign-in screens to offer refused visitors; `cache` holds the answers of routes that ask.
  handle(request: Request, url: URL, app: AnyApp, canSignIn: boolean, cache?: PageCache): Promise<Response | undefined>;
}

export function pageServer(pages: readonly Page[]): PageServer | undefined {
  if (pages.length === 0) return undefined;
  const claims = pages.map((p) => p.path);
  for (const a of claims) {
    const clash = claims.find((b) => b !== a && (b.startsWith(`${a}/`) || b.toLowerCase() === a.toLowerCase()));
    if (clash || claims.indexOf(a) !== claims.lastIndexOf(a)) throw new Error(`pages ${a} and ${clash ?? a} claim overlapping paths; claim each path once`);
  }
  const compiled = new Map<string, Compiled[]>();
  for (const p of pages) {
    const list = Object.entries(p.routes).map(([key, route]) => ({ path: p.path, key, segments: routeSegments(key, p.path), route }));
    // Text before parameters before the rest of the path, segment by segment, so "/new" wins
    // over "/:id", which wins over "/*path".
    const rank = (s: Segment | undefined) => (s?.text !== undefined ? 0 : s?.param ? 1 : 2);
    list.sort((a, b) => {
      for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
        const d = rank(a.segments[i]) - rank(b.segments[i]);
        if (d !== 0) return d;
      }
      return 0;
    });
    const shapes = new Set<string>();
    for (const c of list) {
      const shape = `${c.segments.length}:${c.segments.map((s) => s.text ?? (s.rest ? "*" : ":")).join("/")}`;
      if (shapes.has(shape)) throw new Error(`page ${p.path} has two routes for the same paths, such as ${c.key}`);
      shapes.add(shape);
    }
    compiled.set(p.path, list);
  }

  const undeclared = [...compiled.values()].flat().filter((c) => c.route.access === undefined).map((c) => `page ${c.path}${c.key === "/" ? "" : c.key}`);

  // The root claims `/` alone; any other claim, its path and everything below it.
  const claimOf = (pathname: string) => claims.find((c) => pathname === c || (c !== ROOT && pathname.startsWith(`${c}/`)));
  return {
    claims,
    undeclared,
    owns: (pathname) => claimOf(pathname) !== undefined,
    async handle(request, url, app, canSignIn, cache) {
      const claim = claimOf(url.pathname);
      if (!claim) return undefined;
      if (request.method !== "GET" && request.method !== "HEAD") return html(errorPage(405, "This page can only be read."), 405, { allow: "GET, HEAD" });
      const rest = claim === ROOT ? "" : url.pathname.slice(claim.length).replace(/\/$/, "");
      // A missing page and a refused one get the same answer, so neither says which paths hold something.
      const refuse = async () => html(refusedPage(url, canSignIn && !(await app.session().catch(() => null))), 404);
      let parts: string[];
      try {
        parts = rest === "" ? [] : rest.slice(1).split("/").map(decodeURIComponent);
      } catch {
        return refuse();
      }
      const found = compiled.get(claim)!.find((c) => matches(c.segments, parts));
      if (!found) return refuse();
      const raw = Object.fromEntries(found.segments.flatMap((s, i) => (s.param ? [[s.param, parts[i]!]] : s.rest ? [[s.rest, parts.slice(i).join("/")]] : [])));
      let params: unknown = raw;
      if (found.route.params) {
        const checked = found.route.params.safeParse(raw);
        if (!checked.success) return refuse();
        params = checked.data;
      }
      // The gate runs before the cache, so a kept copy only ever reaches someone who passes it.
      try {
        await requireAccess(found.route.access, params, app);
      } catch (thrown) {
        if (thrown instanceof EndpointError && (thrown.status === 404 || thrown.status === 403)) return refuse();
        throw thrown;
      }
      const seconds = found.route.cache === undefined ? undefined : cacheSeconds(found.route.cache);
      let key: string | undefined;
      if (seconds && cache && request.method === "GET") {
        // A version that cannot be read means a page that is not cached, never a stale one.
        key = await cache.version(url.pathname).then(
          (version) => cacheKey(url, version),
          (error: unknown) => void console.error(`page cache skipped for ${url.pathname}:`, error),
        );
      }
      if (key) {
        const hit = await cache!.match(key);
        if (hit) return withCacheState(hit, "hit");
      }
      let answer: PageResult;
      try {
        answer = await found.route.handler(params, anonymous(app, `${claim}${found.key === "/" ? "" : found.key}`), request);
      } catch (thrown) {
        if (!(thrown instanceof EndpointError)) throw thrown;
        return html(errorPage(thrown.status, thrown.message), thrown.status);
      }
      const response = typeof answer === "string" ? html(answer, 200) : answer;
      if (key && response.status === 200 && !response.headers.has("set-cookie")) {
        const kept = new Response(response.clone().body, response);
        kept.headers.set("cache-control", `public, max-age=${seconds}`);
        cache!.put(key, kept);
        return withCacheState(response, "miss");
      }
      return request.method === "HEAD" ? new Response(null, response) : response;
    },
  };
}

// A rest segment takes one or more whole segments; one holding an encoded "/" would read the same as
// two, so it matches nothing.
function matches(segments: Segment[], parts: string[]): boolean {
  const rest = segments.at(-1)?.rest !== undefined;
  if (rest ? parts.length < segments.length : parts.length !== segments.length) return false;
  return parts.every((part, i) => {
    const s = segments[Math.min(i, segments.length - 1)]!;
    if (s.rest !== undefined && i >= segments.length - 1) return part !== "" && !part.includes("/");
    return s.param ? part !== "" : s.text === part;
  });
}

// What who is looking would tell a page, refused, so everyone who passes the gate gets the same
// answer and a kept copy can be shown to any of them.
const WHO = ["session", "requireUser", "access"];

function anonymous(app: AnyApp, name: string): AnyApp {
  return new Proxy(app, {
    get(target, key) {
      if (typeof key === "string" && WHO.includes(key)) {
        throw new Error(`page ${name} asked app.${key}, but a page renders only what is identical for everyone it lets in; gate it with access, and render anything that depends on who is looking in the browser, from an endpoint`);
      }
      return Reflect.get(target, key);
    },
  });
}

// Under a path no page can claim, since `!` is never in one, so a visitor can never ask for a key.
const cacheKey = (url: URL, version: string) => `${url.origin}/!page-cache/${encodeURIComponent(version)}${url.pathname}${url.search}`;

// The browser never keeps a page; only the edge does, behind the gate.
function withCacheState(response: Response, state: "hit" | "miss"): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("platform-cache", state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function html(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(status: number, message: string, extra = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title></head><body><h1>${status}</h1><p>${escape(message)}</p>${extra}<p><a href="/">Home</a></p></body></html>`;
}

// The one answer for a page that is missing or refused. A signed-out visitor is offered sign-in
// and sign-up, which return here, and is never sent anywhere unasked. Its script takes a `link=`
// token from the fragment, which never reaches the server, drops it from the address so a refused
// link never loops, has the platform keep it as a cookie, then reloads.
function refusedPage(url: URL, signedOut: boolean): string {
  const next = encodeURIComponent(url.pathname + url.search);
  const offer = signedOut ? `<p><a href="/login?next=${escape(next)}">Sign in</a> or <a href="/signup?next=${escape(next)}">sign up</a></p>` : "";
  const script = `<script>
(() => {
  const parts = location.hash.replace(/^#/, "").split("&");
  const found = parts.find((p) => p.startsWith("link="));
  if (!found) return;
  const rest = parts.filter((p) => !p.startsWith("link=")).join("&");
  history.replaceState(null, "", location.pathname + location.search + (rest ? "#" + rest : ""));
  fetch(${JSON.stringify(LINK_EXCHANGE_PATH)}, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: found.slice(5) }) })
    .then((r) => { if (r.ok) location.reload(); }, () => {});
})();
</script>`;
  return errorPage(404, "There is nothing here.", offer + script);
}
