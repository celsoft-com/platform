import type { z } from "zod";
import { EndpointError } from "./endpoint-error.js";
import { checkAccessDeclaration, requireAccess, type AnyApp, type EndpointAccess } from "./endpoints.js";

// Pages the Worker renders on each request. An app claims a path such as `/notes`; the Worker then
// answers it and every path below it, and no static file is ever served there.

type ParamNames<S extends string> = S extends `${string}:${infer P}/${infer Rest}` ? P | ParamNames<`/${Rest}`> : S extends `${string}:${infer P}` ? P : never;

// The `:name` segments of a route, as strings.
export type PathParams<S extends string> = { [K in ParamNames<S>]: string };

// HTML, or a whole Response such as a redirect.
export type PageResult = string | Response;
export type PageHandler<Params = any, App = AnyApp> = (params: Params, app: App, request: Request) => PageResult | Promise<PageResult>;

export interface PageRoute<Params = any, App = AnyApp> {
  // Checks and converts the route's parameters, as an endpoint's input schema does; a failure is a 404.
  params?: z.ZodType;
  // Checked before the handler runs, as for an endpoint; with access on, every route says it.
  access?: EndpointAccess<Params>;
  handler: PageHandler<Params, App>;
}

export interface Page {
  path: string;
  routes: Record<string, PageRoute>;
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

// Claimed by the platform itself; a page under one would never be reached, or would hide it.
const RESERVED = ["/api", "/mcp", "/.well-known", "/login", "/signup", "/forgot", "/reset", "/consent", "/tokens"];

// One route with typed, checked parameters and an access check; plain functions in `routes` get
// their parameters as strings and declare no access.
export function route<Schema extends z.ZodType, App = AnyApp>(
  definition: { params: Schema; access?: EndpointAccess<z.output<Schema>> },
  handler: PageHandler<z.output<Schema>, App>,
): PageRoute<z.output<Schema>, App>;
export function route<App = AnyApp>(definition: { access?: EndpointAccess<Record<string, string>> }, handler: PageHandler<Record<string, string>, App>): PageRoute<Record<string, string>, App>;
export function route(definition: { params?: z.ZodType; access?: EndpointAccess }, handler: PageHandler): PageRoute {
  return { ...definition, handler };
}

// The path a page claims, and its routes below it: "/" is the path itself, "/:id/edit" a path
// below it whose first segment is the parameter `id`.
export function page<R extends Record<string, unknown>, App = AnyApp>(definition: { path: string; routes: { [K in keyof R]: PageRoute<any, App> | PageHandler<PathParams<K & string>, App> } }): Page {
  const { path } = definition;
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(path) || path.split("/").some((s) => s === "." || s === "..")) {
    throw new Error(`page path ${JSON.stringify(path)} must be like /notes or /docs/guide: segments of letters, digits and . _ ~ -, no parameters and no trailing slash`);
  }
  const reserved = RESERVED.find((r) => path === r || path.startsWith(`${r}/`));
  if (reserved) throw new Error(`page path ${path} is under ${reserved}, which the platform answers itself`);
  const routes: Record<string, PageRoute> = {};
  for (const [key, value] of Object.entries(definition.routes as Record<string, PageRoute | PageHandler>)) {
    const names = routeSegments(key, path).flatMap((s) => (s.param ? [s.param] : []));
    const r: PageRoute = typeof value === "function" ? { handler: value } : value;
    if (!r || typeof r.handler !== "function") throw new Error(`page ${path}${key}: a route is a function or route({ ... }, handler)`);
    const shape = (r.params as { shape?: Record<string, unknown> } | undefined)?.shape;
    if (r.params) for (const name of names) if (!shape || !(name in shape)) throw new Error(`page ${path}${key} has :${name}, which its params schema does not have`);
    checkAccessDeclaration(r.access, shape ? Object.keys(shape) : names, `page ${path}${key}`);
    routes[key] = r;
  }
  if (Object.keys(routes).length === 0) throw new Error(`page ${path} has no routes`);
  return { path, routes };
}

interface Segment {
  text?: string;
  param?: string;
}

function routeSegments(key: string, path: string): Segment[] {
  if (key === "/") return [];
  if (!key.startsWith("/") || key.endsWith("/")) throw new Error(`page ${path}: route ${JSON.stringify(key)} must be "/" or like "/:id/edit", with no trailing slash`);
  const seen = new Set<string>();
  return key
    .slice(1)
    .split("/")
    .map((s) => {
      const param = PARAM.exec(s)?.[1];
      if (param) {
        if (seen.has(param)) throw new Error(`page ${path}${key} names :${param} twice`);
        seen.add(param);
        return { param };
      }
      if (!SEGMENT.test(s) || s === "." || s === "..") throw new Error(`page ${path}: route ${JSON.stringify(key)} has a segment that is neither text nor :name`);
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
  // The answer for a claimed path, or undefined for any other. `signIn` is the redirect to the
  // sign-in screen, when the app has one.
  handle(request: Request, url: URL, app: AnyApp, signIn: (() => Response) | undefined): Promise<Response | undefined>;
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
    // Text before parameters, segment by segment, so "/new" wins over "/:id".
    list.sort((a, b) => {
      for (let i = 0; i < Math.min(a.segments.length, b.segments.length); i++) {
        const d = Number(Boolean(a.segments[i]!.param)) - Number(Boolean(b.segments[i]!.param));
        if (d !== 0) return d;
      }
      return 0;
    });
    const shapes = new Set<string>();
    for (const c of list) {
      const shape = `${c.segments.length}:${c.segments.map((s) => s.text ?? ":").join("/")}`;
      if (shapes.has(shape)) throw new Error(`page ${p.path} has two routes for the same paths, such as ${c.key}`);
      shapes.add(shape);
    }
    compiled.set(p.path, list);
  }
  const undeclared = [...compiled.values()].flat().filter((c) => c.route.access === undefined).map((c) => `page ${c.path}${c.key === "/" ? "" : c.key}`);

  return {
    claims,
    undeclared,
    async handle(request, url, app, signIn) {
      const claim = claims.find((c) => url.pathname === c || url.pathname.startsWith(`${c}/`));
      if (!claim) return undefined;
      if (request.method !== "GET" && request.method !== "HEAD") return html(errorPage(405, "This page can only be read."), 405, { allow: "GET, HEAD" });
      const rest = url.pathname.slice(claim.length).replace(/\/$/, "");
      let parts: string[];
      try {
        parts = rest === "" ? [] : rest.slice(1).split("/").map(decodeURIComponent);
      } catch {
        return notFound();
      }
      const found = compiled.get(claim)!.find((c) => c.segments.length === parts.length && c.segments.every((s, i) => (s.param ? parts[i] !== "" : s.text === parts[i])));
      if (!found) return notFound();
      const raw = Object.fromEntries(found.segments.flatMap((s, i) => (s.param ? [[s.param, parts[i]!]] : [])));
      let params: unknown = raw;
      if (found.route.params) {
        const checked = found.route.params.safeParse(raw);
        if (!checked.success) return notFound();
        params = checked.data;
      }
      let answer: PageResult;
      try {
        await requireAccess(found.route.access, params, app);
        answer = await found.route.handler(params, app, request);
      } catch (thrown) {
        if (!(thrown instanceof EndpointError)) throw thrown;
        // Someone signed out may be refused only for that; signing in may show the page.
        if (signIn && thrown.status === 404 && !(await app.session())) return signIn();
        return html(errorPage(thrown.status, thrown.status === 404 ? "There is nothing here." : thrown.message), thrown.status);
      }
      const response = typeof answer === "string" ? html(answer, 200) : answer;
      return request.method === "HEAD" ? new Response(null, response) : response;
    },
  };
}

const notFound = () => html(errorPage(404, "There is nothing here."), 404);

function html(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers } });
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(status: number, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${status}</title></head><body><h1>${status}</h1><p>${escape(message)}</p><p><a href="/">Home</a></p></body></html>`;
}
