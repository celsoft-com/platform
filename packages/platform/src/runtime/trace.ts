import type { Pool, PoolClient } from "pg";

// Where a request's time goes, sent back as a Server-Timing header on previews and in local dev,
// so a slow page can be read in the browser's network panel: every database query with its
// duration, connecting, and the whole request.
export class Trace {
  private readonly start = performance.now();
  private readonly entries: { name: string; ms: number; what: string }[] = [];

  add(name: string, ms: number, what: string): void {
    this.entries.push({ name, ms, what });
  }

  async time<T>(name: string, what: string, run: () => Promise<T>): Promise<T> {
    const at = performance.now();
    try {
      return await run();
    } finally {
      this.add(name, performance.now() - at, what);
    }
  }

  header(): string {
    const total = performance.now() - this.start;
    const db = this.entries.filter((e) => e.name === "db").reduce((sum, e) => sum + e.ms, 0);
    const parts = this.entries.map((e, i) => `${e.name}-${i + 1};dur=${e.ms.toFixed(1)};desc=${JSON.stringify(e.what.slice(0, 120))}`);
    return [`total;dur=${total.toFixed(1)}`, `db-all;dur=${db.toFixed(1)};desc="${this.entries.filter((e) => e.name === "db").length} queries"`, ...parts].join(", ");
  }

  // The same pool, timing every query and every connection it opens.
  wrap(pool: Pool): Pool {
    const trace = this;
    const timedQuery = (target: { query: (...args: any[]) => any }) => {
      const query = target.query.bind(target);
      return (...args: any[]) => {
        const text = typeof args[0] === "string" ? args[0] : (args[0]?.text ?? "");
        const at = performance.now();
        const done = () => trace.add("db", performance.now() - at, summarize(text));
        const result = query(...args);
        if (result && typeof result.then === "function") return result.finally(done);
        done();
        return result;
      };
    };
    return new Proxy(pool, {
      get(target, key) {
        if (key === "query") return timedQuery(target);
        if (key === "connect") {
          const connect = target.connect.bind(target);
          return async (...args: unknown[]) => {
            if (args.length > 0) return (connect as (...a: unknown[]) => unknown)(...args);
            const client = (await trace.time("connect", "pool.connect", () => connect())) as PoolClient;
            return new Proxy(client, { get: (c, k) => (k === "query" ? timedQuery(c) : Reflect.get(c, k)) });
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
}

// A query's shape without its values: the verb and the tables it names.
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const verb = flat.split(" ", 1)[0]?.toLowerCase() ?? "";
  const tables = [...new Set([...flat.matchAll(/\b(?:from|join|into|update)\s+"?([a-z_][a-z0-9_]*)"?/gi)].map((m) => m[1]!))];
  return `${verb} ${tables.join(",")}`.trim();
}

export async function withTiming(response: Response, trace: Trace | undefined): Promise<Response> {
  if (!trace || response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.append("server-timing", trace.header());
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
