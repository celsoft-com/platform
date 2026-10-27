import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { random, Reference, type RefGrant } from "../../test/access-reference.js";
import { freshDatabase, world } from "../../test/database.js";
import { LEVELS } from "./access.js";

// Random worlds written straight into the tables, odd states included (grants to other
// organizations, team rows left behind, unconfirmed emails, expired links), checked against the
// reference version of the rules: every caller's level on every point must agree, through both
// the list filter and single checks, and again after the memberships churn.

const { db, pool } = await freshDatabase();
const w = world(db, pool);

const WORLDS = Number(process.env.ACCESS_WORLDS ?? 10);
const ROUNDS = Number(process.env.ACCESS_ROUNDS ?? 3);

async function insertGrant(g: RefGrant): Promise<void> {
  const cols = {
    user: "user" in g ? g.user : null,
    team: "team" in g ? g.team : null,
    organization: "organization" in g ? g.organization : null,
    everyone: "everyone" in g ? true : null,
    email: "email" in g ? g.email : null,
  };
  await w.query(
    `insert into access_grant (point_id, user_id, team_id, organization_id, everyone, email, level) values ($1, $2, $3, $4, $5, $6, $7)
     on conflict on constraint access_grant_once do update set level = excluded.level`,
    [g.point, cols.user, cols.team, cols.organization, cols.everyone, cols.email, g.level],
  );
}

async function buildWorld(seed: number) {
  const r = random(seed);
  const ref = new Reference();
  const users: string[] = [];
  for (let i = 0; i < 6; i++) {
    const local = randomUUID();
    const email = `${r.chance(0.3) ? local.toUpperCase() : local}@example.com`;
    const verified = r.chance(0.7);
    const id = await w.user({ email, verified });
    users.push(id);
    ref.users.set(id, { email, verified });
  }

  const orgs: string[] = [];
  for (let i = 0; i < 2; i++) {
    const org = (await w.query(`insert into organization (name, slug) values ('Org', $1) returning id`, [randomUUID()])).rows[0].id as string;
    orgs.push(org);
    await w.query(`insert into access_point (id, organization_id, for_organization) values ($1, $2, $2)`, [`organization:${org}`, org]);
    ref.points.set(`organization:${org}`, { id: `organization:${org}`, parent: null, inherits: false, organization: org });
  }
  for (const org of orgs) for (const user of users) if (r.chance(0.6)) {
    await w.member(org, user);
    ref.members.add(`${org} ${user}`);
  }

  const teams: string[] = [];
  for (const org of orgs) {
    for (const admins of [true, false, false]) {
      const team = (await w.query(`insert into team (name, organization_id, admins) values ('T', $1, $2) returning id`, [org, admins])).rows[0].id as string;
      teams.push(team);
      ref.teams.set(team, { organization: org, admins });
      const point = `team:${team}`;
      const inherits = r.chance(0.4);
      await w.query(`insert into access_point (id, parent_id, organization_id, for_team, inherits) values ($1, $2, $3, $4, $5)`, [point, `organization:${org}`, org, team, inherits]);
      ref.points.set(point, { id: point, parent: `organization:${org}`, inherits, organization: org });
      // Mostly members of the organization, sometimes a row left behind by someone who is not.
      for (const user of users) if (r.chance(0.3) && (ref.members.has(`${org} ${user}`) || r.chance(0.3))) {
        await w.join(team, user);
        ref.teamMembers.add(`${team} ${user}`);
      }
    }
  }

  const ids = [...ref.points.keys()];
  for (let i = 0; i < 18; i++) {
    const id = `p${i}-${randomUUID()}`;
    const parent = r.chance(0.15) ? null : r.pick(ids);
    const organization = parent ? ref.points.get(parent)!.organization : null;
    const inherits = r.chance(0.6);
    await w.query(`insert into access_point (id, parent_id, organization_id, inherits) values ($1, $2, $3, $4)`, [id, parent, organization, inherits]);
    ref.points.set(id, { id, parent, inherits, organization });
    ids.push(id);
  }

  const grantees = (): RefGrant[] => {
    const point = r.pick(ids);
    const level = 1 + r.int(5);
    const user = r.pick(users);
    return [
      { point, level, user },
      { point, level, team: r.pick(teams) },
      { point, level, organization: r.pick(orgs) },
      { point, level, email: ref.users.get(user)!.email.toLowerCase() },
      { point, level: 1, everyone: true },
    ];
  };
  for (let i = 0; i < 45; i++) {
    const g = r.pick(grantees());
    const key = JSON.stringify({ ...g, level: 0 });
    ref.grants = ref.grants.filter((x) => JSON.stringify({ ...x, level: 0 }) !== key);
    ref.grants.push(g);
    await insertGrant(g);
  }

  const tokens: (string | null)[] = [null];
  for (let i = 0; i < 4; i++) {
    const token = randomUUID();
    const point = r.pick(ids);
    const level = 1 + r.int(3);
    const expired = r.chance(0.25);
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
    await w.query(`insert into access_link (point_id, token_hash, level, expires_at) values ($1, $2, $3, $4)`, [point, hash, level, expired ? new Date(Date.now() - 1000) : null]);
    ref.links.set(token, { point, level, expired });
    tokens.push(token);
  }
  return { r, ref, users, orgs, teams, ids, tokens };
}

// Every point's level for one caller in one query, summing the list filter at each level.
async function filtered(user: string | null, token: string | null, ids: string[]): Promise<Map<string, number>> {
  const access = w.as(user, token);
  const parts = await Promise.all(LEVELS.map(async (level) => sql`(${await access.allows(level, sql`p.id`)})::int`));
  const found = (await db.execute(sql`select p.id, ${sql.join(parts, sql` + `)} as level from access_point p where p.id in ${ids}`)).rows;
  return new Map(found.map((row) => [row.id as string, Number(row.level)]));
}

async function compare(world: Awaited<ReturnType<typeof buildWorld>>, seed: number, round: number): Promise<void> {
  const { ref, users, ids, tokens } = world;
  for (const user of [...users, null]) {
    for (const token of tokens) {
      const listed = await filtered(user, token, ids);
      for (const id of ids) {
        expect(listed.get(id), `seed ${seed} round ${round}: ${user} ${token} on ${id}`).toBe(ref.level(user, token, id));
      }
    }
    for (const id of ids.slice(0, 6)) {
      const single = await w.as(user, tokens[1] ?? null).level(id);
      expect(single ? LEVELS.indexOf(single) + 1 : 0, `seed ${seed} single ${user} on ${id}`).toBe(ref.level(user, tokens[1] ?? null, id));
    }
  }
}

// Joins, leaves, confirmations and grant changes between rounds.
async function churn(world: Awaited<ReturnType<typeof buildWorld>>): Promise<void> {
  const { r, ref, users, orgs, teams, ids } = world;
  for (let i = 0; i < 8; i++) {
    const user = r.pick(users);
    const step = r.int(6);
    if (step === 0) {
      const org = r.pick(orgs);
      if (ref.members.delete(`${org} ${user}`)) await w.query(`delete from member where organization_id = $1 and user_id = $2`, [org, user]);
      else {
        await w.member(org, user);
        ref.members.add(`${org} ${user}`);
      }
    } else if (step === 1) {
      const team = r.pick(teams);
      if (ref.teamMembers.delete(`${team} ${user}`)) await w.query(`delete from team_member where team_id = $1 and user_id = $2`, [team, user]);
      else {
        await w.join(team, user);
        ref.teamMembers.add(`${team} ${user}`);
      }
    } else if (step === 2) {
      const person = ref.users.get(user)!;
      person.verified = !person.verified;
      await w.query(`update "user" set email_verified = $2 where id = $1`, [user, person.verified]);
    } else if (step === 3 && ref.grants.length > 0) {
      const g = ref.grants.splice(r.int(ref.grants.length), 1)[0]!;
      await w.query(
        `delete from access_grant where point_id = $1 and user_id is not distinct from $2 and team_id is not distinct from $3 and organization_id is not distinct from $4 and everyone is not distinct from $5 and email is not distinct from $6`,
        [g.point, "user" in g ? g.user : null, "team" in g ? g.team : null, "organization" in g ? g.organization : null, "everyone" in g ? true : null, "email" in g ? g.email : null],
      );
    } else if (step === 4) {
      const id = r.pick(ids.filter((x) => !x.startsWith("organization:")));
      const point = ref.points.get(id)!;
      point.inherits = !point.inherits;
      await w.query(`update access_point set inherits = $2 where id = $1`, [id, point.inherits]);
    } else {
      // A move under another point of the same organization, never under itself or below it.
      const id = r.pick(ids.filter((x) => x.startsWith("p")));
      const point = ref.points.get(id)!;
      const below = (x: string): boolean => {
        for (let at: string | null = x; at; at = ref.points.get(at)!.parent) if (at === id) return true;
        return false;
      };
      const targets = ids.filter((x) => !below(x) && ref.points.get(x)!.organization === point.organization);
      if (targets.length === 0) continue;
      const parent = r.pick(targets);
      point.parent = parent;
      await w.query(`update access_point set parent_id = $2 where id = $1`, [id, parent]);
    }
  }
}

describe("random worlds against the reference rules", () => {
  for (let seed = 1; seed <= WORLDS; seed++) {
    // Each world runs thousands of queries, which a busy machine running every test file at once can slow well past the default limit.
    it(`world ${seed}`, { timeout: 60_000 }, async () => {
      const world = await buildWorld(seed * 7919);
      for (let round = 0; round < ROUNDS; round++) {
        await compare(world, seed, round);
        await churn(world);
      }
    });
  }
});
