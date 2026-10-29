import { ORPCError, os, type Router } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import type { z } from "zod";
import { rank, type Access, type Level } from "./access.js";
import { EndpointError } from "./endpoint-error.js";
import type { AppContext } from "./index.js";

// What a handler gets as `app`; an app wanting its own secrets and tables typed annotates the
// parameter with its own AppContext.
export type AnyApp = AppContext<any, any>;

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
  // input field `point`, or by what the function returns for the input, or gets a 404. "user"
  // checks no point and lets in anyone signed in, "anon" anyone at all; over the API the path
  // agrees, so an "anon" endpoint sits under /api/public/ and a "user" one never does. With access
  // on, every endpoint says one of them.
  access?: EndpointAccess<z.output<Input>>;
}

export type EndpointAccess<In = any> = { point: string | ((input: In) => string); level: Level } | "user" | "anon";

// Who an access declaration with no point lets in.
export const OPEN_ACCESS = ["user", "anon"] as const;

const isOpen = (access: unknown): access is "user" | "anon" => (OPEN_ACCESS as readonly unknown[]).includes(access);

export interface Endpoint<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType, App = AnyApp> extends EndpointDefinition<Input, Output> {
  handler: (input: z.output<Input>, app: App) => z.input<Output> | Promise<z.input<Output>>;
}

// One typed function: its Zod schemas are its only types, wherever it is served.
export function endpoint<Input extends z.ZodType, Output extends z.ZodType, App = AnyApp>(
  definition: EndpointDefinition<Input, Output>,
  handler: (input: z.output<Input>, app: App) => z.input<Output> | Promise<z.input<Output>>,
): Endpoint<Input, Output, App> {
  const shape = (definition.input as { shape?: Record<string, unknown> }).shape;
  checkAccessDeclaration(definition.access, shape && Object.keys(shape), "an endpoint");
  return { ...definition, handler };
}

// The endpoints that say nothing about access, which an app with access on refuses to serve.
export function undeclaredAccess(endpoints: Record<string, { access?: unknown }>): string[] {
  return Object.entries(endpoints)
    .filter(([, e]) => e.access === undefined)
    .map(([name]) => name);
}

// Runs one endpoint's function for either door, after its access check.
export async function runEndpoint<App>(e: Endpoint<z.ZodType, z.ZodType, App>, input: unknown, app: App): Promise<unknown> {
  await requireAccess(e.access, input, app);
  return e.handler(input as z.output<z.ZodType>, app);
}

// The point check an endpoint or a page declares, run against its input; "user" and "anon" check
// no point, since who may call is settled before, by the path for an endpoint and by the page.
export async function requireAccess(access: EndpointAccess | undefined, input: unknown, app: unknown): Promise<void> {
  if (!access || isOpen(access)) return;
  const { point, level } = access;
  const id = typeof point === "function" ? point(input) : (input as Record<string, unknown>)[point];
  // A point id the input cannot name, such as an empty or missing one, looks like any missing point.
  if (typeof id !== "string" || id.length === 0 || id.length > 200) throw new EndpointError(404, "not found");
  await (app as { access: Access }).access.require(id, level);
}

// Throws when an access declaration is neither { point, level }, "user" nor "anon", or names a
// field `fields` lacks; `what` names its owner in the message.
export function checkAccessDeclaration(access: unknown, fields: readonly string[] | undefined, what: string): void {
  if (access === undefined || isOpen(access)) return;
  if (typeof access !== "object" || access === null || !("level" in access)) throw new Error(`${what}'s access is { point, level }, "user" or "anon"`);
  const { point, level } = access as { point: unknown; level: Level };
  rank(level);
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
    if (e.access === "anon" && !isPublic) throw new Error(`endpoint ${name} lets anyone in with access "anon", so its path goes under /api/public/; or give it access "user"`);
    if (e.access === "user" && isPublic) throw new Error(`endpoint ${name} is under /api/public/, where anyone may call, but its access is "user"; make it "anon", or move it out of /api/public/`);
    const shape = (e.input as { shape?: Record<string, unknown> }).shape;
    for (const [, param] of e.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
      if (!shape || !(param! in shape)) throw new Error(`endpoint ${name}'s path has :${param}, which its input schema does not have`);
    }
    routes[name] = { method: e.method, path: e.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}") };
  }
  return routes;
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

  const base = os.$context<{ app: App }>();
  const router: Router<any, { app: App }> = Object.fromEntries(
    names.map((name) => {
      const e = endpoints[name]!;
      const procedure = base
        .route({ method: routes[name]!.method, path: routes[name]!.path as `/${string}`, ...(e.description && { description: e.description }) })
        .input(e.input)
        .output(e.output)
        .handler(async ({ input, context }) => {
          try {
            return await runEndpoint(e, input, context.app);
          } catch (error) {
            if (error instanceof EndpointError) throw new ORPCError("ENDPOINT_ERROR", { status: error.status, message: error.message });
            // A thrown Response, as requireUser throws, keeps its status and message.
            if (error instanceof Response) {
              const { error: message } = (await error.json().catch(() => ({}))) as { error?: string };
              throw new ORPCError("ENDPOINT_ERROR", { status: error.status, message: message ?? error.statusText });
            }
            throw error;
          }
        });
      return [name, procedure];
    }),
  );
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
      const { matched, response } = await handler.handle(request, { context: { app } });
      if (!matched || !response) return undefined;
      if (response.ok) return response;
      // oRPC's error body, with the `error` every platform API error carries.
      const body = (await response.json().catch(() => ({}))) as { message?: string };
      return Response.json({ error: body.message ?? response.statusText, ...body }, { status: response.status });
    },
  };
}
