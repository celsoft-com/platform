import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import * as platformSchema from "../src/schema.js";
import { prepareAccess } from "../src/runtime/access-sql.js";
import { prepareCache } from "../src/runtime/cache.js";
import { REDIRECT_STATEMENTS } from "../src/runtime/redirects.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { sharedPostgres } from "../src/test-postgres.js";

declare module "vitest" {
  export interface ProvidedContext {
    postgres: string;
  }
}

export const TEMPLATE = "platform_template";

// Starts the test Postgres server testApp uses, and builds a template database holding the
// platform's tables, migrated the way drizzle-kit migrates an app; the server stops on its own once
// the test run is gone.
export default async function setup(project: TestProject) {
  try {
    return await start(project);
  } catch (error) {
    // Vitest can fail while printing a setup error, so it is written out here first.
    process.stderr.write(`test Postgres failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}

async function start(project: TestProject) {
  const url = await sharedPostgres(fileURLToPath(new URL("..", import.meta.url)));
  // Another run sharing the server may be building it, so one builds it under a lock and renames
  // it into place whole; it is rebuilt each run, since the platform's tables may have changed.
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext($1))", [TEMPLATE]);
    const building = `${TEMPLATE}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    await client.query(`create database ${building}`);
    const template = new Client({ connectionString: url.replace("/postgres?", `/${building}?`) });
    await template.connect();
    for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(platformSchema))) await template.query(statement);
    await prepareAccess(drizzle(template));
    await prepareCache(drizzle(template));
    for (const statement of REDIRECT_STATEMENTS) await drizzle(template).execute(statement);
    await template.end();
    await client.query(`drop database if exists ${TEMPLATE}`);
    await client.query(`alter database ${building} rename to ${TEMPLATE}`);
  } finally {
    await client.query("select pg_advisory_unlock(hashtext($1))", [TEMPLATE]).catch(() => {});
    await client.end();
  }
  project.provide("postgres", url);
}
