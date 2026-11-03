import { afterEach, describe, expect, it, vi } from "vitest";
import { R2S3 } from "./r2.js";

const s3 = () => new R2S3("token", async () => "acct");

afterEach(() => vi.unstubAllGlobals());

function stubFetch(answer: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.hostname === "api.cloudflare.com") return Response.json({ result: { id: "key-id" } });
    calls.push({ url, init });
    return answer(url, init);
  });
  return calls;
}

describe("R2's S3 API", () => {
  it("deletes in batches of at most 1,000 keys, escaping each, with the Content-MD5 S3 requires", async () => {
    const calls = stubFetch(() => new Response("<DeleteResult/>"));
    const keys = Array.from({ length: 2500 }, (_, i) => `a&b/${i}`);
    await s3().deleteMany("files", keys);
    expect(calls.map((c) => c.init.method)).toEqual(["POST", "POST", "POST"]);
    expect(calls[0]!.url.pathname).toBe("/files");
    expect(calls[0]!.url.search).toBe("?delete=");
    const bodies = calls.map((c) => String(c.init.body));
    expect(bodies.map((b) => b.match(/<Object>/g)!.length)).toEqual([1000, 1000, 500]);
    expect(bodies[0]).toContain("<Key>a&amp;b/0</Key>");
    expect((calls[0]!.init.headers as Record<string, string>)["content-md5"]).toMatch(/==$/);
  });

  it("sends nothing for no keys, and fails naming a key R2 could not delete", async () => {
    expect(stubFetch(() => new Response("")).length).toBe(0);
    await s3().deleteMany("files", []);
    stubFetch(() => new Response("<DeleteResult><Error><Key>x/1</Key><Code>AccessDenied</Code></Error></DeleteResult>"));
    await expect(s3().deleteMany("files", ["x/1"])).rejects.toThrow(/could not delete 1 objects from files, such as x\/1/);
  });
});
