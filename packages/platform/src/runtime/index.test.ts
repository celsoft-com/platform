import { describe, expect, it } from "vitest";
import { defineApp, type Sql } from "./index.js";

function fakeSql() {
  const calls: string[] = [];
  const sql = Object.assign(async () => calls.push("query"), { end: async () => void calls.push("end") }) as unknown as Sql;
  return { sql, calls };
}

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) }, settle: () => Promise.all(pending) };
}

const env = { DB: { connectionString: "postgres://db" } };

describe("defineApp", () => {
  it("opens the database only when used and closes it after the response", async () => {
    const { sql, calls } = fakeSql();
    const { ctx, settle } = fakeCtx();
    const app = defineApp(async (_req, { sql }) => {
      await (sql as unknown as () => Promise<void>)();
      return new Response("ok");
    }, { connect: () => sql });

    const response = await app.fetch(new Request("https://x/"), env, ctx);
    await settle();

    expect(await response.text()).toBe("ok");
    expect(calls).toEqual(["query", "end"]);
  });

  it("never connects when the handler skips the database", async () => {
    let connects = 0;
    const { ctx } = fakeCtx();
    const app = defineApp(() => new Response("ok"), { connect: () => (connects++, fakeSql().sql) });

    await app.fetch(new Request("https://x/"), env, ctx);
    expect(connects).toBe(0);
  });

  it("still closes the database when the handler throws", async () => {
    const { sql, calls } = fakeSql();
    const { ctx, settle } = fakeCtx();
    const app = defineApp((_req, app) => {
      void app.sql;
      throw new Error("boom");
    }, { connect: () => sql });

    await expect(app.fetch(new Request("https://x/"), env, ctx)).rejects.toThrow("boom");
    await settle();
    expect(calls).toEqual(["end"]);
  });

  it("explains a missing database", async () => {
    const { ctx } = fakeCtx();
    const app = defineApp((_req, app) => (void app.sql, new Response()));
    await expect(app.fetch(new Request("https://x/"), {}, ctx)).rejects.toThrow(/platform\.jsonc/);
  });
});
