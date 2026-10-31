import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { freshDatabase, world, capturedMail } from "../../test/database.js";
import { organizationPoint, teamPoint } from "./access.js";
import { EndpointError } from "./endpoint-error.js";
import { serveOrganizations } from "./organizations.js";

// The platform's own organizations: rows O1 onward of docs/access-rules.md, and their HTTP routes.

const { db, pool } = await freshDatabase();
const w = world(db, pool);
const uid = () => randomUUID();

const refused = async (work: Promise<unknown>, status = 404) => {
  const error = await work.then(() => undefined, (e: unknown) => e);
  expect(error, "expected a refusal").toBeInstanceOf(EndpointError);
  expect((error as EndpointError).status).toBe(status);
};

async function company() {
  const admin = await w.user();
  const { id: org, admins } = await w.org(admin);
  const [member, outsider] = [await w.user(), await w.user()];
  await w.member(org, member);
  return { org, admins, admin, member, outsider };
}

describe("Organizations", () => {
  it("O1: creating makes the organization, its member, its Admins team and its point", async () => {
    const creator = await w.user();
    const org = await w.orgs(creator).create({ name: "  Acme  ", slug: `acme-${uid().slice(0, 8)}` });
    expect(org.name).toBe("Acme");
    expect(await w.orgs(creator).teams(org.id)).toEqual([{ id: expect.any(String), name: "Admins", admins: true }]);
    expect(await w.orgs(creator).members(org.id)).toEqual([{ userId: creator, name: "Test", email: expect.any(String), admin: true }]);
    const grants = await w.as(creator).grants(organizationPoint(org.id));
    expect(grants.map((g) => [g.to, g.level])).toEqual([
      [{ organization: org.id }, "read"],
      [{ user: creator }, "manage"],
    ]);
  });

  it("O1: a slug is made from the name when none is given", async () => {
    const org = await w.orgs(await w.user()).create({ name: "Big Co. & Sons!" });
    expect(org.slug).toMatch(/^big-co-sons-[0-9a-f]{8}$/);
  });

  it("O1: creating needs a signed-in user", async () => {
    await refused(w.orgs(null).create({ name: "X" }), 401);
    await refused(w.orgs(null).list(), 401);
  });

  it("O2: list shows only the caller's organizations", async () => {
    const a = await company();
    const b = await company();
    expect((await w.orgs(a.member).list()).map((o) => o.id)).toEqual([a.org]);
    expect(await w.orgs(a.outsider).list()).toEqual([]);
    expect((await w.orgs(b.admin).list()).map((o) => o.id)).toEqual([b.org]);
  });

  it("O3: an outsider cannot see an organization, its members or teams, and cannot tell it exists", async () => {
    const c = await company();
    const orgs = w.orgs(c.outsider);
    for (const id of [c.org, uid()]) {
      for (const work of [() => orgs.get(id), () => orgs.members(id), () => orgs.teams(id), () => orgs.requireMember(id)]) await refused(work());
    }
    await w.orgs(c.member).requireMember(c.org);
    expect((await w.orgs(c.member).get(c.org)).id).toBe(c.org);
  });

  it("O4: renaming needs write and deleting needs delete on the organization's point; members have read", async () => {
    const c = await company();
    await refused(w.orgs(c.member).rename(c.org, "Mine now"));
    await refused(w.orgs(c.member).remove(c.org));
    await w.orgs(c.admin).rename(c.org, "Renamed");
    expect((await w.orgs(c.member).get(c.org)).name).toBe("Renamed");
    await w.as(c.admin).grant(organizationPoint(c.org), { user: c.member }, "write");
    await w.orgs(c.member).rename(c.org, "By member");
    await refused(w.orgs(c.member).remove(c.org));
  });

  it("O4: names are 1 to 100 characters", async () => {
    const c = await company();
    for (const name of ["", "   ", "x".repeat(101), 7 as unknown as string]) await refused(w.orgs(c.admin).rename(c.org, name), 400);
  });

  it("O5: inviting needs manage; a member cannot invite", async () => {
    const c = await company();
    await refused(w.orgs(c.member).invite(c.org, "x@example.com"));
    await refused(w.orgs(c.member).invitations(c.org));
    await refused(w.orgs(c.outsider).invite(c.org, "x@example.com"));
    const mail = capturedMail();
    const invitation = await w.orgs(c.admin, mail).invite(c.org, " X@Example.com ");
    await mail.settled();
    expect(invitation.email).toBe("x@example.com");
    expect(mail.sent).toEqual([{ to: "x@example.com", subject: "Join Org on Test App", text: `Test invited you to join Org:\n\nhttps://app.test/login?invitation=${invitation.id}\n` }]);
    expect((await w.orgs(c.admin).invitations(c.org)).map((i) => i.id)).toEqual([invitation.id]);
  });

  it("O5: inviting the same address again renews one invitation", async () => {
    const c = await company();
    const first = await w.orgs(c.admin).invite(c.org, "again@example.com");
    const second = await w.orgs(c.admin).invite(c.org, "AGAIN@example.com");
    expect(second.id).toBe(first.id);
    expect(await w.orgs(c.admin).invitations(c.org)).toHaveLength(1);
  });

  it("O5: an invitation needs a real address", async () => {
    const c = await company();
    for (const address of ["", "no-at", "a@b", "a @b.com", "x".repeat(250) + "@b.com"]) await refused(w.orgs(c.admin).invite(c.org, address), 400);
  });

  it("O6: accepting needs the signed-in person's confirmed email to match, and works once", async () => {
    const c = await company();
    const address = `${uid()}@example.com`;
    const { id } = await w.orgs(c.admin).invite(c.org, address);
    const wrong = await w.user();
    const unconfirmed = await w.user({ email: address.toUpperCase(), verified: false });
    await refused(w.orgs(wrong).accept(id));
    await refused(w.orgs(unconfirmed).accept(id));
    await refused(w.orgs(null).accept(id), 401);
    await w.query(`update "user" set email_verified = true where id = $1`, [unconfirmed]);
    expect(await w.orgs(unconfirmed).accept(id)).toBe(c.org);
    await w.orgs(unconfirmed).requireMember(c.org);
    await refused(w.orgs(unconfirmed).accept(id));
  });

  it("O6: an expired or revoked invitation is a 404", async () => {
    const c = await company();
    const address = `${uid()}@example.com`;
    const person = await w.user({ email: address });
    const { id } = await w.orgs(c.admin).invite(c.org, address);
    await w.query(`update invitation set expires_at = now() - interval '1 second' where id = $1`, [id]);
    await refused(w.orgs(person).accept(id));
    expect(await w.orgs(c.admin).invitations(c.org)).toEqual([]);
    const again = await w.orgs(c.admin).invite(c.org, address);
    await w.orgs(c.admin).revokeInvitation(c.org, again.id);
    await refused(w.orgs(person).accept(again.id));
  });

  it("O6: accepting when already a member is fine", async () => {
    const c = await company();
    const address = `${uid()}@example.com`;
    const person = await w.user({ email: address });
    await w.member(c.org, person);
    const { id } = await w.orgs(c.admin).invite(c.org, address);
    expect(await w.orgs(person).accept(id)).toBe(c.org);
  });

  it("O18: people see the invitations sent to their confirmed address, and can decline them", async () => {
    const c = await company();
    const team = await w.team(c.org, c.admin);
    const address = `${uid()}@example.com`;
    const person = await w.user({ email: address.toUpperCase() });
    const unconfirmed = await w.user({ email: `${uid()}@example.com`, verified: false });
    const { id } = await w.orgs(c.admin).invite(c.org, address, { team });
    await w.orgs(c.admin).invite(c.org, (await w.query(`select email from "user" where id = $1`, [unconfirmed])).rows[0].email);
    expect(await w.orgs(person).myInvitations()).toEqual([{ id, organizationId: c.org, organization: "Org", teamId: team, team: "Team", invitedBy: "Test", expiresAt: expect.any(Date) }]);
    expect(await w.orgs(unconfirmed).myInvitations()).toEqual([]);
    expect(await w.orgs(c.outsider).myInvitations()).toEqual([]);
    await refused(w.orgs(c.outsider).decline(id));
    await refused(w.orgs(null).myInvitations(), 401);
    await w.orgs(person).decline(id);
    expect(await w.orgs(person).myInvitations()).toEqual([]);
    await refused(w.orgs(person).accept(id));
  });

  it("O19: one team, for those who can read its point", async () => {
    const c = await company();
    const team = await w.team(c.org, c.admin);
    expect(await w.orgs(c.admin).team(team)).toEqual({ id: team, name: "Team", admins: false, organizationId: c.org });
    await refused(w.orgs(c.member).team(team));
    await refused(w.orgs(c.outsider).team(team));
    await w.join(team, c.member);
    expect((await w.orgs(c.member).team(team)).id).toBe(team);
    await refused(w.orgs(c.member).team(uid()));
  });

  it("O7: an invitation into a team adds the person to that team", async () => {
    const c = await company();
    const team = await w.team(c.org, c.admin);
    const address = `${uid()}@example.com`;
    const person = await w.user({ email: address });
    const { id } = await w.orgs(c.admin).invite(c.org, address, { team });
    await w.orgs(person).accept(id);
    expect((await w.orgs(c.admin).teamMembers(team)).map((m) => m.userId)).toEqual([person]);
  });

  it("O8: an invitation cannot name another organization's team", async () => {
    const a = await company();
    const b = await company();
    const team = await w.team(b.org, b.admin);
    await refused(w.orgs(a.admin).invite(a.org, "x@example.com", { team }));
    await refused(w.orgs(a.admin).invite(a.org, "x@example.com", { team: b.admins }));
  });

  it("O8: revoking an invitation through another organization does nothing", async () => {
    const a = await company();
    const b = await company();
    const { id } = await w.orgs(b.admin).invite(b.org, "x@example.com");
    await w.orgs(a.admin).revokeInvitation(a.org, id);
    expect(await w.orgs(b.admin).invitations(b.org)).toHaveLength(1);
  });

  it("O9: removing someone else needs manage; anyone can leave", async () => {
    const c = await company();
    const other = await w.user();
    await w.member(c.org, other);
    await refused(w.orgs(c.member).removeMember(c.org, other));
    await refused(w.orgs(c.outsider).removeMember(c.org, other));
    await w.orgs(c.member).removeMember(c.org, c.member);
    await refused(w.orgs(c.member).requireMember(c.org));
    await w.orgs(c.admin).removeMember(c.org, other);
    await refused(w.orgs(c.admin).removeMember(c.org, other));
  });

  it("O10: leaving an organization leaves its teams", async () => {
    const c = await company();
    const team = await w.team(c.org, c.admin);
    await w.join(team, c.member);
    await w.orgs(c.member).removeMember(c.org, c.member);
    expect(Number((await w.query(`select count(*) from team_member where user_id = $1`, [c.member])).rows[0].count)).toBe(0);
  });

  it("O11: creating a team needs create on the organization's point; the team gets write on its point", async () => {
    const c = await company();
    await refused(w.orgs(c.member).createTeam(c.org, "Mine"));
    await w.as(c.admin).grant(organizationPoint(c.org), { organization: c.org }, "create");
    const team = await w.orgs(c.member).createTeam(c.org, "Mine");
    expect(team).toEqual({ id: expect.any(String), name: "Mine", admins: false });
    const grants = await w.as(c.member).grants(teamPoint(team.id));
    expect(grants.map((g) => [g.to, g.level])).toEqual([
      [{ team: team.id }, "write"],
      [{ user: c.member }, "manage"],
    ]);
  });

  it("O12: managing a team's members needs manage on the team's point; anyone can leave a team", async () => {
    const c = await company();
    const team = await w.team(c.org, c.admin);
    const other = await w.user();
    await w.member(c.org, other);
    await w.join(team, c.member);
    await refused(w.orgs(c.member).addToTeam(team, other));
    await refused(w.orgs(c.member).removeFromTeam(team, c.admin));
    await w.orgs(c.admin).addToTeam(team, other);
    await w.orgs(other).removeFromTeam(team, other);
    expect((await w.orgs(c.admin).teamMembers(team)).map((m) => m.userId)).toEqual([c.member]);
  });

  it("O12: renaming and deleting a team need write and delete on its point", async () => {
    const c = await company();
    const team = await w.team(c.org, c.admin);
    await w.join(team, c.member);
    await w.orgs(c.member).renameTeam(team, "By member");
    await refused(w.orgs(c.member).removeTeam(team));
    await refused(w.orgs(c.outsider).renameTeam(team, "Nope"));
    await w.orgs(c.admin).removeTeam(team);
    await refused(w.orgs(c.admin).teamMembers(team));
  });

  it("O13: only the organization's members can join its teams", async () => {
    const c = await company();
    const team = await w.team(c.org, c.admin);
    await refused(w.orgs(c.admin).addToTeam(team, c.outsider));
    await refused(w.orgs(c.admin).addToTeam(team, uid()));
    await refused(w.orgs(c.admin).addToTeam(c.admins, c.outsider));
  });

  it("O14: slugs are unique and well formed", async () => {
    const creator = await w.user();
    const slug = `taken-${uid().slice(0, 8)}`;
    await w.orgs(creator).create({ name: "One", slug });
    await refused(w.orgs(creator).create({ name: "Two", slug }), 409);
    for (const bad of ["-x", "x-", "UPPER", "a b", "", "x".repeat(65), "a/b"]) await refused(w.orgs(creator).create({ name: "Bad", slug: bad }), 400);
  });

  it("O15: ids that are not UUIDs name nothing: a 404, never a server error", async () => {
    const c = await company();
    const orgs = w.orgs(c.admin);
    for (const bad of ["x", "'; drop table organization; --", "", "00000000-0000-0000-0000-00000000000g"]) {
      await refused(orgs.get(bad));
      await refused(orgs.members(bad));
      await refused(orgs.removeMember(c.org, bad));
      await refused(orgs.accept(bad));
      await refused(orgs.addToTeam(bad, c.member));
      await refused(orgs.removeTeam(bad));
    }
  });

  it("O16: deleting an organization deletes its teams, members, invitations and points", async () => {
    const c = await company();
    const team = await w.team(c.org, c.admin);
    await w.orgs(c.admin).invite(c.org, "x@example.com");
    await w.orgs(c.admin).remove(c.org);
    for (const [table, column] of [["member", "organization_id"], ["team", "organization_id"], ["invitation", "organization_id"], ["access_point", "organization_id"]]) {
      expect(Number((await w.query(`select count(*) from ${table} where ${column} = $1`, [c.org])).rows[0].count), table).toBe(0);
    }
    expect(Number((await w.query(`select count(*) from access_point where id = $1`, [teamPoint(team)])).rows[0].count)).toBe(0);
  });
});

describe("Organization routes", () => {
  const call = async (userId: string | null, method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
    const response = await serveOrganizations(new Request(`https://app.test${path}`, init), path, w.orgs(userId));
    return { status: response.status, body: await response.json() };
  };

  it("O17: create, list, rename, teams and members through the routes", async () => {
    const admin = await w.user();
    const created = await call(admin, "POST", "/api/platform/organizations", { name: "Route Co" });
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect((await call(admin, "GET", "/api/platform/organizations")).body.map((o: { id: string }) => o.id)).toEqual([id]);
    expect((await call(admin, "PATCH", `/api/platform/organizations/${id}`, { name: "Renamed" })).status).toBe(200);
    expect((await call(admin, "GET", `/api/platform/organizations/${id}`)).body.name).toBe("Renamed");
    const team = await call(admin, "POST", `/api/platform/organizations/${id}/teams`, { name: "Crew" });
    expect(team.status).toBe(201);
    expect((await call(admin, "GET", `/api/platform/organizations/${id}/teams`)).body).toHaveLength(2);
    const member = await w.user();
    await w.member(id, member);
    expect((await call(admin, "POST", `/api/platform/teams/${team.body.id}/members`, { user: member })).status).toBe(201);
    expect((await call(admin, "GET", `/api/platform/teams/${team.body.id}/members`)).body.map((m: { userId: string }) => m.userId)).toEqual([member]);
    expect((await call(admin, "DELETE", `/api/platform/teams/${team.body.id}/members/${member}`)).status).toBe(200);
    expect((await call(admin, "DELETE", `/api/platform/teams/${team.body.id}`)).status).toBe(200);
  });

  it("O17: invitations through the routes, accepted by the invited person", async () => {
    const c = await company();
    const address = `${uid()}@example.com`;
    const person = await w.user({ email: address });
    const invited = await call(c.admin, "POST", `/api/platform/organizations/${c.org}/invitations`, { email: address });
    expect(invited.status).toBe(201);
    expect((await call(person, "GET", "/api/platform/invitations")).body.map((i: { id: string }) => i.id)).toEqual([invited.body.id]);
    expect(await call(person, "POST", `/api/platform/invitations/${invited.body.id}/accept`, {})).toEqual({ status: 200, body: { organizationId: c.org } });
    const again = await call(c.admin, "POST", `/api/platform/organizations/${c.org}/invitations`, { email: "someone@example.com" });
    expect((await call(person, "DELETE", `/api/platform/invitations/${again.body.id}`)).status).toBe(404);
    expect((await call(c.admin, "GET", `/api/platform/organizations/${c.org}/members`)).body).toHaveLength(3);
  });

  it("O17: refusals keep their status, with an error message and nothing more", async () => {
    const c = await company();
    expect(await call(c.outsider, "GET", `/api/platform/organizations/${c.org}`)).toEqual({ status: 404, body: { error: "not found" } });
    expect(await call(c.member, "DELETE", `/api/platform/organizations/${c.org}`)).toEqual({ status: 404, body: { error: "not found" } });
    expect((await call(c.admin, "DELETE", `/api/platform/organizations/${c.org}/members/${c.admin}`)).status).toBe(409);
    expect((await call(null, "GET", "/api/platform/organizations")).status).toBe(401);
  });

  it("O17: unknown paths and methods, bad JSON and bad encodings are refused cleanly", async () => {
    const c = await company();
    expect((await call(c.admin, "GET", "/api/platform/nothing")).status).toBe(404);
    expect((await call(c.admin, "PUT", `/api/platform/organizations/${c.org}`, {})).status).toBe(404);
    expect((await call(c.admin, "GET", `/api/platform/organizations/${c.org}/members/extra/parts`)).status).toBe(404);
    expect((await call(c.admin, "POST", "/api/platform/organizations", "{not json")).status).toBe(400);
    expect((await call(c.admin, "POST", "/api/platform/organizations", "[1,2]")).status).toBe(400);
    expect((await call(c.admin, "POST", "/api/platform/organizations", "null")).status).toBe(400);
    expect((await call(c.admin, "POST", "/api/platform/organizations", {})).status).toBe(400);
    expect((await call(c.admin, "GET", "/api/platform/organizations/%E0%A4%A")).status).toBe(404);
    expect((await call(c.admin, "POST", `/api/platform/organizations/${c.org}/invitations`, { email: ["a@b.com"] })).status).toBe(400);
    expect((await call(c.admin, "POST", `/api/platform/teams/${c.admins}/members`, { user: { $ne: null } })).status).toBe(404);
  });
});
