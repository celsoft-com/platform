import { describe, expect, it } from "vitest";
import { conditional } from "./conditional.js";

const read = (headers: Record<string, string> = {}, method = "GET") => new Request("https://x/api/notes", { method, headers });
const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

describe("conditional reads", () => {
  it("tags a JSON read and keeps it private, asked again every time", async () => {
    const response = await conditional(read(), json({ a: 1 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toMatch(/^W\/"[\w-]{22}"$/);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(await response.json()).toEqual({ a: 1 });
  });

  it("answers 304 with no body when the body has not changed, and 200 when it has", async () => {
    const tag = (await conditional(read(), json({ a: 1 }))).headers.get("etag")!;
    const same = await conditional(read({ "if-none-match": tag }), json({ a: 1 }));
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    expect(same.headers.get("etag")).toBe(tag);
    const changed = await conditional(read({ "if-none-match": tag }), json({ a: 2 }));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(tag);
  });

  it("leaves writes, errors, other types, no-store, set-cookie and the app's own tags alone", async () => {
    const untouched = [
      await conditional(read({}, "POST"), json({ a: 1 })),
      await conditional(read(), new Response("{}", { status: 404, headers: { "content-type": "application/json" } })),
      await conditional(read(), new Response("<p>hi</p>", { headers: { "content-type": "text/html" } })),
      await conditional(read(), json({ a: 1 }, { "cache-control": "no-store" })),
      await conditional(read(), json({ a: 1 }, { "set-cookie": "a=1" })),
    ];
    for (const response of untouched) expect(response.headers.get("etag")).toBeNull();
    expect((await conditional(read({ "if-none-match": '"mine"' }), json({ a: 1 }, { etag: '"mine"' }))).status).toBe(200);
  });
});
