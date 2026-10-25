import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import * as platformSchema from "../src/schema.js";

declare module "vitest" {
  export interface ProvidedContext {
    postgres: string;
  }
}

export const TEMPLATE = "platform_template";

// Starts a private Postgres listening only on a socket in a temporary folder, and builds a template
// database holding the platform's tables, migrated the way drizzle-kit migrates an app.
export default async function setup(project: TestProject) {
  const dir = await mkdtemp(join(tmpdir(), "pg-"));
  const data = join(dir, "data");
  execFileSync("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-instructions"], { stdio: "ignore" });
  execFileSync("pg_ctl", ["-D", data, "-l", join(dir, "log"), "-w", "-o", `-k ${dir} -c listen_addresses='' -c fsync=off -c max_connections=200`, "start"], { stdio: "ignore" });
  const url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(dir)}`;

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`create database ${TEMPLATE}`);
  await client.end();
  const template = new Client({ connectionString: url.replace("/postgres?", `/${TEMPLATE}?`) });
  await template.connect();
  for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(platformSchema))) await template.query(statement);
  await template.end();

  project.provide("postgres", url);
  return async () => {
    execFileSync("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
    await rm(dir, { recursive: true, force: true });
  };
}
