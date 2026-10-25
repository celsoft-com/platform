import { ORPCError, os, type Router } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { experimental_ZodSmartCoercionPlugin } from "@orpc/zod/zod4";
import type { z } from "zod";
import type { Access, Level } from "./access.js";
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
  // Checked before the function runs: the caller needs `level` on the `kind` item whose id is in
  // the input field named `id`, or gets a 404.
  access?: { kind: string; id: string; level: Level };
}

export interface Endpoint<Input extends z.ZodType = z.ZodType, Output extends z.ZodType = z.ZodType, App = AnyApp> extends EndpointDefinition<Input, Output> {
  handler: (input: z.output<Input>, app: App) => z.input<Output> | Promise<z.input<Output>>;
}

// One typed function: its Zod schemas are its only types, wherever it is served.
export function endpoint<Input extends z.ZodType, Output extends z.ZodType, App = AnyApp>(
  definition: EndpointDefinition<Input, Output>,
  handler: (input: z.output<Input>, app: App) => z.input<Output> | Promise<z.input<Output>>,
): Endpoint<Input, Output, App> {
  if (definition.access) {
    const shape = (definition.input as { shape?: Record<string, unknown> }).shape;
    if (!shape || !(definition.access.id in shape)) throw new Error(`an endpoint's access names input field ${definition.access.id}, which its input schema does not have`);
  }
  return { ...definition, handler };
}

// Runs one endpoint's function for either door, after its access check.
export async function runEndpoint<App>(e: Endpoint<z.ZodType, z.ZodType, App>, input: unknown, app: App): Promise<unknown> {
  if (e.access) {
    const { kind, id, level } = e.access;
    await (app as { access: Access }).access.require(kind, String((input as Record<string, unknown>)[id]), level);
  }
  return e.handler(input as z.output<z.ZodType>, app);
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
