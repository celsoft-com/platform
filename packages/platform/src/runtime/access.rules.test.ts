import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase, world } from "../../test/database.js";
import { applyStaticPoints, MAX_DEPTH, organizationPoint, shareMessage, teamPoint, type Level, type ShareNotice } from "./access.js";
import { EndpointError } from "./endpoint-error.js";

// One test per row of docs/access-rules.md, named by its row, then the stranger cases around them.
// Organizations, endpoints and attacks have files of their own.

const { db, pool } = await freshDatabase();
const w = world(db, pool);
const uid = () => randomUUID();

const refused = async (work: Promise<unknown>, status = 404) => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error, "expected a refusal").toBeInstanceOf(EndpointError);
  expect((error as EndpointError).status).toBe(status);
};
const appError = async (work: Promise<unknown>, message?: RegExp) => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error, "expected an error in the app's code").toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(EndpointError);
  if (message) expect((error as Error).message).toMatch(message);
};
const count = async (table: string, where: string, values: unknown[]) => Number((await w.query(`select count(*) from ${table} where ${where}`, values)).rows[0].count);
const pointOf = async (id: string) => (await w.query(`select * from access_point where id = $1`, [id])).rows[0] ?? null;

// A person's own folder holding a page that inherits from it.
async function personal() {
  const owner = await w.user();
  const as = w.as(owner);
  const folder = `folder-${uid()}`;
  const page = `page-${uid()}`;
  await as.create(folder);
  await as.create(page, { parent: folder, inherit: true });
  return { owner, folder, page, as };
}

// An organization with its creator as admin, a plain member, a team with one member, an
// outsider, and a team folder under the team's point holding a page.
async function company() {
  const admin = await w.user();
  const { id: org, admins } = await w.org(admin);
  const [member, teammate, outsider] = [await w.user(), await w.user(), await w.user()];
  await w.member(org, member);
  await w.member(org, teammate);
  const team = await w.team(org, admin);
  await w.join(team, teammate);
  const folder = `folder-${uid()}`;
  const page = `page-${uid()}`;
  await w.as(admin).create(folder, { parent: teamPoint(team), inherit: true });
  await w.as(admin).create(page, { parent: folder, inherit: true });
  return { org, admins, admin, member, teammate, outsider, team, folder, page };
}

describe("Levels", () => {
  it("L1: asked for read, has read: allowed", async () => {
    const { as, page } = await personal();
    const reader = await w.user();
    await as.grant(page, { user: reader }, "read");
    expect(await w.as(reader).can(page, "read")).toBe(true);
    expect(await w.as(reader).check(page)).toBe("read");
  });

  it("L2: asked for write, has read: refused as 404", async () => {
    const { as, page } = await personal();
    const reader = await w.user();
    await as.grant(page, { user: reader }, "read");
    expect(await w.as(reader).can(page, "write")).toBe(false);
    await refused(w.as(reader).require(page, "write"));
  });

  it("L3: has manage: every level is included", async () => {
    const { as, page } = await personal();
    for (const level of ["read", "create", "write", "delete", "manage"] as Level[]) expect(await as.can(page, level)).toBe(true);
    expect(await as.require(page, "read")).toBe("manage");
  });

  it("L4: no level at all: level is null, check is 404", async () => {
    const { page } = await personal();
    const stranger = w.as(await w.user());
    expect(await stranger.level(page)).toBe(null);
    await refused(stranger.check(page));
  });

  it("L5: an unknown level name is an error in the app's code, never allowed", async () => {
    const { as, page } = await personal();
    await appError(as.can(page, "admin" as Level));
    await appError(as.require(page, "" as Level));
    await appError(as.grant(page, { user: await w.user() }, "owner" as Level));
  });

  it("L6: a point that does not exist answers exactly like one the caller cannot see", async () => {
    const { page } = await personal();
    const stranger = w.as(await w.user());
    const missing = await stranger.check(`page-${uid()}`).catch((e: EndpointError) => [e.status, e.message]);
    const hidden = await stranger.check(page).catch((e: EndpointError) => [e.status, e.message]);
    expect(missing).toEqual(hidden);
    expect(await stranger.level(`page-${uid()}`)).toBe(null);
  });

  it("signed out with no link: nothing, even on a point that exists", async () => {
    const { page } = await personal();
    expect(await w.as(null).level(page)).toBe(null);
  });
});

describe("Points", () => {
  it("P1: whoever creates a point gets manage on it", async () => {
    const owner = await w.user();
    const id = `note-${uid()}`;
    await w.as(owner).create(id);
    expect(await w.as(owner).level(id)).toBe("manage");
    expect(await w.as(owner).grants(id)).toEqual([{ to: { user: owner }, level: "manage", grantedBy: owner }]);
  });

  it("P2: creating needs a signed-in user", async () => {
    await refused(w.as(null).create(`note-${uid()}`), 401);
    await refused(w.as("not-a-uuid").create(`note-${uid()}`), 401);
  });

  it("P3: creating under a parent needs create on it; less is a 404 and nothing is made", async () => {
    const { as, folder } = await personal();
    const [writer, reader] = [await w.user(), await w.user()];
    await as.grant(folder, { user: reader }, "read");
    await as.grant(folder, { user: writer }, "create");
    const refusedId = `page-${uid()}`;
    await refused(w.as(reader).create(refusedId, { parent: folder }));
    expect(await pointOf(refusedId)).toBe(null);
    const made = `page-${uid()}`;
    await w.as(writer).create(made, { parent: folder });
    expect((await pointOf(made)).parent_id).toBe(folder);
  });

  it("P4: a parent that does not exist is a 404", async () => {
    const owner = await w.user();
    await refused(w.as(owner).create(`page-${uid()}`, { parent: `folder-${uid()}` }));
  });

  it("P5: an id already in use is a 409, and the existing point is untouched", async () => {
    const { as, page, owner } = await personal();
    const other = await w.user();
    await refused(w.as(other).create(page), 409);
    expect(await as.grants(page)).toEqual([{ to: { user: owner }, level: "manage", grantedBy: owner }]);
    expect(await w.as(other).level(page)).toBe(null);
  });

  it("P6: ids starting organization: or team: belong to the platform", async () => {
    const owner = await w.user();
    await appError(w.as(owner).create(`organization:${uid()}`), /platform/);
    await appError(w.as(owner).create(`team:${uid()}`), /platform/);
    await w.as(owner).create(`organizations:${uid()}`);
    await w.as(owner).create(`my-team:${uid()}`);
  });

  it("P7: an id must be 1 to 200 characters", async () => {
    const owner = w.as(await w.user());
    await appError(owner.create(""));
    await appError(owner.create("x".repeat(201)));
    await appError(owner.check(""));
    await appError(owner.create(42 as unknown as string));
    await owner.create("y".repeat(200));
  });

  it("P8: initial grants are given alongside the creator's manage", async () => {
    const owner = await w.user();
    const reader = await w.user();
    const id = `note-${uid()}`;
    await w.as(owner).create(id, { grants: [{ to: { user: reader }, level: "write" }, { to: { everyone: true }, level: "read" }] });
    expect(await w.as(reader).level(id)).toBe("write");
    expect(await w.as(null).level(id)).toBe("read");
    expect(await w.as(owner).level(id)).toBe("manage");
  });

  it("P8: a bad initial grant creates nothing", async () => {
    const owner = await w.user();
    const id = `note-${uid()}`;
    await refused(w.as(owner).create(id, { grants: [{ to: { user: uid() }, level: "read" }] }));
    expect(await pointOf(id)).toBe(null);
    await appError(w.as(owner).create(id, { grants: [{ to: { everyone: true }, level: "write" }] }));
    expect(await pointOf(id)).toBe(null);
  });

  it("P9: a point takes its parent's organization; a personal one has none", async () => {
    const c = await company();
    const { page } = await personal();
    expect((await pointOf(c.page)).organization_id).toBe(c.org);
    expect((await pointOf(page)).organization_id).toBe(null);
  });

  it(`P10: points sit at most ${MAX_DEPTH} deep`, async () => {
    const owner = w.as(await w.user());
    let parent: string | undefined;
    for (let i = 0; i < MAX_DEPTH; i++) {
      const id = `deep-${uid()}`;
      await owner.create(id, { parent, inherit: true });
      parent = id;
    }
    await refused(owner.create(`deep-${uid()}`, { parent }), 409);
    expect(await owner.level(parent!)).toBe("manage");
  });

  it("P11: the app acting as itself creates with no creator grant", async () => {
    const id = `job-${uid()}`;
    const someone = await w.user();
    await w.as(someone).asApp().create(id);
    expect(await count("access_grant", "point_id = $1", [id])).toBe(0);
    expect(await w.as(someone).level(id)).toBe(null);
    expect(await w.as(someone).asApp().level(id)).toBe("manage");
  });

  it("P12: ids with quotes, wildcards and other scripts are taken literally", async () => {
    const owner = w.as(await w.user());
    const stranger = w.as(await w.user());
    for (const id of [`'; drop table access_point; --${uid()}`, `%${uid()}`, `_${uid()}`, `日本-${uid()}`, `a\\b-${uid()}`, `null-${uid()}`]) {
      await owner.create(id);
      expect(await owner.level(id)).toBe("manage");
      expect(await stranger.level(id)).toBe(null);
    }
    expect(await count("access_point", "true", [])).toBeGreaterThan(0);
  });

  it("P12: a wildcard id never matches another point", async () => {
    const owner = w.as(await w.user());
    const stranger = w.as(await w.user());
    const id = `abc-${uid()}`;
    await owner.create(id);
    await owner.grant(id, { everyone: true }, "read");
    expect(await stranger.level("%")).toBe(null);
    expect(await stranger.level("abc-%")).toBe(null);
    expect(await stranger.level(id.replace("abc", "a_c"))).toBe(null);
  });
});

describe("Static points", () => {
  const nonce = uid();
  const settings = `settings-${nonce}`;
  const reports = `reports-${nonce}`;

  it("S1: declared points exist after the first start, with their grants", async () => {
    const boss = await w.user({ email: `boss-${nonce}@example.com` });
    await applyStaticPoints(db, {
      [settings]: { grants: [{ to: { email: `BOSS-${nonce}@example.com` }, level: "manage" }] },
      [reports]: { parent: settings, inherit: true, grants: [{ to: { everyone: true }, level: "read" }] },
    });
    expect(await w.as(boss).level(settings)).toBe("manage");
    expect(await w.as(boss).level(reports)).toBe("manage");
    expect(await w.as(null).level(reports)).toBe("read");
    expect(await w.as(null).level(settings)).toBe(null);
    expect((await pointOf(settings)).static).toBe(true);
  });

  it("S2: each start replaces their grants with the declared ones", async () => {
    const id = `static-${uid()}`;
    const [a, b] = [await w.user(), await w.user()];
    await applyStaticPoints(db, { [id]: { grants: [{ to: { user: a }, level: "write" }] } });
    await applyStaticPoints(db, { [id]: { grants: [{ to: { user: b }, level: "read" }] } });
    expect(await w.as(a).level(id)).toBe(null);
    expect(await w.as(b).level(id)).toBe("read");
    await applyStaticPoints(db, { [id]: { grants: [{ to: { user: b }, level: "read" }] } });
    expect(await count("access_grant", "point_id = $1", [id])).toBe(1);
  });

  it("S3: a static point's grants, links, inheritance and place change only in code", async () => {
    const id = `static-${uid()}`;
    const admin = await w.user();
    await applyStaticPoints(db, { [id]: { grants: [{ to: { user: admin }, level: "manage" }] } });
    const as = w.as(admin);
    await refused(as.grant(id, { user: await w.user() }, "read"), 409);
    await refused(as.revoke(id, { user: admin }), 409);
    await refused(as.inherit(id, true), 409);
    await refused(as.link(id, "read"), 409);
    await refused(as.move(id, null), 409);
    await refused(as.remove(id), 409);
    expect(await as.level(id)).toBe("manage");
    expect(await as.grants(id)).toHaveLength(1);
  });

  it("S4: a static parent must be static, with no loops and no platform prefixes", async () => {
    const [a, b] = [`static-${uid()}`, `static-${uid()}`];
    await expect(applyStaticPoints(db, { [a]: { parent: `elsewhere-${uid()}` } })).rejects.toThrow(/not a static point/);
    await expect(applyStaticPoints(db, { [a]: { parent: b }, [b]: { parent: a } })).rejects.toThrow(/under each other/);
    await expect(applyStaticPoints(db, { [a]: { parent: a } })).rejects.toThrow(/under each other/);
    await expect(applyStaticPoints(db, { [`organization:${uid()}`]: {} })).rejects.toThrow(/platform/);
    expect(await pointOf(a)).toBe(null);
  });

  it("S5: a static id already used by a runtime point is refused, and the runtime point keeps its grants", async () => {
    const { page, owner } = await personal();
    await expect(applyStaticPoints(db, { [page]: { grants: [{ to: { everyone: true }, level: "read" }] } })).rejects.toThrow(/runtime/);
    expect(await w.as(owner).level(page)).toBe("manage");
    expect(await w.as(null).level(page)).toBe(null);
  });

  it("S6: runtime points can sit under a static one with create on it", async () => {
    const id = `static-${uid()}`;
    const [writer, reader] = [await w.user(), await w.user()];
    await applyStaticPoints(db, { [id]: { grants: [{ to: { user: writer }, level: "create" }, { to: { user: reader }, level: "read" }] } });
    await refused(w.as(reader).create(`child-${uid()}`, { parent: id }));
    const child = `child-${uid()}`;
    await w.as(writer).create(child, { parent: id, inherit: true });
    expect(await w.as(reader).level(child)).toBe("read");
  });

  it("S7: Everyone is granted read only, in code too", async () => {
    await expect(applyStaticPoints(db, { [`static-${uid()}`]: { grants: [{ to: { everyone: true }, level: "write" }] } })).rejects.toThrow(/read only/);
  });

  it("S8: two Workers starting at once agree on one set of grants", async () => {
    const id = `static-${uid()}`;
    const user = await w.user();
    const points = { [id]: { grants: [{ to: { user }, level: "write" as Level }] } };
    await Promise.all(Array.from({ length: 6 }, () => applyStaticPoints(db, points)));
    expect(await count("access_grant", "point_id = $1", [id])).toBe(1);
  });

  it("S9: the app's Access waits for static points before its first check, and retries after a failure", async () => {
    const id = `static-${uid()}`;
    let calls = 0;
    const ready = async () => {
      calls++;
      if (calls === 1) throw new Error("database away");
      await applyStaticPoints(db, { [id]: { grants: [{ to: { everyone: true }, level: "read" }] } });
    };
    await expect(w.as(null, null, { ready }).level(id)).rejects.toThrow("database away");
    expect(await w.as(null, null, { ready }).level(id)).toBe("read");
  });
});

describe("Grants", () => {
  it("G1: a grant to a person gives them that level", async () => {
    const { as, page } = await personal();
    const friend = await w.user();
    await as.grant(page, { user: friend }, "write");
    expect(await w.as(friend).level(page)).toBe("write");
  });

  it("G2: a grant to a team reaches its members only", async () => {
    const c = await company();
    const id = `doc-${uid()}`;
    await w.as(c.admin).create(id, { parent: organizationPoint(c.org) });
    await w.as(c.admin).grant(id, { team: c.team }, "write");
    expect(await w.as(c.teammate).level(id)).toBe("write");
    expect(await w.as(c.member).level(id)).toBe(null);
    expect(await w.as(c.outsider).level(id)).toBe(null);
  });

  it("G3: a grant to an organization reaches every member", async () => {
    const c = await company();
    const { as, page } = await personal();
    await as.grant(page, { organization: c.org }, "read");
    for (const user of [c.admin, c.member, c.teammate]) expect(await w.as(user).level(page)).toBe("read");
    expect(await w.as(c.outsider).level(page)).toBe(null);
  });

  it("G4: a grant to an email reaches the person with that confirmed address, in any case", async () => {
    const { as, page } = await personal();
    const local = uid();
    const confirmed = await w.user({ email: `${local.toUpperCase()}@Example.com` });
    await as.grant(page, { email: ` ${local}@example.COM ` }, "write");
    expect(await w.as(confirmed).level(page)).toBe("write");
    expect((await as.grants(page)).at(-1)!.to).toEqual({ email: `${local}@example.com` });
  });

  it("G4: an unconfirmed address gets nothing", async () => {
    const { as, page } = await personal();
    const address = `${uid()}@example.com`;
    const unconfirmed = await w.user({ email: address, verified: false });
    await as.grant(page, { email: address }, "write");
    expect(await w.as(unconfirmed).level(page)).toBe(null);
  });

  it("G5: an email grant applies on the next check after the address is confirmed or the person signs up", async () => {
    const { as, page } = await personal();
    const address = `${uid()}@example.com`;
    await as.grant(page, { email: address }, "read");
    const later = await w.user({ email: address, verified: false });
    expect(await w.as(later).level(page)).toBe(null);
    await w.query(`update "user" set email_verified = true where id = $1`, [later]);
    expect(await w.as(later).level(page)).toBe("read");
  });

  it("G6: Everyone reaches signed-out visitors and every person", async () => {
    const { as, page } = await personal();
    await as.grant(page, { everyone: true }, "read");
    expect(await w.as(null).level(page)).toBe("read");
    expect(await w.as(await w.user()).level(page)).toBe("read");
  });

  it("G7: Everyone is granted read only", async () => {
    const { as, page } = await personal();
    for (const level of ["create", "write", "delete", "manage"] as Level[]) await appError(as.grant(page, { everyone: true }, level), /read only/);
    await appError(as.grant(page, { everyone: false } as never, "read"));
    expect(await w.as(null).level(page)).toBe(null);
  });

  it("G8: granting needs manage; less is a 404 and nothing changes", async () => {
    const { as, page } = await personal();
    const [writer, other] = [await w.user(), await w.user()];
    await as.grant(page, { user: writer }, "delete");
    await refused(w.as(writer).grant(page, { user: other }, "read"));
    await refused(w.as(writer).grant(page, { user: writer }, "manage"));
    await refused(w.as(writer).revoke(page, { user: writer }));
    await refused(w.as(writer).grants(page));
    expect(await w.as(other).level(page)).toBe(null);
    expect(await w.as(writer).level(page)).toBe("delete");
  });

  it("G9: someone with manage can grant manage, and that person can grant too", async () => {
    const { as, page } = await personal();
    const [second, third] = [await w.user(), await w.user()];
    await as.grant(page, { user: second }, "manage");
    await w.as(second).grant(page, { user: third }, "read");
    expect(await w.as(third).level(page)).toBe("read");
  });

  it("G10: granting again changes the level, never adding a second grant", async () => {
    const { as, page } = await personal();
    const friend = await w.user();
    await as.grant(page, { user: friend }, "write");
    await as.grant(page, { user: friend }, "read");
    expect(await w.as(friend).level(page)).toBe("read");
    expect(await count("access_grant", "point_id = $1 and user_id = $2", [page, friend])).toBe(1);
  });

  it("G11: revoking removes the grant on the next check; revoking nothing is fine", async () => {
    const { as, page } = await personal();
    const friend = await w.user();
    await as.grant(page, { user: friend }, "write");
    await as.revoke(page, { user: friend });
    expect(await w.as(friend).level(page)).toBe(null);
    await as.revoke(page, { user: friend });
    await as.revoke(page, { everyone: true });
  });

  it("G11: revoking one grantee leaves the others", async () => {
    const { as, page } = await personal();
    const [a, b] = [await w.user(), await w.user()];
    await as.grant(page, { user: a }, "read");
    await as.grant(page, { user: b }, "read");
    await as.revoke(page, { user: a });
    expect(await w.as(b).level(page)).toBe("read");
  });

  it("G12: grants lists every grant, for those with manage", async () => {
    const c = await company();
    const id = `doc-${uid()}`;
    const as = w.as(c.admin);
    await as.create(id, { parent: organizationPoint(c.org) });
    await as.grant(id, { team: c.team }, "write");
    await as.grant(id, { organization: c.org }, "read");
    await as.grant(id, { email: "Someone@Example.com" }, "read");
    await as.grant(id, { everyone: true }, "read");
    expect((await as.grants(id)).map((g) => [g.to, g.level])).toEqual([
      [{ user: c.admin }, "manage"],
      [{ team: c.team }, "write"],
      [{ organization: c.org }, "read"],
      [{ email: "someone@example.com" }, "read"],
      [{ everyone: true }, "read"],
    ]);
  });

  it("G13: granting to someone or something that does not exist is a 404", async () => {
    const { as, page } = await personal();
    await refused(as.grant(page, { user: uid() }, "read"));
    await refused(as.grant(page, { team: uid() }, "read"));
    await refused(as.grant(page, { organization: uid() }, "read"));
    await refused(as.grant(page, { user: "not-a-uuid" }, "read"));
    await refused(as.revoke(page, { team: "not-a-uuid" }));
    expect(await count("access_grant", "point_id = $1", [page])).toBe(1);
  });

  it("G14: a point under an organization cannot be granted to another organization or its teams", async () => {
    const a = await company();
    const b = await company();
    const as = w.as(a.admin);
    await refused(as.grant(a.page, { organization: b.org }, "read"), 409);
    await refused(as.grant(a.page, { team: b.team }, "read"), 409);
    await refused(as.create(`doc-${uid()}`, { parent: a.folder, grants: [{ to: { team: b.team }, level: "read" }] }), 409);
    await as.grant(a.page, { user: b.teammate }, "read");
    await as.grant(a.page, { email: "guest@example.com" }, "read");
    await as.grant(a.page, { everyone: true }, "read");
    expect(await w.as(b.member).level(a.page)).toBe("read");
    expect(await w.as(b.teammate).level(a.page)).toBe("read");
  });

  it("G14: a foreign grant written into the table anyway is ignored", async () => {
    const a = await company();
    const b = await company();
    await w.query(`insert into access_grant (point_id, team_id, level) values ($1, $2, 5)`, [a.page, b.team]);
    await w.query(`insert into access_grant (point_id, organization_id, level) values ($1, $2, 5)`, [a.page, b.org]);
    expect(await w.as(b.teammate).level(a.page)).toBe(null);
    expect(await w.as(b.member).level(a.page)).toBe(null);
  });

  it("G15: a personal point can be granted to any organization or team", async () => {
    const c = await company();
    const { as, page } = await personal();
    await as.grant(page, { team: c.team }, "write");
    expect(await w.as(c.teammate).level(page)).toBe("write");
  });

  it("G16: a team row whose person left the organization gives nothing", async () => {
    const c = await company();
    await w.query(`delete from member where organization_id = $1 and user_id = $2`, [c.org, c.teammate]);
    expect(await w.as(c.teammate).level(c.page)).toBe(null);
    const { as, page } = await personal();
    await as.grant(page, { team: c.team }, "read");
    expect(await w.as(c.teammate).level(page)).toBe(null);
  });

  it("G17: someone removed from a team or organization loses that access on the next check", async () => {
    const c = await company();
    expect(await w.as(c.teammate).level(c.page)).toBe("write");
    await w.orgs(c.admin).removeFromTeam(c.team, c.teammate);
    expect(await w.as(c.teammate).level(c.page)).toBe(null);
    const { as, page } = await personal();
    await as.grant(page, { organization: c.org }, "read");
    expect(await w.as(c.member).level(page)).toBe("read");
    await w.orgs(c.admin).removeMember(c.org, c.member);
    expect(await w.as(c.member).level(page)).toBe(null);
  });

  it("G18: a grantee must name exactly one principal", async () => {
    const { as, page } = await personal();
    await appError(as.grant(page, {} as never, "read"));
    await appError(as.grant(page, { user: "", team: "" } as never, "read"));
    await appError(as.grant(page, { user: "  " }, "read"));
    await appError(as.grant(page, { group: uid() } as never, "read"));
    await appError(as.grant(page, null as never, "read"));
  });
});

describe("Sharing email", () => {
  const notices = () => {
    const sent: ShareNotice[] = [];
    return { sent, notify: vi.fn(async (n: ShareNotice) => void sent.push(n)) };
  };

  it("E1: a new grant to a person emails them, naming who shared and the level", async () => {
    const owner = await w.user();
    const { sent, notify } = notices();
    const as = w.as(owner, null, { notify });
    const id = `note-${uid()}`;
    await as.create(id);
    const address = `${uid()}@example.com`;
    const friend = await w.user({ email: address });
    await as.grant(id, { user: friend }, "write", { email: { path: "/notes/7" } });
    expect(sent).toEqual([{ to: address, sharedBy: "Test", level: "write", path: "/notes/7", subject: undefined, text: undefined }]);
  });

  it("E2: a new grant to an email address emails that address", async () => {
    const { sent, notify } = notices();
    const as = w.as(await w.user(), null, { notify });
    const id = `note-${uid()}`;
    await as.create(id);
    await as.grant(id, { email: "New@Example.com" }, "read");
    expect(sent.map((n) => [n.to, n.path])).toEqual([["new@example.com", "/"]]);
  });

  it("E3: changing a grant's level sends nothing", async () => {
    const { sent, notify } = notices();
    const as = w.as(await w.user(), null, { notify });
    const id = `note-${uid()}`;
    await as.create(id);
    await as.grant(id, { email: "a@example.com" }, "read");
    await as.grant(id, { email: "a@example.com" }, "write");
    expect(sent).toHaveLength(1);
  });

  it("E4: teams, organizations and Everyone get no email", async () => {
    const c = await company();
    const { sent, notify } = notices();
    const as = w.as(c.admin, null, { notify });
    const id = `doc-${uid()}`;
    await as.create(id, { parent: organizationPoint(c.org) });
    await as.grant(id, { team: c.team }, "read");
    await as.grant(id, { organization: c.org }, "read");
    await as.grant(id, { everyone: true }, "read");
    expect(sent).toEqual([]);
  });

  it("E5: email false sends nothing; a refused grant sends nothing", async () => {
    const { sent, notify } = notices();
    const as = w.as(await w.user(), null, { notify });
    const id = `note-${uid()}`;
    await as.create(id);
    await as.grant(id, { email: "a@example.com" }, "read", { email: false });
    await refused(w.as(await w.user(), null, { notify }).grant(id, { email: "b@example.com" }, "read"));
    expect(sent).toEqual([]);
  });

  it("E6: the app's own subject and text are used, with the link after the text", () => {
    const notice: ShareNotice = { to: "a@example.com", sharedBy: "Sam", level: "read", path: "/n/1", subject: "Hi", text: "Look" };
    expect(shareMessage(notice, "Demo", "https://demo.test")).toEqual({ to: "a@example.com", subject: "Hi", text: "Look\n\nhttps://demo.test/n/1\n" });
    expect(shareMessage({ ...notice, subject: undefined, text: undefined, sharedBy: null }, "Demo", "https://demo.test").subject).toBe("Someone shared something with you on Demo");
  });

  it("E7: an email path must start with one slash, so a link never leaves the app", async () => {
    const as = w.as(await w.user());
    const id = `note-${uid()}`;
    await as.create(id);
    for (const path of ["https://evil.test/x", "//evil.test/x", "/\\evil.test", "notes/1"]) await appError(as.grant(id, { email: "a@example.com" }, "read", { email: { path } }), /one \//);
    expect(await count("access_grant", "point_id = $1", [id])).toBe(1);
  });
});

describe("Links", () => {
  it("K1: a link gives its level on its point to anyone holding it, signed in or not", async () => {
    const { as, page } = await personal();
    const { token } = await as.link(page, "write");
    expect(await w.as(null, token).level(page)).toBe("write");
    expect(await w.as(await w.user(), token).level(page)).toBe("write");
  });

  it("K2: a link reaches only its own point, never the points under it or above it", async () => {
    const { as, folder, page } = await personal();
    const toFolder = (await as.link(folder, "write")).token;
    const toPage = (await as.link(page, "write")).token;
    expect(await w.as(null, toFolder).level(page)).toBe(null);
    expect(await w.as(null, toPage).level(folder)).toBe(null);
  });

  it("K3: a link carries read, create or write, never delete or manage", async () => {
    const { as, page } = await personal();
    await appError(as.link(page, "delete"), /never delete/);
    await appError(as.link(page, "manage"), /never manage/);
    for (const level of ["read", "create", "write"] as Level[]) await as.link(page, level);
  });

  it("K4: an expired or revoked link gives nothing", async () => {
    const { as, page } = await personal();
    const expired = await as.link(page, "read", { expires: new Date(Date.now() - 1000) });
    const revoked = await as.link(page, "read");
    await as.revokeLink(page, revoked.id);
    expect(await w.as(null, expired.token).level(page)).toBe(null);
    expect(await w.as(null, revoked.token).level(page)).toBe(null);
    const later = await as.link(page, "read", { expires: new Date(Date.now() + 60_000) });
    expect(await w.as(null, later.token).level(page)).toBe("read");
    await appError(as.link(page, "read", { expires: new Date("nope") }));
  });

  it("K5: a wrong token, or one made for another point, gives nothing", async () => {
    const a = await personal();
    const b = await personal();
    const { token } = await a.as.link(a.page, "write");
    expect(await w.as(null, token).level(b.page)).toBe(null);
    expect(await w.as(null, token + "x").level(a.page)).toBe(null);
    expect(await w.as(null, "").level(a.page)).toBe(null);
  });

  it("K6: only a hash of each token is stored", async () => {
    const { as, page } = await personal();
    const { token } = await as.link(page, "read");
    const stored = (await w.query(`select token_hash from access_link where point_id = $1`, [page])).rows[0].token_hash;
    expect(stored).not.toContain(token);
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("K7: making, listing and revoking links needs manage", async () => {
    const { as, page } = await personal();
    const writer = await w.user();
    await as.grant(page, { user: writer }, "write");
    const link = await as.link(page, "read");
    await refused(w.as(writer).link(page, "read"));
    await refused(w.as(writer).links(page));
    await refused(w.as(writer).revokeLink(page, link.id));
    expect(await as.links(page)).toEqual([{ id: link.id, level: "read", expiresAt: null }]);
  });

  it("K8: revoking with another point's link id revokes nothing", async () => {
    const a = await personal();
    const b = await personal();
    const link = await b.as.link(b.page, "read");
    await a.as.revokeLink(a.page, link.id);
    await a.as.revokeLink(a.page, "not-an-id");
    expect(await w.as(null, link.token).level(b.page)).toBe("read");
  });

  it("K9: a link and a grant together: the higher wins", async () => {
    const { as, page } = await personal();
    const reader = await w.user();
    await as.grant(page, { user: reader }, "read");
    const { token } = await as.link(page, "write");
    expect(await w.as(reader, token).level(page)).toBe("write");
  });
});

describe("Inheritance", () => {
  it("I1: a point that does not inherit ignores its parent's grants", async () => {
    const { as, folder } = await personal();
    const friend = await w.user();
    await as.grant(folder, { user: friend }, "write");
    const alone = `page-${uid()}`;
    await as.create(alone, { parent: folder });
    expect(await w.as(friend).level(alone)).toBe(null);
  });

  it("I2: a point that inherits uses its parent's grants", async () => {
    const { as, folder, page } = await personal();
    const friend = await w.user();
    await as.grant(folder, { user: friend }, "write");
    expect(await w.as(friend).level(page)).toBe("write");
  });

  it("I3: the walk goes up through inheriting points and stops after the first that does not inherit", async () => {
    const owner = w.as(await w.user());
    const [top, middle, low, leaf] = [`top-${uid()}`, `mid-${uid()}`, `low-${uid()}`, `leaf-${uid()}`];
    await owner.create(top);
    await owner.create(middle, { parent: top });
    await owner.create(low, { parent: middle, inherit: true });
    await owner.create(leaf, { parent: low, inherit: true });
    const [fromTop, fromMiddle] = [await w.user(), await w.user()];
    await owner.grant(top, { user: fromTop }, "read");
    await owner.grant(middle, { user: fromMiddle }, "read");
    expect(await w.as(fromMiddle).level(leaf)).toBe("read");
    expect(await w.as(fromTop).level(leaf)).toBe(null);
    await owner.inherit(middle, true);
    expect(await w.as(fromTop).level(leaf)).toBe("read");
  });

  it("I4: changing inheritance needs manage and applies on the next check", async () => {
    const { as, folder, page } = await personal();
    const [friend, writer] = [await w.user(), await w.user()];
    await as.grant(folder, { user: friend }, "read");
    await as.grant(page, { user: writer }, "delete");
    await refused(w.as(writer).inherit(page, false));
    await as.inherit(page, false);
    expect(await w.as(friend).level(page)).toBe(null);
  });

  it("I5: a narrower grant to the same principal lowers it on that point", async () => {
    const { as, folder, page } = await personal();
    const friend = await w.user();
    await as.grant(folder, { user: friend }, "write");
    await as.grant(page, { user: friend }, "read");
    expect(await w.as(friend).level(page)).toBe("read");
    expect(await w.as(friend).level(folder)).toBe("write");
  });

  it("I6: a grant to a broad principal never lowers a narrower one", async () => {
    const c = await company();
    await w.as(c.admin).grant(c.page, { organization: c.org }, "read");
    expect(await w.as(c.teammate).level(c.page)).toBe("write");
    expect(await w.as(c.member).level(c.page)).toBe("read");
  });

  it("I7: across principals the highest wins", async () => {
    const c = await company();
    const id = `doc-${uid()}`;
    await w.as(c.admin).create(id, { parent: organizationPoint(c.org) });
    await w.as(c.admin).grant(id, { organization: c.org }, "read");
    await w.as(c.admin).grant(id, { team: c.team }, "create");
    await w.as(c.admin).grant(id, { user: c.teammate }, "write");
    await w.as(c.admin).grant(id, { everyone: true }, "read");
    expect(await w.as(c.teammate).level(id)).toBe("write");
  });

  it("I8: a person's email grant and user grant are one principal; the nearer one counts", async () => {
    const { as, folder, page } = await personal();
    const address = `${uid()}@example.com`;
    const friend = await w.user({ email: address });
    await as.grant(folder, { user: friend }, "manage");
    await as.grant(page, { email: address }, "read");
    expect(await w.as(friend).level(page)).toBe("read");
    await as.grant(page, { user: friend }, "write");
    expect(await w.as(friend).level(page)).toBe("write");
  });

  it("I9: each team stops at its own nearest grant", async () => {
    const c = await company();
    const other = await w.team(c.org, c.admin);
    await w.join(other, c.teammate);
    await w.as(c.admin).grant(c.folder, { team: other }, "delete");
    await w.as(c.admin).grant(c.page, { team: c.team }, "read");
    // c.team says read at the page; the other team says delete at the folder.
    expect(await w.as(c.teammate).level(c.page)).toBe("delete");
  });

  it("I10: Everyone on a child and manage on the parent: manage", async () => {
    const { as, page, owner, folder } = await personal();
    await as.grant(page, { everyone: true }, "read");
    await as.revoke(page, { user: owner });
    expect(await w.as(owner).level(page)).toBe("manage");
    expect((await w.as(owner).grants(folder)).length).toBe(1);
  });

  it("I11: inheritance from a team point reaches the team's notes; the org's own grant does not when the team stops", async () => {
    const c = await company();
    expect(await w.as(c.teammate).level(c.page)).toBe("write");
    expect(await w.as(c.member).level(c.page)).toBe(null);
    await w.as(c.admin).inherit(teamPoint(c.team), true);
    expect(await w.as(c.member).level(c.page)).toBe("read");
  });
});

describe("Admins", () => {
  it("A1: an organization's creator is its first admin, with manage on its point", async () => {
    const creator = await w.user();
    const { id, admins } = await w.org(creator);
    expect(await w.as(creator).level(organizationPoint(id))).toBe("manage");
    expect((await w.query(`select user_id from team_member where team_id = $1`, [admins])).rows).toEqual([{ user_id: creator }]);
  });

  it("A2: admins get manage on every point under the organization, even one with no grants that stands alone", async () => {
    const c = await company();
    const second = await w.user();
    await w.member(c.org, second);
    await w.join(c.admins, second);
    const id = `secret-${uid()}`;
    await w.as(c.teammate).create(id, { parent: teamPoint(c.team) });
    await w.as(c.teammate).revoke(id, { user: c.teammate }).catch(() => {});
    expect(await w.as(second).level(id)).toBe("manage");
    expect(await w.as(second).level(c.page)).toBe("manage");
    expect(await w.as(second).level(teamPoint(c.team))).toBe("manage");
  });

  it("A3: admins of one organization get nothing in another", async () => {
    const a = await company();
    const b = await company();
    expect(await w.as(a.admin).level(b.page)).toBe(null);
    expect(await w.as(a.admin).level(organizationPoint(b.org))).toBe(null);
  });

  it("A4: an admin who leaves the organization keeps no reach, even with the team row left behind", async () => {
    const c = await company();
    const second = await w.user();
    await w.member(c.org, second);
    await w.join(c.admins, second);
    await w.query(`delete from member where organization_id = $1 and user_id = $2`, [c.org, second]);
    expect(await w.as(second).level(c.page)).toBe(null);
  });

  it("A5: admins have no reach into members' personal points", async () => {
    const c = await company();
    const id = `mine-${uid()}`;
    await w.as(c.member).create(id);
    expect(await w.as(c.admin).level(id)).toBe(null);
  });

  it("A6: the last admin cannot leave, be removed, or leave the Admins team; with a second admin they can", async () => {
    const c = await company();
    const orgs = w.orgs(c.admin);
    const theirs = `theirs-${uid()}`;
    await w.as(c.teammate).create(theirs, { parent: teamPoint(c.team) });
    await refused(orgs.removeMember(c.org, c.admin), 409);
    await refused(orgs.removeFromTeam(c.admins, c.admin), 409);
    expect(await w.as(c.admin).level(theirs)).toBe("manage");
    await orgs.addToTeam(c.admins, c.member);
    await orgs.removeFromTeam(c.admins, c.admin);
    expect(await w.as(c.admin).level(theirs)).toBe(null);
    await refused(w.orgs(c.member).removeMember(c.org, c.member), 409);
  });

  it("A7: the Admins team cannot be deleted", async () => {
    const c = await company();
    await refused(w.orgs(c.admin).removeTeam(c.admins), 409);
  });

  it("A8: two admins removing each other at once leave one admin", async () => {
    const c = await company();
    await w.orgs(c.admin).addToTeam(c.admins, c.member);
    const results = await Promise.allSettled([w.orgs(c.admin).removeFromTeam(c.admins, c.member), w.orgs(c.member).removeFromTeam(c.admins, c.admin)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(Number((await w.query(`select count(*) from team_member where team_id = $1`, [c.admins])).rows[0].count)).toBe(1);
  });
});

describe("Moving", () => {
  it("M1: moving needs manage on the point and create on the new parent", async () => {
    const a = await personal();
    const b = await personal();
    await refused(a.as.move(a.page, b.folder));
    await b.as.grant(b.folder, { user: a.owner }, "create");
    await a.as.move(a.page, b.folder);
    expect((await pointOf(a.page)).parent_id).toBe(b.folder);
    const reader = await w.user();
    await b.as.grant(b.page, { user: reader }, "write");
    await refused(w.as(reader).move(b.page, null));
  });

  it("M2: a point cannot move under itself or anything under it", async () => {
    const { as, folder, page } = await personal();
    await refused(as.move(folder, page), 409);
    await refused(as.move(folder, folder), 409);
    expect((await pointOf(folder)).parent_id).toBe(null);
  });

  it(`M3: a move that would make a chain longer than ${MAX_DEPTH} is refused`, async () => {
    const owner = w.as(await w.user());
    let parent: string | undefined;
    const ids: string[] = [];
    for (let i = 0; i < MAX_DEPTH - 1; i++) {
      const id = `deep-${uid()}`;
      await owner.create(id, { parent });
      ids.push(id);
      parent = id;
    }
    const a = `pair-${uid()}`;
    const b = `pair-${uid()}`;
    await owner.create(a);
    await owner.create(b, { parent: a });
    await refused(owner.move(a, parent!), 409);
    await owner.move(b, parent!);
  });

  it("M4: organization and team points move and go only through the organization", async () => {
    const c = await company();
    const as = w.as(c.admin);
    await refused(as.move(teamPoint(c.team), null), 409);
    await refused(as.move(organizationPoint(c.org), null), 409);
    await refused(as.remove(teamPoint(c.team)), 409);
    await refused(as.remove(organizationPoint(c.org)), 409);
  });

  it("M5: moving into an organization brings the whole subtree under it, with its admins", async () => {
    const c = await company();
    const mine = await personal();
    await w.member(c.org, mine.owner);
    await w.as(c.admin).grant(teamPoint(c.team), { user: mine.owner }, "create");
    await mine.as.move(mine.folder, teamPoint(c.team));
    expect((await pointOf(mine.page)).organization_id).toBe(c.org);
    expect(await w.as(c.admin).level(mine.page)).toBe("manage");
    await mine.as.move(mine.folder, null);
    expect((await pointOf(mine.page)).organization_id).toBe(null);
    expect(await w.as(c.admin).level(mine.page)).toBe(null);
  });

  it("M6: a subtree granted to another organization's team cannot move into an organization", async () => {
    const a = await company();
    const b = await company();
    const mine = await personal();
    await mine.as.grant(mine.page, { team: b.team }, "read");
    await w.as(a.admin).grant(teamPoint(a.team), { user: mine.owner }, "create");
    await w.member(a.org, mine.owner);
    await refused(mine.as.move(mine.folder, teamPoint(a.team)), 409);
    await mine.as.revoke(mine.page, { team: b.team });
    await mine.as.move(mine.folder, teamPoint(a.team));
  });

  it("M7: a point can move to the top", async () => {
    const { as, page } = await personal();
    await as.move(page, null);
    expect((await pointOf(page)).parent_id).toBe(null);
  });

  it("M8: two moves at once can never make a loop", async () => {
    const owner = w.as(await w.user());
    const [a, b] = [`a-${uid()}`, `b-${uid()}`];
    await owner.create(a);
    await owner.create(b);
    await Promise.allSettled([owner.move(a, b), owner.move(b, a)]);
    const loop = await w.query(`select 1 from access_point x join access_point y on x.parent_id = y.id and y.parent_id = x.id where x.id = $1`, [a]);
    expect(loop.rows).toEqual([]);
  });
});

describe("Deleting", () => {
  it("D1: removing needs delete and returns the point and everything under it, its own id first", async () => {
    const { as, folder, page } = await personal();
    const deeper = `deeper-${uid()}`;
    await as.create(deeper, { parent: page });
    const writer = await w.user();
    await as.grant(folder, { user: writer }, "write");
    await refused(w.as(writer).remove(folder));
    await as.link(page, "read");
    expect(await as.remove(folder)).toEqual([folder, page, deeper]);
    for (const id of [folder, page, deeper]) {
      expect(await pointOf(id)).toBe(null);
      expect(await count("access_grant", "point_id = $1", [id])).toBe(0);
      expect(await count("access_link", "point_id = $1", [id])).toBe(0);
    }
  });

  it("D2: inside the app's transaction, a rolled-back remove keeps everything", async () => {
    const { as, page } = await personal();
    await db
      .transaction(async (tx) => {
        await as.in(tx).remove(page);
        throw new Error("rolled back");
      })
      .catch(() => {});
    expect(await pointOf(page)).not.toBe(null);
  });

  it("D3: a deleted person's grants go, and grants they gave stay", async () => {
    const { as, owner, page } = await personal();
    const [friend, other] = [await w.user(), await w.user()];
    await as.grant(page, { user: friend }, "write");
    await as.grant(page, { user: other }, "read");
    await w.query(`delete from "user" where id = $1`, [friend]);
    expect(await count("access_grant", "user_id = $1", [friend])).toBe(0);
    expect(await w.as(other).level(page)).toBe("read");
    expect(await w.as(owner).level(page)).toBe("manage");
  });

  it("D4: a deleted team's grants go, and its point with everything under it", async () => {
    const c = await company();
    const mine = await personal();
    await mine.as.grant(mine.page, { team: c.team }, "write");
    await w.orgs(c.admin).removeTeam(c.team);
    expect(await count("access_grant", "team_id = $1", [c.team])).toBe(0);
    expect(await pointOf(teamPoint(c.team))).toBe(null);
    expect(await pointOf(c.page)).toBe(null);
  });

  it("D5: a deleted organization takes every point under it and every grant to it", async () => {
    const c = await company();
    const mine = await personal();
    await mine.as.grant(mine.page, { organization: c.org }, "read");
    await w.orgs(c.admin).remove(c.org);
    expect(await pointOf(c.page)).toBe(null);
    expect(await pointOf(organizationPoint(c.org))).toBe(null);
    expect(await count("access_grant", "organization_id = $1", [c.org])).toBe(0);
    expect(await mine.as.level(mine.page)).toBe("manage");
  });

  it("D6: removing a point inside an app transaction lets the app delete its rows in the same commit", async () => {
    const { as, folder, page } = await personal();
    await w.query(`create table if not exists pages (id text primary key)`);
    await w.query(`insert into pages (id) values ($1), ($2)`, [folder, page]);
    await db.transaction(async (tx) => {
      const gone = await as.in(tx).remove(folder);
      await tx.execute(sql`delete from pages where id in ${gone}`);
    });
    expect(await count("pages", "id in ($1, $2)", [folder, page])).toBe(0);
  });
});
