import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { endpoint, runEndpoint, withInvalidates } from "./endpoints.js";

const spyCache = () => ({ clear: vi.fn(async () => {}), invalidate: vi.fn(async (_path: string) => {}) });
const io = { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }), access: "anon" as const };

describe("Endpoints: invalidates", () => {
  it("I1: after a successful handler, \"all\" clears, and a list or a function of the input and output invalidates each path once", async () => {
    const cache = spyCache();
    await runEndpoint(endpoint({ ...io, invalidates: "all" }, () => ({ ok: true })), { id: "a" }, { cache });
    expect(cache.clear).toHaveBeenCalledTimes(1);
    await runEndpoint(endpoint({ ...io, invalidates: ["/stats", "/stats"] }, () => ({ ok: true })), { id: "a" }, { cache });
    await runEndpoint(endpoint({ ...io, invalidates: async (input, output) => [`/print/${input.id}`, `/ok/${output.ok}`] }, () => ({ ok: false })), { id: "b" }, { cache });
    expect(cache.invalidate.mock.calls.map(([path]) => path)).toEqual(["/stats", "/print/b", "/ok/false"]);
  });

  it("I2: a failed handler empties nothing, and a failed emptying still answers", async () => {
    const cache = spyCache();
    await expect(runEndpoint(endpoint({ ...io, invalidates: "all" }, () => { throw new Error("boom"); }), { id: "a" }, { cache })).rejects.toThrow("boom");
    expect(cache.clear).not.toHaveBeenCalled();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    cache.clear.mockRejectedValueOnce(new Error("db down"));
    expect(await runEndpoint(endpoint({ ...io, invalidates: "all" }, () => ({ ok: true })), { id: "a" }, { cache })).toEqual({ ok: true });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("I3: the app's invalidates reaches every endpoint but a GET and one that sets its own", () => {
    const own = ["/own"];
    const resolved = withInvalidates({ read: { method: "GET" as const }, write: { method: "POST" as const }, tool: {}, mine: { method: "PUT" as const, invalidates: own } }, "all");
    expect(resolved.read.invalidates).toBeUndefined();
    expect(resolved.write.invalidates).toBe("all");
    expect(resolved.tool.invalidates).toBe("all");
    expect(resolved.mine.invalidates).toBe(own);
  });

  it("I4: invalidates is \"all\", a list of paths or a function", () => {
    expect(() => endpoint({ ...io, invalidates: "some" as "all" }, () => ({ ok: true }))).toThrow(/invalidates is "all"/);
    expect(() => withInvalidates({}, [1] as unknown as string[])).toThrow(/the app's invalidates/);
  });
});
