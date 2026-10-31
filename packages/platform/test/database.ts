import { randomUUID } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import { afterAll, inject } from "vitest";
import { createAccess, type AccessOptions } from "../src/runtime/access.js";
import type { EmailMessage, Mail } from "../src/runtime/email.js";
import { createOrganizations } from "../src/runtime/organizations.js";

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

// Builds people, organizations and teams, and an Access or Organizations for any caller.
// Organizations and teams are made through the platform's own calls, so their points and the
// Admins team exist as they would in an app; joining is written straight into the tables.
export function world(db: Db, pool: Pool) {
  const one = async (text: string, values: unknown[]) => (await pool.query(text, values)).rows[0];
  const w = {
    async user(options: { email?: string; verified?: boolean } = {}): Promise<string> {
      const email = options.email ?? `${randomUUID()}@example.com`;
      return (await one(`insert into "user" (name, email, email_verified) values ('Test', $1, $2) returning id`, [email, options.verified ?? true])).id;
    },
    as(userId: string | null, link: string | null = null, options: AccessOptions = {}) {
      return createAccess(db, async () => ({ userId, link }), options);
    },
    orgs(userId: string | null, mail?: Mail) {
      return createOrganizations(db, async () => ({ userId, link: null }), mail);
    },
    // An organization made by `creator`, who is its first admin.
    async org(creator: string): Promise<{ id: string; admins: string }> {
      const { id } = await w.orgs(creator).create({ name: "Org" });
      const admins = (await one(`select id from team where organization_id = $1 and admins`, [id])).id;
      return { id, admins };
    },
    async member(org: string, user: string): Promise<void> {
      await pool.query(`insert into member (organization_id, user_id) values ($1, $2)`, [org, user]);
    },
    async team(org: string, creator: string): Promise<string> {
      return (await w.orgs(creator).createTeam(org, "Team")).id;
    },
    async join(team: string, user: string): Promise<void> {
      await pool.query(`insert into team_member (team_id, user_id) values ($1, $2)`, [team, user]);
    },
    query: (text: string, values: unknown[] = []) => pool.query(text, values),
  };
  return w;
}

// A Mail that keeps what is sent, for tests; `settled` waits for what was sent after the answer.
export function capturedMail(): Mail & { sent: EmailMessage[]; settled(): Promise<void> } {
  const sent: EmailMessage[] = [];
  const pending: Promise<unknown>[] = [];
  return {
    sent,
    email: { send: async (message) => void sent.push(message) },
    origin: "https://app.test",
    appName: "Test App",
    waitUntil: (promise) => void pending.push(promise),
    settled: async () => void (await Promise.all(pending)),
  };
}
