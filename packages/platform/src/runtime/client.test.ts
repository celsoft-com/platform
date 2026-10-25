import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCall, EndpointError } from "./client.js";
import { defineApp, endpoint } from "./index.js";

const app = defineApp(undefined, {
  endpoints: {
    getNote: endpoint(
      { method: "GET", path: "/api/public/notes/:id", input: z.object({ id: z.number(), urgent: z.boolean().default(false) }), output: z.object({ id: z.number(), urgent: z.boolean(), at: z.date() }) },
      ({ id, urgent }) => {
        if (id === 404) throw new Error("unreachable");
        return { id, urgent, at: new Date("2026-10-25T00:00:00Z") };
      },
    ),
    addNote: endpoint(
      { method: "POST", path: "/api/public/folders/:folder/notes", input: z.object({ folder: z.string(), body: z.string().min(1) }), output: z.object({ folder: z.string(), body: z.string() }) },
      (input) => input,
    ),
  },
});

const seen: string[] = [];
vi.stubGlobal("fetch", async (request: Request) => {
  seen.push(`${request.method} ${new URL(request.url).pathname}${new URL(request.url).search}`);
  return app.fetch(new Request(request, { headers: { ...Object.fromEntries(request.headers), origin: "https://app.test" } }), {}, { waitUntil: () => {} });
});
afterEach(() => void (seen.length = 0));

const call = createCall<typeof app>({ getNote: ["GET", "/api/public/notes/{id}"], addNote: ["POST", "/api/public/folders/{folder}/notes"] }, { url: "https://app.test" });

describe("call", () => {
  it("calls an endpoint by name over its REST path", async () => {
    expect(await call("getNote", { id: 7, urgent: true })).toEqual({ id: 7, urgent: true, at: "2026-10-25T00:00:00.000Z" });
    expect(await call("addNote", { folder: "work", body: "hi" })).toEqual({ folder: "work", body: "hi" });
    expect(seen).toEqual(["GET /api/public/notes/7?urgent=true", "POST /api/public/folders/work/notes"]);
  });

  it("throws EndpointError with the server's status and message", async () => {
    await expect(call("addNote", { folder: "work", body: "" })).rejects.toMatchObject({ status: 400, name: "EndpointError" });
    await expect(call("addNote", { folder: "work", body: "" })).rejects.toBeInstanceOf(EndpointError);
  });
});
