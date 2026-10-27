import { createORPCClient, ORPCError } from "@orpc/client";
import { oc } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import type { z } from "zod";
import { EndpointError } from "./endpoint-error.js";
import { LINK_EXCHANGE_PATH, LINK_HEADER } from "./link-header.js";

export { EndpointError };

declare const location: { origin: string; hash: string } | undefined;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

// What arrives over JSON: dates become strings.
type Jsonified<T> = T extends Date ? string : T extends readonly (infer U)[] ? Jsonified<U>[] : T extends object ? { [K in keyof T]: Jsonified<T[K]> } : T;

type EndpointsOf<App> = App extends { endpoints: infer E } ? E : never;
type InputOf<E> = E extends { input: infer I extends z.ZodType } ? z.input<I> : never;
type OutputOf<E> = E extends { output: infer O extends z.ZodType } ? Jsonified<z.output<O>> : never;

export type Call<App> = <Name extends keyof EndpointsOf<App> & string>(name: Name, input: InputOf<EndpointsOf<App>[Name]>) => Promise<OutputOf<EndpointsOf<App>[Name]>>;

// The access link token in the page's address, written `#link=<token>`; a fragment never reaches
// the server, so tokens stay out of its logs and Referer headers.
export function linkFromPage(): string | null {
  if (typeof location === "undefined") return null;
  return new URLSearchParams(location.hash.replace(/^#/, "")).get("link");
}

// Calls the app's endpoints by name over its REST API; the generated .platform/client.ts passes
// each endpoint's method and path, and the app's own type for the inputs and outputs. Every call
// carries the page's access link token, or the one `link` returns. In a browser, the page's token
// is also kept as a cookie once, so plain links such as downloads and server pages count it too.
export function createCall<App>(routes: Record<string, readonly [Method, string]>, options: { url?: string; link?: () => string | null } = {}): Call<App> {
  const contract = Object.fromEntries(Object.entries(routes).map(([name, [method, path]]) => [name, oc.route({ method, path: path as `/${string}` })]));
  const url = options.url ?? (typeof location === "undefined" ? undefined : location.origin);
  if (!url) throw new Error("createCall needs a url outside a browser");
  const client = createORPCClient<Record<string, (input: unknown) => Promise<unknown>>>(new OpenAPILink(contract, {
      url,
      headers: (): Record<string, string> => {
        const token = (options.link ?? linkFromPage)();
        return token ? { [LINK_HEADER]: token } : {};
      },
    }));

  let kept: string | null = null;
  const keep = () => {
    const token = typeof location === "undefined" || options.link ? null : linkFromPage();
    if (!token || token === kept) return;
    kept = token;
    fetch(`${url}${LINK_EXCHANGE_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: token }), credentials: "same-origin" }).catch(() => {});
  };

  return (async (name: string, input: unknown) => {
    keep();
    const fn = routes[name] && client[name];
    if (!fn) throw new Error(`no API endpoint named ${name}`);
    try {
      return await fn(input);
    } catch (error) {
      if (error instanceof ORPCError) throw new EndpointError(error.status, error.message);
      throw error;
    }
  }) as Call<App>;
}
