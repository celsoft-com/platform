import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { freshDatabase, world } from "../../test/database.js";
import { organizationPoint, teamPoint, type Level } from "./access.js";
import { EndpointError } from "./endpoint-error.js";

// Someone trying to get more than they were given: rows X1 onward of docs/access-rules.md. Each
// test plays the attacker against the platform's own calls, then checks nothing moved.

const { db, pool } = await freshDatabase();
const w = world(db, pool);
const uid = () => randomUUID();

const refused = async (work: Promise<unknown>, status = 404) => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error, "expected a refusal").toBeInstanceOf(EndpointError);
  expect((error as EndpointError).status).toBe(status);
};
const count = async (table: string, where: string, values: unknown[]) => Number((await w.query(`select count(*) from ${table} where ${where}`, values)).rows[0].count);

async function victim() {
  const owner = await w.user();
  const page = `page-${uid()}`;
  await w.as(owner).create(page);
  return { owner, page, as: w.as(owner) };
}

async function company() {
  const admin = await w.user();
  const { id: org, admins } = await w.org(admin);
  const [member, teammate] = [await w.user(), await w.user()];
  await w.member(org, member);
  await w.member(org, teammate);
  const team = await w.team(org, admin);
  await w.join(team, teammate);
  const doc = `doc-${uid()}`;
  await w.as(admin).create(doc, { parent: teamPoint(team), inherit: true });
  return { org, admins, admin, member, teammate, team, doc };
}

describe("Attacks", () => {
  it("X1: SQL in an email grant is just an address that matches nobody else", async () => {
    const { as, page } = await victim();
    const attacker = await w.user();
    for (const email of [`x' or '1'='1@example.com`, `x"; delete from access_grant; --@example.com`, `%@example.com`, `_@example.com`]) {
      await as.grant(page, { email }, "write");
    }
    expect(await w.as(attacker).level(page)).toBe(null);
    expect(await count("access_grant", "point_id = $1", [page])).toBe(5);
  });

  it("X2: a caller id that is not a UUID is nobody, never an error or a match", async () => {
    const { as, page } = await victim();
    await as.grant(page, { everyone: true }, "read");
    for (const id of ["not-a-uuid", `' or 1=1 --`, "", "00000000-0000-0000-0000-000000000000"]) {
      expect(await w.as(id).level(page)).toBe("read");
      await refused(w.as(id).require(page, "write"));
    }
  });

  it("X3: a member cannot add points under the organization's point, which grants read", async () => {
    const c = await company();
    await refused(w.as(c.member).create(`mine-${uid()}`, { parent: organizationPoint(c.org) }));
    await refused(w.as(c.member).create(`mine-${uid()}`, { parent: teamPoint(c.team) }));
  });

  it("X4: creating a point with an existing id takes nothing over", async () => {
    const { owner, page } = await victim();
    const attacker = await w.user();
    await refused(w.as(attacker).create(page, { grants: [{ to: { user: attacker }, level: "manage" }] }), 409);
    expect(await w.as(attacker).level(page)).toBe(null);
    expect(await w.as(owner).level(page)).toBe("manage");
  });

  it("X5: two people creating the same id at once: one wins, the other gets nothing", async () => {
    const id = `race-${uid()}`;
    const [a, b] = [await w.user(), await w.user()];
    const results = await Promise.allSettled([w.as(a).create(id), w.as(b).create(id)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await count("access_grant", "point_id = $1", [id])).toBe(1);
  });

  it("X6: Everyone can never carry more than read, even written straight into the table", async () => {
    const { page } = await victim();
    await expect(w.query(`insert into access_grant (point_id, everyone, level) values ($1, true, 3)`, [page])).rejects.toThrow(/access_grant_everyone/);
    await w.query(`insert into access_grant (point_id, everyone, level) values ($1, true, 1)`, [page]);
    await expect(w.query(`update access_grant set level = 5 where point_id = $1 and everyone`, [page])).rejects.toThrow(/access_grant_everyone/);
    await expect(w.query(`insert into access_grant (point_id, everyone, level) values ($1, false, 1)`, [page])).rejects.toThrow();
  });

  it("X7: managing a child gives nothing on its parent", async () => {
    const { as, page } = await victim();
    const child = `child-${uid()}`;
    await as.create(child, { parent: page, inherit: true });
    const attacker = await w.user();
    await as.grant(child, { user: attacker }, "manage");
    await refused(w.as(attacker).grant(page, { user: attacker }, "read"));
    await refused(w.as(attacker).move(child, null).then(() => w.as(attacker).create(`x-${uid()}`, { parent: page })));
    expect(await w.as(attacker).level(page)).toBe(null);
  });

  it("X8: someone else's point cannot be moved under a place the attacker controls", async () => {
    const { page, owner } = await victim();
    const attacker = await w.user();
    const trap = `trap-${uid()}`;
    await w.as(attacker).create(trap);
    await refused(w.as(attacker).move(page, trap));
    expect((await w.query(`select parent_id from access_point where id = $1`, [page])).rows[0].parent_id).toBe(null);
    expect(await w.as(owner).level(page)).toBe("manage");
  });

  it("X9: an attacker's own point moved under someone else's needs create there", async () => {
    const { page } = await victim();
    const attacker = await w.user();
    const mine = `mine-${uid()}`;
    await w.as(attacker).create(mine);
    await refused(w.as(attacker).move(mine, page));
  });

  it("X10: a member cannot join the Admins team, add themselves to teams, or create teams", async () => {
    const c = await company();
    const orgs = w.orgs(c.member);
    await refused(orgs.addToTeam(c.admins, c.member));
    await refused(orgs.addToTeam(c.team, c.member));
    await refused(orgs.createTeam(c.org, "Mine"));
    await refused(orgs.invite(c.org, "friend@example.com"));
    expect(await w.as(c.member).level(c.doc)).toBe(null);
  });

  it("X11: a team member with write on the team point cannot grant or re-parent it", async () => {
    const c = await company();
    const as = w.as(c.teammate);
    await refused(as.grant(teamPoint(c.team), { user: c.member }, "read"));
    await refused(as.inherit(teamPoint(c.team), true));
    await refused(w.orgs(c.teammate).addToTeam(c.team, c.member));
    await refused(as.move(teamPoint(c.team), null));
  });

  it("X12: platform ids cannot be squatted by apps, with any letters or case trick", async () => {
    const attacker = w.as(await w.user());
    const org = uid();
    await expect(attacker.create(`organization:${org}`)).rejects.toThrow(/platform/);
    await expect(attacker.create(`team:${org}`)).rejects.toThrow(/platform/);
    // Other spellings are just ordinary ids, and the database refuses any id posing as the platform's.
    await attacker.create(`Organization:${org}`);
    await expect(w.query(`insert into access_point (id) values ($1)`, [`organization:${uid()}`])).rejects.toThrow(/access_point_organization_id/);
    await expect(w.query(`insert into access_point (id) values ($1)`, [`team:${uid()}`])).rejects.toThrow(/access_point_team_id/);
  });

  it("X13: an invitation sent to someone else cannot be accepted by guessing its id", async () => {
    const c = await company();
    const { id } = await w.orgs(c.admin).invite(c.org, `${uid()}@example.com`);
    const attacker = await w.user();
    await refused(w.orgs(attacker).accept(id));
    await refused(w.orgs(attacker).requireMember(c.org));
  });

  it("X14: one organization's admin cannot reach another organization through its ids", async () => {
    const a = await company();
    const b = await company();
    const orgs = w.orgs(a.admin);
    await refused(orgs.removeMember(b.org, b.member));
    await refused(orgs.addToTeam(b.team, a.member));
    await refused(orgs.renameTeam(b.team, "Mine"));
    await refused(orgs.removeTeam(b.team));
    await refused(orgs.invite(b.org, "x@example.com"));
    await refused(w.as(a.admin).grant(b.doc, { user: a.admin }, "read"));
    await refused(w.as(a.admin).create(`x-${uid()}`, { parent: b.doc }));
  });

  it("X15: a link token never works on a point recreated with the same id", async () => {
    const { as, page } = await victim();
    const { token } = await as.link(page, "write");
    await as.remove(page);
    const attacker = await w.user();
    await w.as(attacker).create(page);
    expect(await w.as(null, token).level(page)).toBe(null);
    expect(await w.as(attacker).level(page)).toBe("manage");
  });

  it("X16: a link holder cannot use the link to change grants or make more links", async () => {
    const { as, page } = await victim();
    const { token } = await as.link(page, "write");
    const holder = await w.user();
    await refused(w.as(holder, token).grant(page, { user: holder }, "manage"));
    await refused(w.as(holder, token).link(page, "read"));
    await refused(w.as(holder, token).remove(page));
  });

  it("X17: a signed-out link holder with create cannot create points", async () => {
    const { as, page } = await victim();
    const { token } = await as.link(page, "create");
    await refused(w.as(null, token).create(`child-${uid()}`, { parent: page }), 401);
  });

  it("X18: a list filter never shows more than single checks, whatever the app calls its tables", async () => {
    const c = await company();
    await w.query(`create table if not exists _ac_chain_rows (id text primary key)`);
    await w.query(`insert into _ac_chain_rows (id) values ($1), ($2)`, [c.doc, `nothing-${uid()}`]);
    const filter = await w.as(c.member).readable(sql`p.id`);
    const shown = (await db.execute(sql`select p.id from _ac_chain_rows p where ${filter}`)).rows;
    expect(shown).toEqual([]);
    const teammate = await w.as(c.teammate).readable(sql`p.id`);
    expect((await db.execute(sql`select p.id from _ac_chain_rows p where ${teammate}`)).rows).toEqual([{ id: c.doc }]);
  });

  it("X19: lowering a whole organization on one point never lowers its teams", async () => {
    const c = await company();
    await w.as(c.admin).grant(c.doc, { organization: c.org }, "read");
    expect(await w.as(c.teammate).level(c.doc)).toBe("write");
  });

  it("X20: an unconfirmed account cannot claim an email grant by signing up with the address", async () => {
    const { as, page } = await victim();
    const address = `${uid()}@example.com`;
    await as.grant(page, { email: address }, "manage");
    const squatter = await w.user({ email: address.toUpperCase(), verified: false });
    expect(await w.as(squatter).level(page)).toBe(null);
    await refused(w.as(squatter).grant(page, { user: squatter }, "read"));
  });

  it("X21: every refusal looks the same, whether the point exists or not", async () => {
    const { page } = await victim();
    const attacker = w.as(await w.user());
    const missing = `page-${uid()}`;
    const outcomes = async (id: string) =>
      Promise.all(
        [() => attacker.check(id), () => attacker.require(id, "write" as Level), () => attacker.grant(id, { everyone: true }, "read"), () => attacker.grants(id), () => attacker.link(id, "read"), () => attacker.remove(id), () => attacker.move(id, null), () => attacker.inherit(id, true)].map((f) =>
          f().then(
            () => "ok",
            (e: EndpointError) => `${e.status} ${e.message}`,
          ),
        ),
      );
    expect(await outcomes(page)).toEqual(await outcomes(missing));
  });

  it("X22: a manager cannot use a point under one organization to reach another's members", async () => {
    const a = await company();
    const b = await company();
    await refused(w.as(a.admin).grant(a.doc, { organization: b.org }, "manage"), 409);
    await refused(w.as(a.admin).grant(a.doc, { team: b.admins }, "manage"), 409);
    expect(await w.as(b.admin).level(a.doc)).toBe(null);
  });
});
