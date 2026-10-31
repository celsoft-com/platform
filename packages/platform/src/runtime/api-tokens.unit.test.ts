import { describe, expect, it } from "vitest";
import { guardTokenRoutes, tokenCaller } from "./api-tokens.js";

const request = (path: string, init: RequestInit & { token?: string; ip?: string } = {}) =>
  new Request(`https://app.test${path}`, { ...init, headers: { ...(init.token && { authorization: `Bearer ${init.token}` }), "cf-connecting-ip": init.ip ?? "203.0.113.1" } });
const noDb = () => {
  throw new Error("looked up");
};
const limiter = (allow: (key: string) => boolean) => {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => (keys.push(key), { success: allow(key) }) };
};

describe("API tokens, without a database", () => {
  it("K1: no token, tokens off, or a path tokens never reach is no caller", async () => {
    expect(await tokenCaller(request("/api/x"), noDb, undefined, { tokens: true, onPage: false })).toBeNull();
    expect(await tokenCaller(request("/api/x", { token: "t" }), noDb, undefined, { tokens: false, onPage: false })).toBeNull();
    expect(await tokenCaller(request("/api/auth/x", { token: "t" }), noDb, undefined, { tokens: true, onPage: false })).toBeNull();
    expect(await tokenCaller(request("/page", { token: "t" }), noDb, undefined, { tokens: true, onPage: false })).toBeNull();
  });

  it("K2: a token over its allowance is a 429 before it is looked up", async () => {
    const limited = limiter((key) => !key.startsWith("token "));
    const answer = await tokenCaller(request("/api/x", { token: "t" }), noDb, limited, { tokens: true, onPage: false });
    expect((answer as Response).status).toBe(429);
    expect(limited.keys).toHaveLength(1);
  });

  it("K3: token routes outside the tokens screen's calls, or with an id that is no UUID, are 404s", async () => {
    expect(await guardTokenRoutes(request("/api/auth/session"), "/api/auth/session", true)).toBeUndefined();
    expect(((await guardTokenRoutes(request("/api/auth/api-key/update"), "/api/auth/api-key/update", true)) as Response).status).toBe(404);
    expect(((await guardTokenRoutes(request("/api/auth/api-key/list"), "/api/auth/api-key/list", false)) as Response).status).toBe(404);
    expect(((await guardTokenRoutes(request("/api/auth/api-key/get?id=x"), "/api/auth/api-key/get", true)) as Response).status).toBe(404);
    const list = request("/api/auth/api-key/list");
    expect(await guardTokenRoutes(list, "/api/auth/api-key/list", true)).toBe(list);
  });
});
