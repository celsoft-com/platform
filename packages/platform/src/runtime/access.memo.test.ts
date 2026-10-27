import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import { freshDatabase, world } from "../../test/database.js";
import { createAccess } from "./access.js";

// Rows M1 onward of docs/access-rules.md: a request asks about one point's level once, and never
// trusts a remembered level after anything that could change it.

const { db, pool } = await freshDatabase();
const w = world(db, pool);
const uid = () => randomUUID();

// An Access for `user` whose database counts the level queries it runs.
function counted(user: string, memo = new Map<string, number>()) {
  let queries = 0;
  const counting = drizzle({
    client: {
      query: (...args: unknown[]) => {
        const text = typeof args[0] === "string" ? args[0] : ((args[0] as { text?: string })?.text ?? "");
        if (text.includes("_ac_target")) queries++;
        return (pool.query as (...a: unknown[]) => unknown)(...args);
      },
      connect: () => pool.connect(),
    } as never,
  });
  const access = createAccess(counting as never, async () => ({ userId: user, link: null }), { memo });
  return { access, memo, queries: () => queries };
}

describe("Remembered levels", () => {
  it("M1: repeated checks of one point in one request run one query, and agree", async () => {
    const owner = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    const { access, queries } = counted(owner);
    expect(await access.check(point)).toBe("manage");
    expect(await access.level(point)).toBe("manage");
    expect(await access.can(point, "write")).toBe(true);
    await access.require(point, "delete");
    expect(queries()).toBe(1);
  });

  it("M2: a refusal is remembered too, and stays a 404", async () => {
    const owner = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    const { access, queries } = counted(await w.user());
    for (let i = 0; i < 3; i++) await expect(access.check(point)).rejects.toMatchObject({ status: 404 });
    expect(queries()).toBe(1);
  });

  it("M3: a grant, revoke, link or inherit in the request forgets what was remembered", async () => {
    const owner = await w.user();
    const reader = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    const memo = new Map<string, number>();
    const asOwner = counted(owner, memo).access;
    const asReader = counted(reader, memo);
    await expect(asReader.access.check(point)).rejects.toMatchObject({ status: 404 });
    memo.clear();
    await asOwner.grant(point, { user: reader }, "write");
    expect(memo.size).toBe(0);
    expect(await asReader.access.check(point)).toBe("write");
  });

  it("M4: the caller's own write clears the memory, so a revoked level is never reused", async () => {
    const owner = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    const { access, queries } = counted(owner);
    expect(await access.check(point)).toBe("manage");
    const other = await w.user();
    await access.grant(point, { user: other }, "read");
    await access.revoke(point, { user: other });
    await access.check(point);
    expect(queries()).toBeGreaterThan(1);
  });

  it("M5: inside a transaction, every check asks the database", async () => {
    const owner = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    const { access, queries } = counted(owner);
    await access.check(point);
    await db.transaction(async (tx) => {
      await access.in(tx).check(point);
      await access.in(tx).check(point);
    });
    expect(queries()).toBe(1);
  });

  it("M6: removing a point forgets its level, so it is a 404 at once", async () => {
    const owner = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    const { access } = counted(owner);
    expect(await access.check(point)).toBe("manage");
    await access.remove(point);
    await expect(access.check(point)).rejects.toMatchObject({ status: 404 });
  });

  it("M7: two requests never share what they remember", async () => {
    const owner = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    const first = counted(owner);
    await first.access.check(point);
    const second = counted(owner);
    await second.access.check(point);
    expect(second.queries()).toBe(1);
  });

  it("M8: a remembered level for one caller is never another's", async () => {
    const owner = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    await counted(owner).access.check(point);
    await expect(counted(await w.user()).access.check(point)).rejects.toMatchObject({ status: 404 });
  });

  it("M9: as the app, nothing is remembered for the caller", async () => {
    const owner = await w.user();
    const point = `m-${uid()}`;
    await w.as(owner).create(point);
    const { access, memo } = counted(await w.user());
    expect(await access.asApp().level(point)).toBe("manage");
    expect(memo.size).toBe(0);
    await expect(access.check(point)).rejects.toMatchObject({ status: 404 });
  });
});
