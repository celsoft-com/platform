import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Pool } from "pg";
import { freshDatabase, world } from "../../test/database.js";
import { MAX_DEPTH, type Access, type Level } from "./access.js";
import { EndpointError } from "./endpoint-error.js";
import { apiHandler, endpoint } from "./endpoints.js";
import { defineApp } from "./index.js";
import { serveMcp } from "./mcp.js";

// One test per row of docs/access-rules.md, named by its row, then the stranger cases around them.

const { db, pool, url } = await freshDatabase();
const w = world(db, pool);
const uid = () => randomUUID();

const refused = async (work: Promise<unknown>, status = 404) => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error, "expected a refusal").toBeInstanceOf(EndpointError);
  expect((error as EndpointError).status).toBe(status);
};
const appError = async (work: Promise<unknown>) => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error, "expected an error in the app's code").toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(EndpointError);
};
const parentOf = async (kind: string, id: string) =>
  (await w.query(`select parent_kind, parent_id from access_item where kind = $1 and id = $2`, [kind, id])).rows[0] ?? null;
const count = async (table: string, where: string, values: unknown[]) => Number((await w.query(`select count(*) from ${table} where ${where}`, values)).rows[0].count);

// A user's own folder holding a page.
async function personal() {
  const owner = await w.user();
  const folder = uid();
  const page = uid();
  await w.item("folder", folder, "user", owner);
  await w.item("page", page, "folder", folder);
  return { owner, folder, page, as: w.as(owner) };
}

// An organization with one person in each role, an outsider, and a folder holding a page.
async function company() {
  const org = await w.org();
  const [owner, admin, member, outsider] = [await w.user(), await w.user(), await w.user(), await w.user()];
  await w.member(org, owner, "owner");
  await w.member(org, admin, "admin");
  await w.member(org, member, "member");
  const folder = uid();
  const page = uid();
  await w.item("folder", folder, "organization", org);
  await w.item("page", page, "folder", folder);
  return { org, owner, admin, member, outsider, folder, page };
}

describe("Levels", () => {
  it("L1: asked for read, has read: allowed", async () => {
    const { as, page } = await personal();
    const reader = await w.user();
    await as.share("page", page, { user: reader }, "read");
    expect(await w.as(reader).can("page", page, "read")).toBe(true);
  });

  it("L2: asked for write, has read: refused", async () => {
    const { as, page } = await personal();
    const reader = await w.user();
    await as.share("page", page, { user: reader }, "read");
    expect(await w.as(reader).can("page", page, "write")).toBe(false);
    await refused(w.as(reader).require("page", page, "write"));
  });

  it("L3: asked for read, has manage: each level includes those below", async () => {
    const { as, page } = await personal();
    for (const level of ["read", "create", "write", "delete", "manage"] as Level[]) expect(await as.can("page", page, level)).toBe(true);
  });

  it("L4: no level at all: refused, as 404", async () => {
    const { page } = await personal();
    const stranger = w.as(await w.user());
    expect(await stranger.level("page", page)).toBe(null);
    expect(await stranger.can("page", page, "read")).toBe(false);
    await refused(stranger.require("page", page, "read"));
  });

  it("L5: an unknown level is an error in the app's code, never allowed", async () => {
    const { as, page } = await personal();
    await appError(as.can("page", page, "admin" as Level));
    await appError(as.require("page", page, "owner" as Level));
    await appError(as.share("page", page, { user: await w.user() }, "superuser" as Level));
    await appError(as.link("page", page, "" as Level));
    await appError(as.accessible("page", "READ" as Level, sql`'x'`));
  });

  it("refuses the same way for a missing item and an item the caller cannot see", async () => {
    const { page } = await personal();
    const stranger = w.as(await w.user());
    const hidden = await stranger.require("page", page, "read").catch((e: EndpointError) => [e.status, e.message]);
    const missing = await stranger.require("page", uid(), "read").catch((e: EndpointError) => [e.status, e.message]);
    expect(hidden).toEqual(missing);
  });

  it("refuses reserved and malformed kinds and ids as errors in the app's code", async () => {
    const { as, owner } = await personal();
    await appError(as.can("user", owner, "read"));
    await appError(as.can("organization", uid(), "read"));
    await appError(as.can("Page", uid(), "read"));
    await appError(as.can("page", "", "read"));
    await appError(as.can("page", "x".repeat(201), "read"));
    await appError(as.place("user", uid(), "user", owner));
  });

  it("never lets a kind or id smuggle SQL", async () => {
    const { as, page } = await personal();
    expect(await as.can("page", `${page}' or '1'='1`, "read")).toBe(false);
    expect(await w.as(await w.user()).can("page", `x' or 1=1 --`, "read")).toBe(false);
    expect(await count("access_item", "true", [])).toBeGreaterThan(0);
  });
});

describe("Ownership and organizations", () => {
  it("O1: a user owns an item placed directly under them: manage, and on everything inside", async () => {
    const { as, folder, page } = await personal();
    expect(await as.level("folder", folder)).toBe("manage");
    expect(await as.level("page", page)).toBe("manage");
  });

  it("O2: member: read", async () => {
    const c = await company();
    expect(await w.as(c.member).level("folder", c.folder)).toBe("read");
    expect(await w.as(c.member).level("page", c.page)).toBe("read");
  });

  it("O3: admin: delete", async () => {
    const c = await company();
    expect(await w.as(c.admin).level("page", c.page)).toBe("delete");
  });

  it("O4: owner: manage", async () => {
    const c = await company();
    expect(await w.as(c.owner).level("page", c.page)).toBe("manage");
  });

  it("O5: not in the organization: refused", async () => {
    const c = await company();
    expect(await w.as(c.outsider).level("page", c.page)).toBe(null);
  });

  it("O6: member removed: refused on the next request", async () => {
    const c = await company();
    const as = w.as(c.member);
    expect(await as.level("page", c.page)).toBe("read");
    await w.leave(c.org, c.member);
    expect(await as.level("page", c.page)).toBe(null);
  });

  it("O7: role changed from admin to member: read from the next request", async () => {
    const c = await company();
    const as = w.as(c.admin);
    expect(await as.level("page", c.page)).toBe("delete");
    await w.setRole(c.org, c.admin, "member");
    expect(await as.level("page", c.page)).toBe("read");
  });

  it("O8: owner of a different organization: refused", async () => {
    const c = await company();
    const other = await w.org();
    await w.member(other, c.outsider, "owner");
    expect(await w.as(c.outsider).level("page", c.page)).toBe(null);
  });

  it("O9: leaving an organization keeps manage on items the user owns personally", async () => {
    const c = await company();
    const mine = uid();
    await w.item("folder", mine, "user", c.member);
    await w.leave(c.org, c.member);
    expect(await w.as(c.member).level("folder", mine)).toBe("manage");
  });

  it("takes the highest of several roles held at once", async () => {
    const c = await company();
    await w.setRole(c.org, c.member, "member,admin");
    expect(await w.as(c.member).level("page", c.page)).toBe("delete");
    await w.setRole(c.org, c.member, " member , owner ");
    expect(await w.as(c.member).level("page", c.page)).toBe("manage");
  });

  it("gives nothing for a role it does not know", async () => {
    const c = await company();
    await w.setRole(c.org, c.member, "guest");
    expect(await w.as(c.member).level("page", c.page)).toBe(null);
    await w.setRole(c.org, c.member, "");
    expect(await w.as(c.member).level("page", c.page)).toBe(null);
  });

  it("does not let a user id stand in for an organization id, or the reverse", async () => {
    const c = await company();
    const sneaky = uid();
    await w.item("folder", sneaky, "user", c.org);
    expect(await w.as(c.owner).level("folder", sneaky)).toBe(null);
    const other = uid();
    await w.item("folder", other, "organization", c.owner);
    expect(await w.as(c.owner).level("folder", other)).toBe(null);
  });

  it("gives a signed-out caller nothing from ownership", async () => {
    const c = await company();
    expect(await w.as(null).level("page", c.page)).toBe(null);
  });
});

describe("Grants", () => {
  it("G1: shared with the user at write: write", async () => {
    const { as, page } = await personal();
    const friend = await w.user();
    await as.share("page", page, { user: friend }, "write");
    expect(await w.as(friend).level("page", page)).toBe("write");
  });

  it("G2: shared with a team at write; user in the team: write", async () => {
    const c = await company();
    const team = await w.team(c.org);
    await w.join(team, c.member);
    await w.as(c.owner).share("folder", c.folder, { team }, "write");
    expect(await w.as(c.member).level("page", c.page)).toBe("write");
  });

  it("G3: removed from the team: refused on the next request", async () => {
    const { as, page } = await personal();
    const org = await w.org();
    const team = await w.team(org);
    const friend = await w.user();
    await w.join(team, friend);
    await as.share("page", page, { team }, "write");
    const friendAs = w.as(friend);
    expect(await friendAs.level("page", page)).toBe("write");
    await w.leaveTeam(team, friend);
    expect(await friendAs.level("page", page)).toBe(null);
  });

  it("G4: shared with an organization; a member gets that level, even above their role's", async () => {
    const c = await company();
    await w.as(c.owner).share("page", c.page, { organization: c.org }, "write");
    expect(await w.as(c.member).level("page", c.page)).toBe("write");
    expect(await w.as(c.member).level("folder", c.folder)).toBe("read");
  });

  it("G5: shared with an email nobody has yet: nobody gets access", async () => {
    const { as, page } = await personal();
    await as.share("page", page, { email: `${uid()}@example.com` }, "write");
    expect(await w.as(await w.user()).level("page", page)).toBe(null);
  });

  it("G6: someone signs up with that address but has not confirmed it: refused", async () => {
    const { as, page } = await personal();
    const email = `${uid()}@example.com`;
    await as.share("page", page, { email }, "write");
    const newcomer = await w.user({ email, verified: false });
    expect(await w.as(newcomer).level("page", page)).toBe(null);
    expect(await w.as(newcomer).sharedWithMe("page")).toEqual([]);
  });

  it("G7: they confirm the address: the grant becomes theirs", async () => {
    const { as, page } = await personal();
    const email = `${uid()}@example.com`;
    await as.share("page", page, { email }, "write");
    const newcomer = await w.user({ email, verified: false });
    await w.query(`update "user" set email_verified = true where id = $1`, [newcomer]);
    expect(await w.as(newcomer).level("page", page)).toBe("write");
    expect(await w.as(newcomer).sharedWithMe("page")).toEqual([page]);
  });

  it("matches email grants without regard to case or surrounding spaces", async () => {
    const { as, page } = await personal();
    const local = uid();
    await as.share("page", page, { email: `  ${local.toUpperCase()}@Example.COM ` }, "read");
    const user = await w.user({ email: `${local}@EXAMPLE.com` });
    expect(await w.as(user).level("page", page)).toBe("read");
    expect(await as.grants("page", page)).toEqual([{ to: { email: `${local}@example.com` }, level: "read", grantedBy: expect.any(String) }]);
  });

  it("does not match an email grant to a different address that merely contains it", async () => {
    const { as, page } = await personal();
    const local = uid();
    await as.share("page", page, { email: `${local}@example.com` }, "read");
    expect(await w.as(await w.user({ email: `x${local}@example.com` })).level("page", page)).toBe(null);
    expect(await w.as(await w.user({ email: `${local}@example.com.evil` })).level("page", page)).toBe(null);
  });

  it("G8: grant revoked: refused on the next request", async () => {
    const { as, page } = await personal();
    const friend = await w.user();
    await as.share("page", page, { user: friend }, "write");
    const friendAs = w.as(friend);
    expect(await friendAs.level("page", page)).toBe("write");
    await as.revoke("page", page, { user: friend });
    expect(await friendAs.level("page", page)).toBe(null);
  });

  it("G9: shared at read, then again at write: one grant, at write", async () => {
    const { as, page } = await personal();
    const friend = await w.user();
    await as.share("page", page, { user: friend }, "read");
    await as.share("page", page, { user: friend }, "write");
    expect(await as.grants("page", page)).toEqual([{ to: { user: friend }, level: "write", grantedBy: expect.any(String) }]);
    await as.share("page", page, { user: friend }, "read");
    expect(await w.as(friend).level("page", page)).toBe("read");
  });

  it("G10: the person who shared loses their own access: grants they gave stay", async () => {
    const c = await company();
    const friend = await w.user();
    await w.setRole(c.org, c.admin, "owner");
    await w.as(c.admin).share("page", c.page, { user: friend }, "write");
    await w.leave(c.org, c.admin);
    expect(await w.as(c.admin).level("page", c.page)).toBe(null);
    expect(await w.as(friend).level("page", c.page)).toBe("write");
    await w.query(`delete from "user" where id = $1`, [c.admin]);
    expect(await w.as(c.owner).grants("page", c.page)).toEqual([{ to: { user: friend }, level: "write", grantedBy: null }]);
    expect(await w.as(friend).level("page", c.page)).toBe("write");
  });

  it("G11: someone with write tries to share: refused, since sharing needs manage", async () => {
    const { as, page } = await personal();
    const writer = await w.user();
    await as.share("page", page, { user: writer }, "write");
    await refused(w.as(writer).share("page", page, { user: await w.user() }, "read"));
    await refused(w.as(writer).revoke("page", page, { user: writer }));
    await refused(w.as(writer).grants("page", page));
    await refused(w.as(writer).restrict("page", page));
    expect(await as.grants("page", page)).toHaveLength(1);
  });

  it("G12: someone with manage shares at manage: allowed, and the new manager can share on", async () => {
    const { as, page } = await personal();
    const [first, second, third] = [await w.user(), await w.user(), await w.user()];
    await as.share("page", page, { user: first }, "manage");
    await w.as(first).share("page", page, { user: second }, "manage");
    await w.as(second).share("page", page, { user: third }, "read");
    expect(await w.as(third).level("page", page)).toBe("read");
  });

  it("G13: a manager from a grant cannot remove the owner's or an organization role's access", async () => {
    const c = await company();
    const manager = await w.user();
    await w.as(c.owner).share("page", c.page, { user: manager }, "manage");
    const as = w.as(manager);
    await as.revoke("page", c.page, { user: c.owner });
    await as.revoke("page", c.page, { user: c.admin });
    await as.revoke("page", c.page, { organization: c.org });
    expect(await w.as(c.owner).level("page", c.page)).toBe("manage");
    expect(await w.as(c.admin).level("page", c.page)).toBe("delete");
    expect(await w.as(c.member).level("page", c.page)).toBe("read");
  });

  it("G13: a manager from a grant can revoke their own grant and so lose access", async () => {
    const { as, page } = await personal();
    const manager = await w.user();
    await as.share("page", page, { user: manager }, "manage");
    await w.as(manager).revoke("page", page, { user: manager });
    expect(await w.as(manager).level("page", page)).toBe(null);
  });

  it("G14: a grant at manage: allowed", async () => {
    const { as, page } = await personal();
    const friend = await w.user();
    await as.share("page", page, { user: friend }, "manage");
    expect(await w.as(friend).level("page", page)).toBe("manage");
  });

  it("refuses a grant to a user, team or organization that does not exist, and stores nothing", async () => {
    const { as, page } = await personal();
    await refused(as.share("page", page, { user: uid() }, "read"));
    await refused(as.share("page", page, { team: uid() }, "read"));
    await refused(as.share("page", page, { organization: uid() }, "read"));
    expect(await as.grants("page", page)).toEqual([]);
  });

  it("refuses a grantee that is not exactly one of user, team, organization or email", async () => {
    const { as, page, owner } = await personal();
    await appError(as.share("page", page, { user: owner, team: owner } as never, "read"));
    await appError(as.share("page", page, {} as never, "read"));
    await appError(as.share("page", page, { group: owner } as never, "read"));
    await appError(as.share("page", page, { email: "   " }, "read"));
    await appError(as.share("page", page, { user: 7 } as never, "read"));
  });

  it("refuses a malformed id with a 404 rather than a server error", async () => {
    const { as, page } = await personal();
    await refused(as.share("page", page, { user: "not-a-uuid" }, "read"));
    await refused(as.share("page", page, { team: "7" }, "read"));
  });

  it("refuses to share an item that is not placed", async () => {
    const { as } = await personal();
    await refused(as.share("page", uid(), { user: await w.user() }, "read"));
  });

  it("keeps grants to a user, a team and an organization on one item apart", async () => {
    const c = await company();
    const team = await w.team(c.org);
    const as = w.as(c.owner);
    await as.share("page", c.page, { user: c.member }, "read");
    await as.share("page", c.page, { team }, "write");
    await as.share("page", c.page, { organization: c.org }, "create");
    expect(await as.grants("page", c.page)).toHaveLength(3);
    await as.revoke("page", c.page, { team });
    expect((await as.grants("page", c.page)).map((g) => Object.keys(g.to)[0]).sort()).toEqual(["organization", "user"]);
  });

  it("lists in sharedWithMe only what the caller can still read", async () => {
    const c = await company();
    const team = await w.team(c.org);
    const friend = await w.user();
    await w.join(team, friend);
    const [a, b, d] = [uid(), uid(), uid()];
    for (const id of [a, b, d]) await w.item("page", id, "folder", c.folder);
    const as = w.as(c.owner);
    await as.share("page", a, { user: friend }, "read");
    await as.share("page", b, { team }, "read");
    await as.share("page", d, { user: friend }, "read");
    await as.restrict("folder", c.folder);
    expect((await w.as(friend).sharedWithMe("page")).sort()).toEqual([a, b, d].sort());
    await w.query(`update access_item set parent_kind = 'user', parent_id = $1 where kind = 'page' and id = $2`, [uid(), d]);
    expect((await w.as(friend).sharedWithMe("page")).sort()).toEqual([a, b].sort());
    expect(await w.as(friend).sharedWithMe("folder")).toEqual([]);
    expect(await w.as(null).sharedWithMe("page")).toEqual([]);
  });
});

describe("Links", () => {
  it("K1: a valid link token at read: read, signed in or not", async () => {
    const { as, page } = await personal();
    const { token } = await as.link("page", page, "read");
    expect(await w.as(null, token).level("page", page)).toBe("read");
    expect(await w.as(await w.user(), token).level("page", page)).toBe("read");
  });

  it("K2: a token for a different item: refused", async () => {
    const { as, page, folder } = await personal();
    const other = uid();
    await w.item("page", other, "folder", folder);
    const { token } = await as.link("page", page, "read");
    expect(await w.as(null, token).level("page", other)).toBe(null);
    expect(await w.as(null, token).level("folder", folder)).toBe(null);
  });

  it("K3: an expired token: refused; one not yet expired works", async () => {
    const { as, page } = await personal();
    const old = await as.link("page", page, "read", { expires: new Date(Date.now() - 1000) });
    const fresh = await as.link("page", page, "read", { expires: new Date(Date.now() + 60_000) });
    expect(await w.as(null, old.token).level("page", page)).toBe(null);
    expect(await w.as(null, fresh.token).level("page", page)).toBe("read");
  });

  it("K4: a revoked token: refused on the next request", async () => {
    const { as, page } = await personal();
    const { id, token } = await as.link("page", page, "write");
    const holder = w.as(null, token);
    expect(await holder.level("page", page)).toBe("write");
    await as.revokeLink("page", page, id);
    expect(await holder.level("page", page)).toBe(null);
  });

  it("K5: a token for a folder works on a page inside it", async () => {
    const { as, folder, page } = await personal();
    const { token } = await as.link("folder", folder, "read");
    expect(await w.as(null, token).level("page", page)).toBe("read");
  });

  it("K6: read from a grant and a write link: write, the highest", async () => {
    const { as, page } = await personal();
    const friend = await w.user();
    await as.share("page", page, { user: friend }, "read");
    const { token } = await as.link("page", page, "write");
    expect(await w.as(friend, token).level("page", page)).toBe("write");
  });

  it("K7: a guessed or altered token: refused", async () => {
    const { as, page } = await personal();
    const { token } = await as.link("page", page, "read");
    const flipped = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    for (const guess of [flipped, token.slice(1), `${token} `, token.toUpperCase(), "", "null", uid()]) {
      expect(await w.as(null, guess).level("page", page), guess).toBe(null);
    }
  });

  it("K7: the database holds only a hash of the token", async () => {
    const { as, page } = await personal();
    const { token } = await as.link("page", page, "read");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await count("access_link", "token_hash = $1", [token])).toBe(0);
    const stored = (await w.query(`select token_hash from access_link where item_id = $1`, [page])).rows[0].token_hash;
    expect(await w.as(null, stored).level("page", page)).toBe(null);
  });

  it("K8: a link made at write: allowed, and create too", async () => {
    const { as, page } = await personal();
    expect(await w.as(null, (await as.link("page", page, "write")).token).level("page", page)).toBe("write");
    expect(await w.as(null, (await as.link("page", page, "create")).token).level("page", page)).toBe("create");
  });

  it("K9: a link made at delete or manage: refused", async () => {
    const { as, page } = await personal();
    await appError(as.link("page", page, "delete"));
    await appError(as.link("page", page, "manage"));
    expect(await as.links("page", page)).toEqual([]);
  });

  it("refuses making, listing or revoking links without manage", async () => {
    const { as, page } = await personal();
    const writer = await w.user();
    await as.share("page", page, { user: writer }, "write");
    const { id } = await as.link("page", page, "read");
    await refused(w.as(writer).link("page", page, "read"));
    await refused(w.as(writer).links("page", page));
    await refused(w.as(writer).revokeLink("page", page, id));
    const holder = await as.link("page", page, "write");
    await refused(w.as(null, holder.token).link("page", page, "read"));
    expect(await as.links("page", page)).toHaveLength(2);
  });

  it("revokes a link only through the item it belongs to", async () => {
    const { as, page, folder } = await personal();
    const { id, token } = await as.link("page", page, "read");
    await as.revokeLink("folder", folder, id);
    expect(await w.as(null, token).level("page", page)).toBe("read");
  });

  it("gives a link holder nothing they could not get from the link alone", async () => {
    const { as, page } = await personal();
    const { token } = await as.link("page", page, "write");
    const holder = w.as(null, token);
    await refused(holder.share("page", page, { user: await w.user() }, "read"));
    await refused(holder.remove("page", page));
    expect(await holder.sharedWithMe("page")).toEqual([]);
  });

  it("stops working when its item is deleted, even if the id is reused", async () => {
    const { as, folder, page } = await personal();
    const { token } = await as.link("page", page, "read");
    await as.remove("page", page);
    await as.place("page", page, "folder", folder);
    expect(await w.as(null, token).level("page", page)).toBe(null);
  });
});

describe("Inheritance", () => {
  it("I1: write on a folder: write on a page in it", async () => {
    const { as, folder, page } = await personal();
    const friend = await w.user();
    await as.share("folder", folder, { user: friend }, "write");
    expect(await w.as(friend).level("page", page)).toBe("write");
  });

  it("I2: write on a folder: write three folders down", async () => {
    const { as, owner, folder } = await personal();
    const [a, b, c, deep] = [uid(), uid(), uid(), uid()];
    await as.place("folder", a, "folder", folder);
    await as.place("folder", b, "folder", a);
    await as.place("folder", c, "folder", b);
    await as.place("page", deep, "folder", c);
    const friend = await w.user();
    await w.as(owner).share("folder", folder, { user: friend }, "write");
    expect(await w.as(friend).level("page", deep)).toBe("write");
  });

  it("I3: write on a page: refused on its folder, since levels flow down, never up", async () => {
    const { as, folder, page } = await personal();
    const friend = await w.user();
    await as.share("page", page, { user: friend }, "write");
    expect(await w.as(friend).level("folder", folder)).toBe(null);
  });

  it("I4: read on a folder, write on a page in it: write there, read on its siblings", async () => {
    const { as, folder, page } = await personal();
    const sibling = uid();
    await as.place("page", sibling, "folder", folder);
    const friend = await w.user();
    await as.share("folder", folder, { user: friend }, "read");
    await as.share("page", page, { user: friend }, "write");
    expect(await w.as(friend).level("page", page)).toBe("write");
    expect(await w.as(friend).level("page", sibling)).toBe("read");
  });

  it("I5: a page moved out of a shared folder: the folder's grants stop applying", async () => {
    const { as, owner, folder, page } = await personal();
    const friend = await w.user();
    await as.share("folder", folder, { user: friend }, "write");
    const other = uid();
    await as.place("folder", other, "user", owner);
    await as.place("page", page, "folder", other);
    expect(await w.as(friend).level("page", page)).toBe(null);
  });

  it("I6: a page moved into a shared folder: the folder's grants apply", async () => {
    const { as, owner, folder } = await personal();
    const friend = await w.user();
    await as.share("folder", folder, { user: friend }, "write");
    const loose = uid();
    await as.place("page", loose, "user", owner);
    expect(await w.as(friend).level("page", loose)).toBe(null);
    await as.place("page", loose, "folder", folder);
    expect(await w.as(friend).level("page", loose)).toBe("write");
  });

  it("I7: an item never placed: nobody has access, not even its creator", async () => {
    const { as } = await personal();
    const never = uid();
    expect(await as.level("page", never)).toBe(null);
  });

  it("I8: a chain deeper than the limit: refused, and logged as a bug", async () => {
    const owner = await w.user();
    const ids = Array.from({ length: MAX_DEPTH + 1 }, uid);
    await w.item("folder", ids[0]!, "user", owner);
    for (let i = 1; i < ids.length; i++) await w.item("folder", ids[i]!, "folder", ids[i - 1]!);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await w.as(owner).level("folder", ids[MAX_DEPTH - 1]!)).toBe("manage");
      expect(log).not.toHaveBeenCalled();
      expect(await w.as(owner).level("folder", ids[MAX_DEPTH]!)).toBe(null);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("deep"));
    } finally {
      log.mockRestore();
    }
  });

  it("refuses everything on a loop written straight into the table, without hanging", async () => {
    const owner = await w.user();
    const [a, b] = [uid(), uid()];
    await w.item("folder", a, "folder", b);
    await w.item("folder", b, "folder", a);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await w.as(owner).level("folder", a)).toBe(null);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses everything below a missing parent, grants on the item included", async () => {
    const owner = await w.user();
    const orphan = uid();
    await w.item("page", orphan, "folder", uid());
    await w.query(`insert into access_grant (item_kind, item_id, user_id, level) values ('page', $1, $2, 5)`, [orphan, owner]);
    expect(await w.as(owner).level("page", orphan)).toBe(null);
  });

  it("does not confuse two items with the same id but different kinds", async () => {
    const { as, owner } = await personal();
    const shared = uid();
    await as.place("folder", shared, "user", owner);
    const stranger = await w.user();
    await w.item("page", shared, "user", stranger);
    expect(await as.level("folder", shared)).toBe("manage");
    expect(await as.level("page", shared)).toBe(null);
    expect(await w.as(stranger).level("folder", shared)).toBe(null);
  });
});

describe("Restricted items", () => {
  it("R1: folder restricted; read from the organization: refused on it and everything inside", async () => {
    const c = await company();
    await w.as(c.owner).restrict("folder", c.folder);
    expect(await w.as(c.member).level("folder", c.folder)).toBe(null);
    expect(await w.as(c.member).level("page", c.page)).toBe(null);
  });

  it("R2: the same folder shared with the user at read: read", async () => {
    const c = await company();
    const as = w.as(c.owner);
    await as.restrict("folder", c.folder);
    await as.share("folder", c.folder, { user: c.member }, "read");
    expect(await w.as(c.member).level("folder", c.folder)).toBe("read");
    expect(await w.as(c.member).level("page", c.page)).toBe("read");
  });

  it("R3: a read-only folder shared with the organization at read; a member asks for create: refused", async () => {
    const c = await company();
    const as = w.as(c.owner);
    await as.restrict("folder", c.folder);
    await as.share("folder", c.folder, { organization: c.org }, "read");
    expect(await w.as(c.member).can("folder", c.folder, "read")).toBe(true);
    expect(await w.as(c.member).can("folder", c.folder, "create")).toBe(false);
    await refused(w.as(c.member).place("page", uid(), "folder", c.folder));
  });

  it("R4: a page restricted inside a folder the user can write: refused there, write on its siblings", async () => {
    const { as, folder, page } = await personal();
    const sibling = uid();
    await as.place("page", sibling, "folder", folder);
    const friend = await w.user();
    await as.share("folder", folder, { user: friend }, "write");
    await as.restrict("page", page);
    expect(await w.as(friend).level("page", page)).toBe(null);
    expect(await w.as(friend).level("page", sibling)).toBe("write");
  });

  it("R5: restricted folder; organization admin: delete", async () => {
    const c = await company();
    await w.as(c.owner).restrict("folder", c.folder);
    expect(await w.as(c.admin).level("page", c.page)).toBe("delete");
  });

  it("R6: restricted folder; organization owner: manage", async () => {
    const c = await company();
    await w.as(c.owner).restrict("folder", c.folder);
    expect(await w.as(c.owner).level("page", c.page)).toBe("manage");
  });

  it("R7: a grant on the restricted folder's parent does not reach it", async () => {
    const c = await company();
    const inner = uid();
    const as = w.as(c.owner);
    await as.place("folder", inner, "folder", c.folder);
    await as.restrict("folder", inner);
    const friend = await w.user();
    await as.share("folder", c.folder, { user: friend }, "manage");
    expect(await w.as(friend).level("folder", c.folder)).toBe("manage");
    expect(await w.as(friend).level("folder", inner)).toBe(null);
  });

  it("R8: a grant on a page inside a restricted folder counts on the page", async () => {
    const c = await company();
    const as = w.as(c.owner);
    await as.restrict("folder", c.folder);
    await as.share("page", c.page, { user: c.member }, "write");
    expect(await w.as(c.member).level("page", c.page)).toBe("write");
    expect(await w.as(c.member).level("folder", c.folder)).toBe(null);
  });

  it("R9: restriction removed: inheritance from above applies again", async () => {
    const c = await company();
    const as = w.as(c.owner);
    await as.restrict("folder", c.folder);
    expect(await w.as(c.member).level("page", c.page)).toBe(null);
    await as.restrict("folder", c.folder, false);
    expect(await w.as(c.member).level("page", c.page)).toBe("read");
  });

  it("R10: a restricted item owned by a user: only its own grants and the owner's manage count", async () => {
    const { as, owner, folder, page } = await personal();
    const [above, own] = [await w.user(), await w.user()];
    await as.share("folder", folder, { user: above }, "manage");
    await as.share("page", page, { user: own }, "read");
    await as.restrict("page", page);
    expect(await w.as(owner).level("page", page)).toBe("manage");
    expect(await w.as(above).level("page", page)).toBe(null);
    expect(await w.as(own).level("page", page)).toBe("read");
  });

  it("R11: a link to the folder above a restricted page: refused on the page", async () => {
    const { as, folder, page } = await personal();
    const { token } = await as.link("folder", folder, "write");
    await as.restrict("page", page);
    expect(await w.as(null, token).level("folder", folder)).toBe("write");
    expect(await w.as(null, token).level("page", page)).toBe(null);
  });

  it("a link to the restricted item itself still works", async () => {
    const { as, page } = await personal();
    await as.restrict("page", page);
    const { token } = await as.link("page", page, "read");
    expect(await w.as(null, token).level("page", page)).toBe("read");
  });

  it("nested restrictions each cut off what is above them", async () => {
    const c = await company();
    const as = w.as(c.owner);
    const inner = uid();
    const leaf = uid();
    await as.place("folder", inner, "folder", c.folder);
    await as.place("page", leaf, "folder", inner);
    await as.restrict("folder", c.folder);
    await as.restrict("folder", inner);
    const friend = await w.user();
    await as.share("folder", c.folder, { user: friend }, "write");
    expect(await w.as(friend).level("page", c.page)).toBe("write");
    expect(await w.as(friend).level("page", leaf)).toBe(null);
    await as.share("folder", inner, { user: friend }, "read");
    expect(await w.as(friend).level("page", leaf)).toBe("read");
    expect(await w.as(c.admin).level("page", leaf)).toBe("delete");
  });

  it("a restricted item at the top of an organization shuts out members but not admins", async () => {
    const c = await company();
    const top = uid();
    await w.item("folder", top, "organization", c.org, true);
    expect(await w.as(c.member).level("folder", top)).toBe(null);
    expect(await w.as(c.admin).level("folder", top)).toBe("delete");
  });

  it("a grant to the organization on the restricted item still reaches members", async () => {
    const c = await company();
    const as = w.as(c.owner);
    await as.restrict("folder", c.folder);
    await as.share("folder", c.folder, { organization: c.org }, "write");
    expect(await w.as(c.member).level("page", c.page)).toBe("write");
    expect(await w.as(c.outsider).level("page", c.page)).toBe(null);
  });

  it("restricting needs manage; a manager from above who restricts can lock themselves out", async () => {
    const { as, folder, page } = await personal();
    const [writer, manager] = [await w.user(), await w.user()];
    await as.share("folder", folder, { user: writer }, "write");
    await as.share("folder", folder, { user: manager }, "manage");
    await refused(w.as(writer).restrict("page", page));
    await w.as(manager).restrict("page", page);
    expect(await w.as(manager).level("page", page)).toBe(null);
    expect(await as.level("page", page)).toBe("manage");
  });

  it("restricting twice, or lifting a restriction that is not there, changes nothing", async () => {
    const { as, page } = await personal();
    await as.restrict("page", page, false);
    await as.restrict("page", page);
    await as.restrict("page", page);
    expect((await w.query(`select restricted from access_item where id = $1`, [page])).rows[0].restricted).toBe(true);
  });

  it("a restriction moves with its item", async () => {
    const c = await company();
    const as = w.as(c.owner);
    await as.restrict("page", c.page);
    const other = uid();
    await as.place("folder", other, "organization", c.org);
    await as.place("page", c.page, "folder", other);
    expect(await w.as(c.member).level("page", c.page)).toBe(null);
  });
});

describe("Placing", () => {
  it("P1: place a page under a folder: recorded", async () => {
    const { as, folder } = await personal();
    const page = uid();
    await as.place("page", page, "folder", folder);
    expect(await parentOf("page", page)).toEqual({ parent_kind: "folder", parent_id: folder });
  });

  it("P2: place a folder under itself: refused", async () => {
    const { as, folder } = await personal();
    await refused(as.place("folder", folder, "folder", folder), 409);
  });

  it("P3: place a folder under its own child or grandchild: refused", async () => {
    const { as, folder } = await personal();
    const [child, grandchild] = [uid(), uid()];
    await as.place("folder", child, "folder", folder);
    await as.place("folder", grandchild, "folder", child);
    await refused(as.place("folder", folder, "folder", child), 409);
    await refused(as.place("folder", folder, "folder", grandchild), 409);
    await refused(as.place("folder", child, "folder", grandchild), 409);
  });

  it("P4: two moves at the same moment that together would make a loop: one succeeds, the other is refused", async () => {
    for (let round = 0; round < 25; round++) {
      const { as, owner } = await personal();
      const [a, b] = [uid(), uid()];
      await as.place("folder", a, "user", owner);
      await as.place("folder", b, "user", owner);
      const results = await Promise.allSettled([w.as(owner).place("folder", a, "folder", b), w.as(owner).place("folder", b, "folder", a)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect((failure.reason as EndpointError).status).toBe(409);
    }
  });

  it("P5: the app's own change fails after place in the same transaction: neither is saved", async () => {
    const { as, folder } = await personal();
    const page = uid();
    await w.query(`create table if not exists pages (id text primary key)`);
    await db
      .transaction(async (tx) => {
        await as.in(tx).place("page", page, "folder", folder);
        await tx.execute(sql`insert into pages (id) values (${page})`);
        throw new Error("the app changes its mind");
      })
      .catch(() => {});
    expect(await parentOf("page", page)).toBe(null);
    expect(await count("pages", "id = $1", [page])).toBe(0);
  });

  it("P5: both commit together when the app's change succeeds", async () => {
    const { as, folder } = await personal();
    const page = uid();
    await w.query(`create table if not exists pages (id text primary key)`);
    await db.transaction(async (tx) => {
      await as.in(tx).place("page", page, "folder", folder);
      await tx.execute(sql`insert into pages (id) values (${page})`);
    });
    expect(await parentOf("page", page)).toEqual({ parent_kind: "folder", parent_id: folder });
  });

  it("P6: place an item at the top, under a user or an organization: recorded", async () => {
    const owner = await w.user();
    const mine = uid();
    await w.as(owner).place("folder", mine, "user", owner);
    expect(await parentOf("folder", mine)).toEqual({ parent_kind: "user", parent_id: owner });
    const c = await company();
    const top = uid();
    await w.as(c.admin).place("folder", top, "organization", c.org);
    expect(await parentOf("folder", top)).toEqual({ parent_kind: "organization", parent_id: c.org });
  });

  it("P6: nobody places at the top of another user, or of an organization they cannot create in", async () => {
    const c = await company();
    await refused(w.as(c.member).place("folder", uid(), "user", c.owner));
    await refused(w.as(c.member).place("folder", uid(), "organization", c.org));
    await refused(w.as(c.outsider).place("folder", uid(), "organization", c.org));
    await refused(w.as(null).place("folder", uid(), "organization", c.org));
    await refused(w.as(null).place("folder", uid(), "user", c.owner));
  });

  it("P7: the mover has write on the item and create on the new parent: recorded", async () => {
    const { as, folder, page } = await personal();
    const target = uid();
    await as.place("folder", target, "folder", folder);
    const mover = await w.user();
    await as.share("page", page, { user: mover }, "write");
    await as.share("folder", target, { user: mover }, "create");
    await w.as(mover).place("page", page, "folder", target);
    expect(await parentOf("page", page)).toEqual({ parent_kind: "folder", parent_id: target });
  });

  it("P8: the mover lacks write on the item, or create on the new parent: refused, as 404", async () => {
    const { as, folder, page } = await personal();
    const target = uid();
    await as.place("folder", target, "folder", folder);
    const mover = await w.user();
    await as.share("page", page, { user: mover }, "create");
    await as.share("folder", target, { user: mover }, "manage");
    await refused(w.as(mover).place("page", page, "folder", target));
    await as.share("page", page, { user: mover }, "write");
    await as.share("folder", target, { user: mover }, "read");
    await refused(w.as(mover).place("page", page, "folder", target));
    expect(await parentOf("page", page)).toEqual({ parent_kind: "folder", parent_id: folder });
  });

  it("creating a new item needs only create on its parent", async () => {
    const { as, folder } = await personal();
    const creator = await w.user();
    await as.share("folder", folder, { user: creator }, "create");
    const page = uid();
    await w.as(creator).place("page", page, "folder", folder);
    expect(await w.as(creator).level("page", page)).toBe("create");
    await refused(w.as(await w.user()).place("page", uid(), "folder", folder));
  });

  it("a create link lets a signed-out holder add an item, and nothing more", async () => {
    const { as, folder, page } = await personal();
    const { token } = await as.link("folder", folder, "create");
    const holder = w.as(null, token);
    const added = uid();
    await holder.place("page", added, "folder", folder);
    expect(await parentOf("page", added)).toEqual({ parent_kind: "folder", parent_id: folder });
    await refused(holder.place("page", page, "folder", folder));
  });

  it("cannot be used to move an item into a parent that is not placed", async () => {
    const { as, page } = await personal();
    await refused(as.place("page", page, "folder", uid()));
  });

  it("refuses a move that would make the tree too deep, counting what is below the item", async () => {
    const { as, owner } = await personal();
    const chain = Array.from({ length: MAX_DEPTH - 2 }, uid);
    await as.place("folder", chain[0]!, "user", owner);
    for (let i = 1; i < chain.length; i++) await as.place("folder", chain[i]!, "folder", chain[i - 1]!);
    const [x, y, z] = [uid(), uid(), uid()];
    await as.place("folder", x, "folder", chain.at(-1)!);
    await as.place("folder", y, "folder", x);
    await refused(as.place("folder", z, "folder", y), 409);
    const branch = uid();
    const twig = uid();
    await as.place("folder", branch, "user", owner);
    await as.place("folder", twig, "folder", branch);
    await refused(as.place("folder", branch, "folder", x), 409);
    await as.place("folder", branch, "folder", chain.at(-1)!);
    expect(await as.level("folder", twig)).toBe("manage");
  });

  it("placing an item where it already is changes nothing", async () => {
    const { as, folder, page } = await personal();
    await as.place("page", page, "folder", folder);
    expect(await parentOf("page", page)).toEqual({ parent_kind: "folder", parent_id: folder });
  });

  it("an item moved between organizations takes on the new one's roles", async () => {
    const [a, b] = [await company(), await company()];
    const mover = await w.user();
    await w.member(a.org, mover, "owner");
    await w.member(b.org, mover, "owner");
    await w.as(mover).place("page", a.page, "folder", b.folder);
    expect(await w.as(a.member).level("page", a.page)).toBe(null);
    expect(await w.as(b.member).level("page", a.page)).toBe("read");
  });

  it("many moves at once never store a loop", async () => {
    const { owner } = await personal();
    const ids = Array.from({ length: 12 }, uid);
    for (const id of ids) await w.as(owner).place("folder", id, "user", owner);
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % ids.length;
    for (let round = 0; round < 10; round++) {
      await Promise.allSettled(Array.from({ length: 16 }, () => w.as(owner).place("folder", ids[next()]!, "folder", ids[next()]!)));
      for (const id of ids) expect(await w.as(owner).level("folder", id), "every folder still reaches its owner").toBe("manage");
    }
  });
});

describe("Highest wins", () => {
  it("H1: read from the organization, write from a team grant: write", async () => {
    const c = await company();
    const team = await w.team(c.org);
    await w.join(team, c.member);
    await w.as(c.owner).share("page", c.page, { team }, "write");
    expect(await w.as(c.member).level("page", c.page)).toBe("write");
  });

  it("H2: delete from a role, read from a grant: delete", async () => {
    const c = await company();
    await w.as(c.owner).share("page", c.page, { user: c.admin }, "read");
    expect(await w.as(c.admin).level("page", c.page)).toBe("delete");
  });

  it("H3: read on a folder from one team, write on the page from another: write", async () => {
    const c = await company();
    const [one, two] = [await w.team(c.org), await w.team(c.org)];
    const friend = await w.user();
    await w.join(one, friend);
    await w.join(two, friend);
    await w.as(c.owner).share("folder", c.folder, { team: one }, "read");
    await w.as(c.owner).share("page", c.page, { team: two }, "write");
    expect(await w.as(friend).level("page", c.page)).toBe("write");
  });

  it("H4: the same level from several places, one revoked: unchanged", async () => {
    const c = await company();
    const team = await w.team(c.org);
    const friend = await w.user();
    await w.join(team, friend);
    const as = w.as(c.owner);
    await as.share("page", c.page, { team }, "write");
    await as.share("page", c.page, { user: friend }, "write");
    await as.share("folder", c.folder, { email: (await w.query(`select email from "user" where id = $1`, [friend])).rows[0].email }, "write");
    await as.revoke("page", c.page, { user: friend });
    expect(await w.as(friend).level("page", c.page)).toBe("write");
  });
});

describe("Endpoints and lists", () => {
  const Page = z.object({ id: z.string() });
  const endpoints = {
    readPage: endpoint({ method: "GET", path: "/api/pages/:id", input: Page, output: Page, access: { kind: "page", id: "id", level: "read" } }, ({ id }) => ({ id })),
    editPage: endpoint(
      { serve: ["api", "mcp"], method: "PUT", path: "/api/pages/:id", input: Page, output: Page, access: { kind: "page", id: "id", level: "write" } },
      ({ id }) => {
        ran.push(id);
        return { id };
      },
    ),
  };
  const ran: string[] = [];
  const api = apiHandler(endpoints)!;
  const call = async (access: Access, method: string, path: string) => {
    const response = await api.handle(new Request(`https://app.test${path}`, { method, headers: { "content-type": "application/json" }, ...(method !== "GET" && { body: "{}" }) }), { access });
    return { status: response!.status, body: await response!.json() };
  };

  it("E1: the caller has the declared level: the function runs", async () => {
    const { as, page } = await personal();
    expect(await call(as, "PUT", `/api/pages/${page}`)).toEqual({ status: 200, body: { id: page } });
    expect(ran).toContain(page);
  });

  it("E2: the caller has less: 404, and the function never runs", async () => {
    const { as, page } = await personal();
    const reader = await w.user();
    await as.share("page", page, { user: reader }, "read");
    expect(await call(w.as(reader), "GET", `/api/pages/${page}`)).toMatchObject({ status: 200 });
    expect(await call(w.as(reader), "PUT", `/api/pages/${page}`)).toMatchObject({ status: 404, body: { error: "not found" } });
    expect(ran).not.toContain(page);
  });

  it("E3: the id names no item: the same 404 as no access", async () => {
    const { as, page } = await personal();
    const stranger = w.as(await w.user());
    expect(await call(as, "GET", `/api/pages/${uid()}`)).toEqual(await call(stranger, "GET", `/api/pages/${page}`));
  });

  it("E4: an MCP call gets the same checks, and a refusal is a tool error saying not found", async () => {
    const { as, page } = await personal();
    const mcp = async (access: Access) => {
      const request = new Request("https://app.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "editPage", arguments: { id: page } } }),
      });
      return ((await (await serveMcp(request, { access }, "test", endpoints)).json()) as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };
    expect(await mcp(as)).toEqual({ content: [{ type: "text", text: JSON.stringify({ id: page }) }] });
    expect(await mcp(w.as(await w.user()))).toEqual({ isError: true, content: [{ type: "text", text: "not found" }] });
  });

  it("E5: accessible lists exactly the items a single check allows", async () => {
    const c = await company();
    const as = w.as(c.owner);
    await w.query(`create table if not exists docs (id uuid primary key)`);
    const ids = Array.from({ length: 8 }, uid);
    for (const [i, id] of ids.entries()) {
      await w.query(`insert into docs (id) values ($1)`, [id]);
      await as.place("doc", id, i % 2 ? "folder" : "organization", i % 2 ? c.folder : c.org);
    }
    await as.restrict("doc", ids[1]!);
    await as.share("doc", ids[2]!, { user: c.outsider }, "write");
    await as.restrict("folder", c.folder);
    await as.share("folder", c.folder, { user: c.outsider }, "read");
    const { token } = await as.link("doc", ids[4]!, "create");
    await w.query(`insert into docs (id) values ($1)`, [uid()]);
    for (const caller of [c.owner, c.admin, c.member, c.outsider, null]) {
      for (const link of [null, token]) {
        const access = w.as(caller, link);
        for (const level of ["read", "create", "write", "delete", "manage"] as Level[]) {
          const listed = (await db.execute(sql`select id::text as id from docs where ${await access.accessible("doc", level, sql`docs.id`)} order by id`)).rows.map((r) => r.id);
          const single = [];
          for (const id of [...ids].sort()) if (await access.can("doc", id, level)) single.push(id);
          expect(listed, `${caller} ${link} ${level}`).toEqual(single);
        }
      }
    }
  });

  it("E6: can in a hand-written route answers the same as an endpoint", async () => {
    const { as, page } = await personal();
    const reader = await w.user();
    await as.share("page", page, { user: reader }, "read");
    expect(await w.as(reader).can("page", page, "read")).toBe((await call(w.as(reader), "GET", `/api/pages/${page}`)).status === 200);
    expect(await w.as(reader).can("page", page, "write")).toBe((await call(w.as(reader), "PUT", `/api/pages/${page}`)).status === 200);
  });

  it("refuses at definition an endpoint whose access names a field its input does not have", () => {
    expect(() => endpoint({ method: "GET", path: "/api/x", input: z.object({ id: z.string() }), output: Page, access: { kind: "page", id: "pageId", level: "read" } }, () => ({ id: "" }))).toThrow(/pageId/);
  });
});

describe("Deleting", () => {
  it("D1: deleting an item takes its grants, links and place with it", async () => {
    const { as, page } = await personal();
    await as.share("page", page, { user: await w.user() }, "read");
    await as.link("page", page, "read");
    await as.remove("page", page);
    expect(await parentOf("page", page)).toBe(null);
    expect(await count("access_grant", "item_id = $1", [page])).toBe(0);
    expect(await count("access_link", "item_id = $1", [page])).toBe(0);
  });

  it("D1: inside the app's transaction, a failed delete keeps everything", async () => {
    const { as, page } = await personal();
    await as.share("page", page, { user: await w.user() }, "read");
    await db.transaction(async (tx) => {
      await as.in(tx).remove("page", page);
      throw new Error("rolled back");
    }).catch(() => {});
    expect(await count("access_grant", "item_id = $1", [page])).toBe(1);
  });

  it("D2: deleting a folder that still has children: refused until they are gone", async () => {
    const { as, folder, page } = await personal();
    await refused(as.remove("folder", folder), 409);
    await as.remove("page", page);
    await as.remove("folder", folder);
    expect(await parentOf("folder", folder)).toBe(null);
  });

  it("deleting needs delete", async () => {
    const c = await company();
    await refused(w.as(c.member).remove("page", c.page));
    await w.as(c.admin).remove("page", c.page);
  });

  it("D3: a deleted user's grants go, grants they gave stay, and their own items lose all access", async () => {
    const { as, owner, page } = await personal();
    const [friend, other] = [await w.user(), await w.user()];
    await as.share("page", page, { user: friend }, "write");
    const c = await company();
    await w.as(c.owner).share("page", c.page, { user: owner }, "manage");
    await as.share("page", c.page, { user: other }, "read");
    await w.query(`delete from "user" where id = $1`, [owner]);
    expect(await count("access_grant", "user_id = $1", [owner])).toBe(0);
    expect(await w.as(other).level("page", c.page)).toBe("read");
    expect(await w.as(friend).level("page", page)).toBe(null);
  });

  it("D4: a deleted organization's grants go, and items placed under it lose all access", async () => {
    const c = await company();
    const friend = await w.user();
    await w.as(c.owner).share("page", c.page, { user: friend }, "write");
    const elsewhere = await personal();
    await elsewhere.as.share("page", elsewhere.page, { organization: c.org }, "read");
    await w.query(`delete from organization where id = $1`, [c.org]);
    expect(await w.as(friend).level("page", c.page)).toBe(null);
    expect(await w.as(c.owner).level("page", c.page)).toBe(null);
    expect(await count("access_grant", "organization_id = $1", [c.org])).toBe(0);
  });

  it("a deleted team's grants go", async () => {
    const c = await company();
    const team = await w.team(c.org);
    await w.as(c.owner).share("page", c.page, { team }, "write");
    await w.query(`delete from team where id = $1`, [team]);
    expect(await count("access_grant", "team_id = $1", [team])).toBe(0);
  });
});

describe("Wiring", () => {
  const app = defineApp(undefined, {
    endpoints: {
      readPage: endpoint(
        { method: "GET", path: "/api/public/pages/:id", input: z.object({ id: z.string() }), output: z.object({ level: z.string().nullable() }), access: { kind: "page", id: "id", level: "read" } },
        async ({ id }, a) => ({ level: await a.access.level("page", id) }),
      ),
    },
    pool: (connectionString) => new Pool({ connectionString, max: 1 }),
  });
  const ctx = { waitUntil: () => {} };
  const get = async (path: string, headers: Record<string, string>, access = "on") => {
    const response = await app.fetch(new Request(`https://app.test${path}`, { headers }), { DB: { connectionString: url }, ACCESS: access }, ctx).catch((e: Error) => e);
    return response instanceof Response ? { status: response.status, body: await response.json() } : response.message;
  };

  it("reads a link token from the request's x-access-link header", async () => {
    const { as, page } = await personal();
    const { token } = await as.link("page", page, "write");
    expect(await get(`/api/public/pages/${page}`, { "x-access-link": token })).toEqual({ status: 200, body: { level: "write" } });
    expect(await get(`/api/public/pages/${page}`, {})).toMatchObject({ status: 404 });
    expect(await get(`/api/public/pages/${page}?link=${token}`, {})).toMatchObject({ status: 404 });
  });

  it("refuses app.access when the app has not turned access on", async () => {
    const { page } = await personal();
    expect(await get(`/api/public/pages/${page}`, {}, "off")).toMatchObject({ status: 500 });
  });
});
