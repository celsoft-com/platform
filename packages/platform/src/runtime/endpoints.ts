import { ORPCError, os, type Router } from "@orpc/server";
import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { experimental_ZodSmartCoercionPlugin, ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import type { z } from "zod";
import { rank, type Access, type Level } from "./access.js";
import type { Cache } from "./cache.js";
import { bodyLimit, uploadFields } from "./upload.js";
import { EndpointError, refusal } from "./endpoint-error.js";
import type { AnyApp } from "./types.js";

export type { AnyApp };

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Door = "api" | "mcp";

export interface EndpointDefinition<Input extends z.ZodType, Output extends z.ZodType> {
  // Where the function is served; the API by default.
  serve?: readonly Door[];
  // Needed only when served over the API; `:name` path segments are fields of the input.
  method?: Method;
  path?: string;
  description?: string;
  input: Input;
  output: Output;
  // Checked before the function runs: the caller needs `level` on the control point named by the
  // input field `point`, or by what the function returns for the input, or gets a 404. `{ level }`
  // alone checks no point and lets in anyone signed in, but an API token capped below `level` gets
  // a 403; "anon" lets in anyone at all. Over the API the path agrees, so an "anon" endpoint sits
  // under /api/public/ and a `{ level }` one never does. Every endpoint says one of them.
  access?: EndpointAccess<z.output<Input>>;
  // The cached pages a successful call empties, once the handler returns and before the answer
  // goes out: "all" clears every page, a list or a function of the input and output names paths,
  // and [] empties none. Without it, the app's `invalidates` applies to every endpoint but a GET.
  invalidates?: Invalidates<z.output<Input>, z.input<Output>>;
}

export type Invalidates<In = any, Out = any> = "all" | readonly string[] | ((input: In, output: Out) => readonly string[] | Promise<readonly string[]>);

// A point is an input field, or a function of the input returning one id or a list, sync or async;
// with a list, the first point that exists decides.
export type PointIds = string | readonly string[];
export type EndpointAccess<In = any> = { point: string | ((input: In) => PointIds | Promise<PointIds>); level: Level } | { level: Level } | "anon";

const hasPoint = (access: object): access is { point: unknown } => "point" in access && access.point !== undefined;

export interface Endpoint<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType, App = AnyApp> extends EndpointDefinition<Input, Output> {
  handler: (input: z.output<Input>, app: App) => z.input<Output> | Promise<z.input<Output>>;
}

// One typed function: its Zod schemas are its only types, wherever it is served.
export function endpoint<Input extends z.ZodType, Output extends z.ZodType, App = AnyApp>(
  definition: EndpointDefinition<Input, Output>,
  handler: (input: z.output<Input>, app: App) => z.input<Output> | Promise<z.input<Output>>,
): Endpoint<Input, Output, App> {
  const shape = (definition.input as { shape?: Record<string, unknown> }).shape;
  const what = definition.path ? `the endpoint at ${definition.path}` : "an endpoint";
  checkAccessDeclaration(definition.access, shape && Object.keys(shape), what);
  checkInvalidates(definition.invalidates, what);
  return { ...definition, handler };
}

// The endpoints that say nothing about access, which an app with access on refuses to serve.
export function undeclaredAccess(endpoints: Record<string, { access?: unknown }>): string[] {
  return Object.entries(endpoints)
    .filter(([, e]) => e.access === undefined)
    .map(([name]) => name);
}

// Throws when an endpoint says nothing about access, naming each, so the app stops at start.
export function requireDeclaredAccess(endpoints: Record<string, { access?: unknown }>): void {
  const names = undeclaredAccess(endpoints);
  if (names.length > 0) throw new Error(`${names.map((n) => `endpoint ${n}`).join(", ")} declare no access; add access: { level: "read" } (or "create", "write", "delete", "manage") for anyone signed in, { point, level } or "anon"`);
}

// Throws when `invalidates` is neither "all", a list of paths nor a function; `what` names its owner.
export function checkInvalidates(invalidates: unknown, what: string): void {
  if (invalidates === undefined || invalidates === "all" || typeof invalidates === "function") return;
  if (!Array.isArray(invalidates) || invalidates.some((path) => typeof path !== "string")) throw new Error(`${what}'s invalidates is "all", a list of paths such as ["/stats"], or a function of the input and output returning one`);
}

// Gives every endpoint that sets no `invalidates` the app's, except a GET, which changes nothing.
export function withInvalidates<T extends Record<string, { method?: Method; invalidates?: Invalidates }>>(endpoints: T, invalidates: "all" | readonly string[] | undefined): T {
  if (invalidates === undefined) return endpoints;
  checkInvalidates(invalidates, "the app");
  return Object.fromEntries(Object.entries(endpoints).map(([name, e]) => [name, e.invalidates !== undefined || e.method === "GET" ? e : { ...e, invalidates }])) as T;
}

// Runs one endpoint's function for either door, after its access check, then empties the cached
// pages it declares; a failed handler empties nothing.
export async function runEndpoint<App>(e: Endpoint<z.ZodType, z.ZodType, App>, input: unknown, app: App): Promise<unknown> {
  await requireAccess(e.access, input, app as unknown as AccessCaller);
  const output = await e.handler(input as z.output<z.ZodType>, app);
  if (e.invalidates !== undefined) await invalidate(e.invalidates, input, output, (app as { cache: Cache }).cache);
  return output;
}

// A write that succeeded still answers success when emptying fails; its pages expire within `seconds`.
async function invalidate(invalidates: Invalidates, input: unknown, output: unknown, cache: Cache): Promise<void> {
  try {
    const paths = typeof invalidates === "function" ? await invalidates(input, output) : invalidates;
    if (paths === "all") await cache.clear();
    else for (const path of new Set(paths)) await cache.invalidate(path);
  } catch (error) {
    console.error("emptying cached pages after an endpoint failed; they expire within their seconds", error);
  }
}

// Who a check asks about; every `app` is one.
export interface AccessCaller {
  session(): Promise<unknown>;
  readonly cap: Level | undefined;
  readonly access: Access;
}

// The check an endpoint or a page declares, run against its input. "anon" checks nothing; `{ level }`
// needs someone signed in and an API token capped at `level` or above; a point is checked by `app.access`.
// Returns the point that admitted the caller, or null when the check names none.
export async function requireAccess(access: EndpointAccess | undefined, input: unknown, app: AccessCaller): Promise<string | null> {
  if (!access || access === "anon") return null;
  if (!hasPoint(access)) {
    if (!(await app.session())) throw new EndpointError(404, "not found");
    const cap = app.cap;
    if (cap && rank(cap) < rank(access.level)) throw new EndpointError(403, `this API token is capped at ${cap}; this needs ${access.level}`);
    return null;
  }
  const { point, level } = access as { point: string | ((input: unknown) => PointIds | Promise<PointIds>); level: Level };
  const named = typeof point === "function" ? await point(input) : (input as Record<string, unknown>)[point];
  // Nothing, as when the input lacks the field, is a missing point; a value of another type is a bug.
  if (typeof point === "function" && named != null && typeof named !== "string" && !(Array.isArray(named) && named.every((id) => typeof id === "string"))) {
    throw new Error(`an access point function returned ${JSON.stringify(named)}; it returns a control point id or a list of them`);
  }
  const ids = typeof named === "string" ? [named] : Array.isArray(named) ? (named as unknown[]) : [named];
  // A point id the input cannot name, such as an empty or missing one, looks like any missing point.
  if (ids.length === 0 || ids.some((id) => typeof id !== "string" || id.length === 0 || id.length > 200)) throw new EndpointError(404, "not found");
  return (await app.access.admit(ids.length === 1 ? (ids[0] as string) : (ids as string[]), level)).point;
}

// Throws when an access declaration is neither { point, level }, { level } nor "anon", or names a
// field `fields` lacks; `what` names its owner in the message.
export function checkAccessDeclaration(access: unknown, fields: readonly string[] | undefined, what: string): void {
  if (access === undefined || access === "anon") return;
  if (access === "user") throw new Error(`${what}'s access "user" is now { level }: { level: "read" } for reads, or "create", "write", "delete" or "manage" for changes; an API token capped below it gets a 403`);
  if (typeof access !== "object" || access === null || !("level" in access)) throw new Error(`${what}'s access is { point, level }, { level } or "anon"`);
  const { point, level } = access as { point: unknown; level: Level };
  rank(level);
  if (point === undefined) return;
  if (typeof point === "string") {
    if (!fields || !fields.includes(point)) throw new Error(`${what}'s access names ${point}, which it does not have`);
  } else if (typeof point !== "function") throw new Error(`${what}'s access point is a field name or a function`);
}

export type Endpoints = Record<string, Endpoint<z.ZodType, z.ZodType, never>>;

export interface Route {
  method: Method;
  path: string;
}

export const servesApi = (e: { serve?: readonly Door[] }) => (e.serve ?? ["api"]).includes("api");

// The method and path of every endpoint served over the API, checked once: each must say both,
// stay under /api/, and use only input fields as path parameters.
export function apiRoutes(endpoints: Record<string, Omit<Endpoint, "handler">>): Record<string, Route> {
  const routes: Record<string, Route> = {};
  for (const [name, e] of Object.entries(endpoints)) {
    if (!servesApi(e)) continue;
    if (!e.method || !e.path) throw new Error(`endpoint ${name} is served over the API, so it needs a method and a path`);
    if (!e.path.startsWith("/api/")) throw new Error(`endpoint ${name}'s path must start with /api/, where the Worker answers first`);
    const isPublic = e.path.startsWith("/api/public/");
    if (e.access === "anon" && !isPublic) throw new Error(`endpoint ${name} lets anyone in with access "anon", so its path goes under /api/public/; or give it access { level }`);
    if (typeof e.access === "object" && !hasPoint(e.access) && isPublic) throw new Error(`endpoint ${name} is under /api/public/, where anyone may call, but its access is { level }, for those signed in; make it "anon", or move it out of /api/public/`);
    const shape = (e.input as { shape?: Record<string, unknown> }).shape;
    for (const [, param] of e.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!shape || !(param! in shape)) throw new Error(`endpoint ${name}'s path has :${param}, which its input schema does not have`);
    }
    routes[name] = { method: e.method, path: e.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}") };
  }
  return routes;
}

// A route's path as a pattern matching the paths it answers, each {name} one segment.
const pathPattern = (path: string) => new RegExp(`^${path.split("/").map((segment) => (/^\{.+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}$`);

// Whether a GET endpoint served over the API answers a path, before its input is checked.
export function getMatcher(endpoints: Record<string, Omit<Endpoint, "handler">>): (pathname: string) => boolean {
  const patterns = Object.values(apiRoutes(endpoints))
    .filter((route) => route.method === "GET")
    .map((route) => pathPattern(route.path));
  return (pathname) => patterns.some((pattern) => pattern.test(pathname));
}

// Where any client learns the API: every endpoint served over it, with its method, path, input and
// output schemas, and the access it needs.
export const OPENAPI_PATH = "/api/platform/openapi.json";

// What an endpoint needs, as `x-platform-access` on its operation: anyone, anyone signed in at a
// level, or a level on a control point the input names (`point` is the input field, or "computed").
function accessSpec(access: EndpointAccess | undefined): Record<string, unknown> {
  if (!access || access === "anon") return { anyone: true };
  if (!hasPoint(access)) return { level: access.level };
  const { point, level } = access as { point: unknown; level: Level };
  return { level, point: typeof point === "string" ? point : "computed" };
}

function apiRouter<App>(endpoints: Record<string, Endpoint<z.ZodType, z.ZodType, App>>, routes: Record<string, Route>): Router<any, { app: App }> {
  const base = os.$context<{ app: App }>();
  return Object.fromEntries(
    Object.keys(routes).map((name) => {
      const e = endpoints[name]!;
      const procedure = base
        .route({
          method: routes[name]!.method,
          path: routes[name]!.path as `/${string}`,
          ...(e.description && { description: e.description }),
          spec: (operation) => ({ ...operation, "x-platform-access": accessSpec(e.access) }),
        })
        .input(e.input)
        .output(e.output)
        .handler(async ({ input, context }) => {
          try {
            return await runEndpoint(e, input, context.app);
          } catch (error) {
            const refused = await refusal(error);
            if (refused) throw new ORPCError("ENDPOINT_ERROR", refused);
            throw error;
          }
        });
      return [name, procedure];
    }),
  );
}

// The OpenAPI 3.1 document of the endpoints served over the API, as OPENAPI_PATH serves it; app code
// can build its own reference page from it.
export async function openApiDocument(endpoints: Record<string, Endpoint<z.ZodType, z.ZodType, any>>, info: { title: string; version?: string; url?: string }): Promise<Record<string, unknown>> {
  const routes = apiRoutes(endpoints);
  const generator = new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] });
  const document = await generator.generate(apiRouter(endpoints, routes), {
    info: { title: info.title, version: info.version ?? "1" },
    ...(info.url && { servers: [{ url: info.url }] }),
  });
  return document as unknown as Record<string, unknown>;
}

export interface ApiHandler<App> {
  handle(request: Request, app: App): Promise<Response | undefined>;
}

// Serves the API endpoints through oRPC, which maps path, query and body into the input, converts
// URL strings to the schema's types, and checks input and output; the app never sees it.
export function apiHandler<App>(endpoints: Record<string, Endpoint<z.ZodType, z.ZodType, App>>): ApiHandler<App> | undefined {
  const routes = apiRoutes(endpoints);
  const names = Object.keys(routes);
  if (names.length === 0) return undefined;
  // Endpoints taking files refuse a body over their files' limits before reading it.
  const limits = names.flatMap((name) => {
    const fields = uploadFields(endpoints[name]!.input);
    return Object.keys(fields).length === 0 ? [] : [{ method: routes[name]!.method, pattern: pathPattern(routes[name]!.path), bytes: bodyLimit(fields) }];
  });

  const router = apiRouter(endpoints, routes);
  let document: Promise<Record<string, unknown>> | undefined;
  const handler = new OpenAPIHandler(router, {
    plugins: [new experimental_ZodSmartCoercionPlugin()],
    clientInterceptors: [
      async ({ next, path }) => {
        try {
          return await next();
        } catch (error) {
          if (!(error instanceof ORPCError) || error.status >= 500) console.error(`endpoint ${path.join(".")} failed`, error instanceof ORPCError ? (error.cause ?? error) : error);
          throw error;
        }
      },
    ],
  });

  return {
    async handle(request, app) {
      const length = Number(request.headers.get("content-length") ?? 0);
      const pathname = new URL(request.url).pathname;
      if (pathname === OPENAPI_PATH && (request.method === "GET" || request.method === "HEAD")) {
        const current = app as { env?: { APP_NAME?: string; APP_URL?: string; DEPLOY_COMMIT?: string; BETTER_AUTH_SECRET?: string }; session?: () => Promise<unknown> };
        const env = current.env ?? {};
        // Like every /api/ path outside /api/public/, it needs someone signed in once the app has auth.
        if (env.BETTER_AUTH_SECRET && !(await current.session?.().catch(() => null))) return Response.json({ error: "sign in to read the API document" }, { status: 401 });
        document ??= openApiDocument(endpoints, { title: env.APP_NAME ?? "app", version: env.DEPLOY_COMMIT, url: env.APP_URL });
        return Response.json(await document);
      }
      const limit = limits.find((l) => l.method === request.method && l.pattern.test(pathname));
      if (limit && length > limit.bytes) return Response.json({ error: `the request is ${length} bytes; this endpoint takes at most ${limit.bytes}` }, { status: 413 });
      const { matched, response } = await handler.handle(request, { context: { app } });
      if (!matched || !response) return undefined;
      if (response.ok) return response;
      // oRPC's error body, with the `error` every platform API error carries; failed validation
      // names each field, such as "where: unexpected '=' at 12".
      const body = (await response.json().catch(() => ({}))) as { message?: string; data?: { issues?: { path?: (string | number)[]; message: string }[] } };
      const issues = body.data?.issues;
      const error = Array.isArray(issues) && issues.length > 0 ? issues.map((i) => (i.path?.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ") : (body.message ?? response.statusText);
      return Response.json({ error, ...body }, { status: response.status });
    },
  };
}
