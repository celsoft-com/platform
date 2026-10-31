import { describe, expect, it } from "vitest";
import { z } from "zod";
import { EndpointError } from "./endpoint-error.js";
import { createFiles, memoryBucket } from "./files.js";
import { defineApp, endpoint } from "./index.js";
import { checkJsonPath, jsonPath, query } from "./jsonpath.js";

const books = [
  { title: "Dune", stars: 5, tags: ["sf"] },
  { title: "Emma", stars: 4, tags: ["romance"] },
  { title: "Ubik", stars: 4, tags: ["sf"] },
  { title: "Kim", stars: "4" },
];

describe("query", () => {
  it("keeps a value's type, so 4 and '4' are different", () => {
    expect(query(books, "$[?@.stars == 4]").items.map((i) => i.value)).toEqual([books[1], books[2]]);
    expect(query(books, "$[?@.stars == '4']").items).toEqual([{ path: "$[3]", value: books[3] }]);
  });

  it("returns each match's normalized path", () => {
    expect(query({ shelf: books }, "$.shelf[?@.title == 'Ubik'].title").items).toEqual([{ path: "$['shelf'][2]['title']", value: "Ubik" }]);
  });

  it("pages matches with limit and offset, counting all of them", () => {
    expect(query(books, "$[*]", { limit: 2, offset: 1 })).toEqual({ items: [{ path: "$[1]", value: books[1] }, { path: "$[2]", value: books[2] }], total: 4 });
    expect(query(books, "$[?@.tags[0] == 'sf']", { limit: 0 })).toEqual({ items: [], total: 2 });
  });

  it("runs the RFC's functions, regexes included", () => {
    expect(query(books, "$[?length(@.title) == 3].title").items.map((i) => i.value)).toEqual(["Kim"]);
    expect(query(books, "$[?match(@.title, 'D.*')].title").items.map((i) => i.value)).toEqual(["Dune"]);
    expect(query(books, "$[?search(@.title, 'm')].title").items.map((i) => i.value)).toEqual(["Emma", "Kim"]);
  });

  it("refuses a regex pattern over 100 characters as the caller's mistake", () => {
    const error = (() => {
      try {
        query(books, `$[?match(@.title, '${"a".repeat(101)}')]`);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(EndpointError);
    expect(error).toMatchObject({ status: 400, message: expect.stringContaining("at most 100 characters") });
  });

  it("refuses a bad expression, a long one and bad paging with a 400", () => {
    expect(() => query(books, "$[?@.stars = 4]")).toThrow(EndpointError);
    expect(checkJsonPath("$[?@.stars = 4]")).toBe("unexpected '=', did you mean '=='? at 12");
    expect(() => query(books, `$.${"a".repeat(1001)}`)).toThrow("at most 1000 characters");
    expect(() => query(books, "$[*]", { limit: 1001 })).toThrow("limit is 0 to 1000");
    expect(() => query(books, "$[*]", { offset: -1 })).toThrow("offset is 0 or more");
  });
});

describe("jsonPath", () => {
  it("accepts an expression that parses and names what is wrong with one that does not", () => {
    const input = z.object({ where: jsonPath() });
    expect(input.parse({ where: "$[?@.stars == 4]" })).toEqual({ where: "$[?@.stars == 4]" });
    const result = input.safeParse({ where: "$[?@.stars = 4]" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({ path: ["where"], message: checkJsonPath("$[?@.stars = 4]") });
  });
});

describe("an endpoint taking an expression over GET", () => {
  const bucket = memoryBucket();
  const app = defineApp(undefined, {
    endpoints: {
      countBooks: endpoint(
        { method: "GET", path: "/api/public/books/count", input: z.object({ where: jsonPath() }), output: z.object({ total: z.number() }), access: "anon" },
        async ({ where }, app) => ({ total: (await app.files.query("books.json", where, { limit: 0 }))!.total }),
      ),
    },
  });
  const get = (where: string) => app.fetch(new Request(`https://app.test/api/public/books/count?where=${encodeURIComponent(where)}`), { FILES: bucket }, { waitUntil: () => {} });

  it("counts with typed values from the query string, and refuses a bad expression with where it fails", async () => {
    await createFiles({ FILES: bucket }).putJson("books.json", books);
    expect(await (await get("$[?@.stars == 4]")).json()).toEqual({ total: 2 });
    const refused = await get("$[?@.stars = 4]");
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain("did you mean '=='? at 12");
  });
});
