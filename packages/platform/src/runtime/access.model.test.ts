import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { random, Reference, type Grantee, type Outcome } from "../../test/access-reference.js";
import { freshDatabase, world } from "../../test/database.js";
import { LEVELS, type Level } from "./access.js";
import { EndpointError } from "./endpoint-error.js";

// Random worlds and random operations, run against Postgres and against the reference version of
// the rules side by side; every outcome and every caller's level on every item must agree.

const { db, pool } = await freshDatabase();
const w = world(db, pool);

const WORLDS = Number(process.env.ACCESS_WORLDS ?? 12);
const STEPS = Number(process.env.ACCESS_STEPS ?? 60);
const KINDS = ["folder", "page"] as const;

async function outcome(work: Promise<unknown>): Promise<Outcome> {
  try {
    await work;
    return "ok";
  } catch (error) {
    if (error instanceof EndpointError && (error.status === 404 || error.status === 409)) return error.status;
    throw error;
  }
}

// Every caller's level on every item of a kind, through accessible, in one query per caller.
async function levels(user: string | null, token: string | null, kind: string, ids: string[]): Promise<Map<string, number>> {
  const access = w.as(user, token);
  const parts = await Promise.all(LEVELS.map(async (level) => sql`(${await access.accessible(kind, level, sql`o.id`)})::int`));
  const rows = (await db.execute(sql`select o.id, ${sql.join(parts, sql` + `)} as level from access_item o where o.kind = ${kind} and o.id in ${ids}`)).rows;
  return new Map(rows.map((row) => [row.id as string, Number(row.level)]));
}

async function buildWorld(seed: number) {
  const r = random(seed);
  const ref = new Reference();
  const users: string[] = [];
  const emails: string[] = [];
  for (let i = 0; i < 6; i++) {
    const local = randomUUID();
    const email = `${r.chance(0.3) ? local.toUpperCase() : local}@example.com`;
    const verified = r.chance(0.7);
    const id = await w.user({ email, verified });
    users.push(id);
    emails.push(email.toLowerCase());
    ref.users.set(id, { email, verified });
  }
  const orgs = [await w.org(), await w.org()];
  orgs.forEach((org) => ref.orgs.add(org));
  for (const org of orgs) {
    for (const user of users) {
      if (!r.chance(0.6)) continue;
      const role = r.pick(["member", "member", "admin", "owner", "member,admin", "guest"]);
      await w.member(org, user, role);
      ref.roles.set(`${org} ${user}`, role);
    }
  }
  const teams: string[] = [];
  for (const org of orgs) {
    for (let t = 0; t < 2; t++) {
      const team = await w.team(org);
      teams.push(team);
      ref.teams.set(team, org);
      for (const user of users) {
        if (r.chance(0.4)) {
          await w.join(team, user);
          ref.teamMembers.add(`${team} ${user}`);
        }
      }
    }
  }
  return { r, ref, users, emails, orgs, teams };
}

async function compare(seed: number, step: number, ref: Reference, users: string[], tokens: string[], ids: string[]) {
  const callers: (string | null)[] = [...users, null];
  for (const user of callers) {
    for (const token of [null, ...tokens]) {
      for (const kind of KINDS) {
        const real = await levels(user, token, kind, ids);
        for (const [key, node] of ref.items) {
          if (node.kind !== kind) continue;
          expect(real.get(node.id) ?? -1, `seed ${seed} step ${step}: ${user ?? "signed out"} with ${token ? "a link" : "no link"} on ${key}`).toBe(
            ref.level(user, token, kind, node.id),
          );
        }
        expect(real.size, `seed ${seed} step ${step}: items in the database`).toBe([...ref.items.values()].filter((n) => n.kind === kind).length);
      }
    }
  }
}

describe("access against the reference rules", () => {
  for (let world = 0; world < WORLDS; world++) {
    const seed = Number(process.env.ACCESS_SEED ?? 1000) + world;
    it(`agrees on random world ${seed}`, async () => {
      const { r, ref, users, emails, orgs, teams } = await buildWorld(seed);
      const ids = Array.from({ length: 10 }, () => randomUUID());
      const tokens: string[] = [];
      const caller = () => (r.chance(0.1) ? null : r.pick(users));
      const someToken = () => (tokens.length && r.chance(0.25) ? r.pick(tokens) : null);
      const anyItem = () => ({ kind: r.pick(KINDS), id: r.pick(ids) });
      const placed = () => (ref.items.size ? r.pick([...ref.items.values()]) : anyItem());
      const grantee = (): Grantee =>
        r.pick<() => Grantee>([
          () => ({ user: r.pick(users) }),
          () => ({ team: r.pick(teams) }),
          () => ({ organization: r.pick(orgs) }),
          () => ({ email: r.chance(0.7) ? r.pick(emails) : `${randomUUID()}@example.com` }),
        ])();

      // Seed the tree through the owners, so the first steps have something to act on.
      for (const id of ids.slice(0, 3)) {
        const top = r.chance(0.5) ? { kind: "user", id: r.pick(users) } : { kind: "organization", id: r.pick(orgs) };
        const admin = top.kind === "user" ? top.id : [...ref.roles].find(([key, role]) => key.startsWith(top.id) && /owner|admin/.test(role))?.[0].split(" ")[1];
        if (!admin) continue;
        const kind = r.pick(KINDS);
        expect(await outcome(w.as(admin).place(kind, id, top.kind, top.id))).toBe(ref.place(admin, null, kind, id, top.kind, top.id));
      }

      for (let step = 0; step < STEPS; step++) {
        const user = caller();
        const token = someToken();
        const as = w.as(user, token);
        const op = r.int(10);
        const target = placed();
        let real: Outcome;
        let expected: Outcome;
        if (op <= 2) {
          const item = r.chance(0.3) ? anyItem() : target;
          const parent = r.chance(0.2) ? (r.chance(0.5) ? { kind: "user", id: user ?? r.pick(users) } : { kind: "organization", id: r.pick(orgs) }) : placed();
          real = await outcome(as.place(item.kind, item.id, parent.kind, parent.id));
          expected = ref.place(user, token, item.kind, item.id, parent.kind, parent.id);
        } else if (op === 3) {
          const on = r.chance(0.7);
          real = await outcome(as.restrict(target.kind, target.id, on));
          expected = ref.restrict(user, token, target.kind, target.id, on);
        } else if (op === 4 || op === 5) {
          const to = grantee();
          const level = r.int(5) + 1;
          real = await outcome(as.share(target.kind, target.id, to, LEVELS[level - 1]!));
          expected = ref.share(user, token, target.kind, target.id, "email" in to ? { email: to.email.toLowerCase() } : to, level);
        } else if (op === 6) {
          const to = grantee();
          real = await outcome(as.revoke(target.kind, target.id, to));
          expected = ref.revoke(user, token, target.kind, target.id, to);
        } else if (op === 7) {
          const level = r.int(3) + 1;
          const expires = r.chance(0.2) ? new Date(Date.now() - 1000) : undefined;
          let made: { token: string } | undefined;
          real = await outcome(as.link(target.kind, target.id, LEVELS[level - 1] as Level, { expires }).then((link) => (made = link)));
          expected = ref.canLink(user, token, target.kind, target.id);
          if (made) {
            ref.links.set(made.token, { kind: target.kind, id: target.id, level, expired: !!expires });
            tokens.push(made.token);
          }
        } else if (op === 8) {
          real = await outcome(as.remove(target.kind, target.id));
          expected = ref.remove(user, token, target.kind, target.id);
        } else {
          // Membership changes outside access: roles, teams and confirmed emails.
          const who = r.pick(users);
          const org = r.pick(orgs);
          const change = r.int(4);
          if (change === 0) {
            const role = r.pick(["member", "admin", "owner", "admin,member"]);
            if (ref.roles.has(`${org} ${who}`)) await w.setRole(org, who, role);
            else await w.member(org, who, role);
            ref.roles.set(`${org} ${who}`, role);
          } else if (change === 1) {
            await w.leave(org, who);
            ref.roles.delete(`${org} ${who}`);
          } else if (change === 2) {
            const team = r.pick(teams);
            if (ref.teamMembers.has(`${team} ${who}`)) {
              await w.leaveTeam(team, who);
              ref.teamMembers.delete(`${team} ${who}`);
            } else {
              await w.join(team, who);
              ref.teamMembers.add(`${team} ${who}`);
            }
          } else {
            await w.query(`update "user" set email_verified = true where id = $1`, [who]);
            ref.users.get(who)!.verified = true;
          }
          real = expected = "ok";
        }
        expect(real, `seed ${seed} step ${step}: operation ${op} by ${user ?? "signed out"}`).toBe(expected);
        if (step % 6 === 5 || step === STEPS - 1) await compare(seed, step, ref, users, tokens.slice(-2), ids);
      }

      // The single check and the list filter must agree everywhere.
      for (const node of ref.items.values()) {
        const user = caller();
        const level = await w.as(user).level(node.kind, node.id);
        expect(level ? LEVELS.indexOf(level) + 1 : 0, `seed ${seed}: single check on ${node.kind} ${node.id}`).toBe(ref.level(user, null, node.kind, node.id));
      }

      // Deleting a user takes their grants and their own items' access with them.
      const gone = r.pick(users);
      await w.query(`delete from "user" where id = $1`, [gone]);
      ref.deleteUser(gone);
      await compare(seed, STEPS, ref, users.filter((u) => u !== gone), tokens.slice(-2), ids);
    }, 120_000);
  }
});
