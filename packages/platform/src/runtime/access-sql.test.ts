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

  it("H5: a point made under a point whose inheritance is changing gets the chain the change leaves", async () => {
    const owner = w.as(await w.user());
    const [a, b, c, d] = [`a-${uid()}`, `b-${uid()}`, `c-${uid()}`, `d-${uid()}`];
    await owner.create(a);
    await owner.create(b, { parent: a, inherit: true });
    await owner.create(c, { parent: b, inherit: true });
    let made: Promise<void> | undefined;
    await db.transaction(async (tx) => {
      await owner.in(tx).inherit(b, false);
      made = owner.create(d, { parent: c, inherit: true });
      await new Promise((r) => setTimeout(r, 300));
    });
    await made;
    expect(await chainOf(d)).toEqual([`0:${d}`, `1:${c}`, `2:${b}`]);
  });

  it("H6: many tree changes at once leave every stored chain matching a fresh walk of the tree", async () => {
    const owner = w.as(await w.user());
    const ids = Array.from({ length: 12 }, (_, i) => `c${i}-${uid()}`);
    for (const [i, id] of ids.entries()) await owner.create(id, i === 0 ? {} : { parent: ids[Math.floor((i - 1) / 2)], inherit: true });
    const pick = () => ids[Math.floor(Math.random() * ids.length)]!;
    const changes = Array.from({ length: 60 }, (_, i) => {
      switch (i % 4) {
        case 0: return owner.move(pick(), Math.random() < 0.2 ? null : pick());
        case 1: return owner.inherit(pick(), Math.random() < 0.5);
        case 2: return owner.create(`n${i}-${uid()}`, { parent: pick(), inherit: true });
        default: return Math.random() < 0.2 ? owner.remove(pick()) : owner.inherit(pick(), true);
      }
    });
    await Promise.allSettled(changes);
    const stored = (await w.query(`select point_id, ancestor_id, depth from access_ancestor order by 1, 3`)).rows;
    const walked = (
      await w.query(`
        with recursive chains as (
          select id as point_id, id as ancestor_id, parent_id, inherits, 0 as depth from access_point
          union all
          select c.point_id, q.id, q.parent_id, q.inherits, c.depth + 1 from chains c join access_point q on q.id = c.parent_id
          where c.inherits and c.depth < 63
        )
        select point_id, ancestor_id, depth from chains order by 1, 3`)
    ).rows;
    expect(stored).toEqual(walked);
  });
});
