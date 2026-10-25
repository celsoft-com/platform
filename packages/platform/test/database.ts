import { randomUUID } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { afterAll, inject } from "vitest";
import { createAccess } from "../src/runtime/access.js";

// A fresh database per test file, copied from the template the global setup migrated.
export async function freshDatabase(): Promise<{ db: NodePgDatabase<Record<string, unknown>>; pool: Pool; url: string }> {
  const server = inject("postgres");
  const name = `t_${randomUUID().replace(/-/g, "")}`;
  const admin = new Client({ connectionString: server });
  await admin.connect();
  await admin.query(`create database ${name} template platform_template`);
  await admin.end();
  const url = server.replace("/postgres?", `/${name}?`);
  const pool = new Pool({ connectionString: url, max: 20 });
  afterAll(() => pool.end());
  return { db: drizzle(pool), pool, url };
}

export type Db = NodePgDatabase<Record<string, unknown>>;

// Builds people, organizations and teams straight into Better Auth's tables, and an Access for any
// caller.
export function world(db: Db, pool: Pool) {
  const one = async (text: string, values: unknown[]) => (await pool.query(text, values)).rows[0];
  return {
    async user(options: { email?: string; verified?: boolean } = {}): Promise<string> {
      const email = options.email ?? `${randomUUID()}@example.com`;
      return (await one(`insert into "user" (name, email, email_verified) values ('Test', $1, $2) returning id`, [email, options.verified ?? true])).id;
    },
    async org(): Promise<string> {
      return (await one(`insert into organization (name, slug) values ('Org', $1) returning id`, [randomUUID()])).id;
    },
    async member(org: string, user: string, role = "member"): Promise<void> {
      await pool.query(`insert into member (organization_id, user_id, role) values ($1, $2, $3)`, [org, user, role]);
    },
    async setRole(org: string, user: string, role: string): Promise<void> {
      await pool.query(`update member set role = $3 where organization_id = $1 and user_id = $2`, [org, user, role]);
    },
    async leave(org: string, user: string): Promise<void> {
      await pool.query(`delete from member where organization_id = $1 and user_id = $2`, [org, user]);
    },
    async team(org: string): Promise<string> {
      return (await one(`insert into team (name, organization_id) values ('Team', $1) returning id`, [org])).id;
    },
    async join(team: string, user: string): Promise<void> {
      await pool.query(`insert into team_member (team_id, user_id) values ($1, $2)`, [team, user]);
    },
    async leaveTeam(team: string, user: string): Promise<void> {
      await pool.query(`delete from team_member where team_id = $1 and user_id = $2`, [team, user]);
    },
    // Writes an item straight into the tree, skipping place's checks, to set up a case quickly.
    async item(kind: string, id: string, parentKind: string, parentId: string, restricted = false): Promise<void> {
      await pool.query(`insert into access_item (kind, id, parent_kind, parent_id, restricted) values ($1, $2, $3, $4, $5)`, [kind, id, parentKind, parentId, restricted]);
    },
    as(userId: string | null, link: string | null = null) {
      return createAccess(db, async () => ({ userId, link }));
    },
    query: (text: string, values: unknown[] = []) => pool.query(text, values),
  };
}
