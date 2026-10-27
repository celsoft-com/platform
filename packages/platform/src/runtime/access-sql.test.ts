import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { freshDatabase, world } from "../../test/database.js";
import { prepareAccess } from "./access-sql.js";

// The stored chains: rows H1 onward of docs/access-rules.md.

const { db, pool } = await freshDatabase();
const w = world(db, pool);
const uid = () => randomUUID();

const chainOf = async (point: string) =>
  (await w.query(`select ancestor_id, depth from access_ancestor where point_id = $1 order by depth`, [point])).rows.map((r) => `${r.depth}:${r.ancestor_id}`);

describe("Stored chains", () => {
  it("H1: points made before the triggers existed get their chains, and preparing again changes nothing", async () => {
    await w.query(`drop trigger platform_access_point_changed on access_point`);
    const [a, b, c, d] = [`a-${uid()}`, `b-${uid()}`, `c-${uid()}`, `d-${uid()}`];
    await w.query(`insert into access_point (id) values ($1)`, [a]);
    await w.query(`insert into access_point (id, parent_id, inherits) values ($1, $2, true)`, [b, a]);
    await w.query(`insert into access_point (id, parent_id, inherits) values ($1, $2, false)`, [c, b]);
    await w.query(`insert into access_point (id, parent_id, inherits) values ($1, $2, true)`, [d, c]);
    expect(await chainOf(d)).toEqual([]);
    await prepareAccess(db);
    expect(await chainOf(a)).toEqual([`0:${a}`]);
    expect(await chainOf(b)).toEqual([`0:${b}`, `1:${a}`]);
    expect(await chainOf(c)).toEqual([`0:${c}`]);
    expect(await chainOf(d)).toEqual([`0:${d}`, `1:${c}`]);
    const before = (await w.query(`select count(*)::int as n from access_ancestor`)).rows[0].n;
    await prepareAccess(db);
    expect((await w.query(`select count(*)::int as n from access_ancestor`)).rows[0].n).toBe(before);
  });

  it("H2: a move or an inheritance change rewrites the chains of every point below it", async () => {
    const [a, b, c, d] = [`a-${uid()}`, `b-${uid()}`, `c-${uid()}`, `d-${uid()}`];
    await w.query(`insert into access_point (id) values ($1), ($2)`, [a, d]);
    await w.query(`insert into access_point (id, parent_id, inherits) values ($1, $2, true)`, [b, a]);
    await w.query(`insert into access_point (id, parent_id, inherits) values ($1, $2, true)`, [c, b]);
    expect(await chainOf(c)).toEqual([`0:${c}`, `1:${b}`, `2:${a}`]);
    await w.query(`update access_point set parent_id = $2 where id = $1`, [b, d]);
    expect(await chainOf(c)).toEqual([`0:${c}`, `1:${b}`, `2:${d}`]);
    await w.query(`update access_point set inherits = false where id = $1`, [b]);
    expect(await chainOf(c)).toEqual([`0:${c}`, `1:${b}`]);
    await w.query(`update access_point set inherits = true where id = $1`, [b]);
    expect(await chainOf(c)).toEqual([`0:${c}`, `1:${b}`, `2:${d}`]);
  });

  it("H3: removing a point removes its chains and every chain through it", async () => {
    const [a, b] = [`a-${uid()}`, `b-${uid()}`];
    await w.query(`insert into access_point (id) values ($1)`, [a]);
    await w.query(`insert into access_point (id, parent_id, inherits) values ($1, $2, true)`, [b, a]);
    await w.query(`delete from access_point where id = $1`, [a]);
    expect((await w.query(`select count(*)::int as n from access_ancestor where point_id in ($1, $2) or ancestor_id in ($1, $2)`, [a, b])).rows[0].n).toBe(0);
  });

  it("H4: a chain stops at 64 points, as the walk it replaces did", async () => {
    let parent: string | null = null;
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) {
      const id = `deep${i}-${uid()}`;
      await w.query(`insert into access_point (id, parent_id, inherits) values ($1, $2, $3)`, [id, parent, parent !== null]);
      ids.push(id);
      parent = id;
    }
    const chain = await chainOf(ids.at(-1)!);
    expect(chain).toHaveLength(64);
    expect(chain.at(-1)).toBe(`63:${ids[ids.length - 64]}`);
  });
});
