import { describe, expect, it } from "vitest";
import { EndpointError, refusal } from "./endpoint-error.js";

describe("refusal", () => {
  it("E1: an EndpointError and a thrown Response refuse with their status and message; anything else is a bug", async () => {
    expect(await refusal(new EndpointError(409, "taken"))).toEqual({ status: 409, message: "taken" });
    expect(await refusal(Response.json({ error: "sign in first" }, { status: 401 }))).toEqual({ status: 401, message: "sign in first" });
    expect(await refusal(new Response("no", { status: 403, statusText: "Forbidden" }))).toEqual({ status: 403, message: "Forbidden" });
    expect(await refusal(new Error("boom"))).toBeUndefined();
  });
});
