import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import * as platformSchema from "../src/schema.js";
import { prepareAccess } from "../src/runtime/access-sql.js";
import { drizzle } from "drizzle-orm/node-postgres";

declare module "vitest" {
  export interface ProvidedContext {
    postgres: string;
  }
}

export const TEMPLATE = "platform_template";

// Starts a private Postgres listening only on a socket in a temporary folder, and builds a template
// database holding the platform's tables, migrated the way drizzle-kit migrates an app.
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
  const dir = await mkdtemp(join(tmpdir(), "pg-"));
  const data = join(dir, "data");
  const log = join(dir, "log");
  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C", "--no-instructions"]);
  try {
    run("pg_ctl", ["-D", data, "-l", log, "-w", "-o", `-k ${dir} -c listen_addresses='' -c fsync=off -c max_connections=200`, "start"]);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${await readFile(log, "utf8").catch(() => "")}`);
  }
  const url = `postgresql://postgres@localhost/postgres?host=${encodeURIComponent(dir)}`;

  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`create database ${TEMPLATE}`);
  await client.end();
  const template = new Client({ connectionString: url.replace("/postgres?", `/${TEMPLATE}?`) });
  await template.connect();
  for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(platformSchema))) await template.query(statement);
  await prepareAccess(drizzle(template));
  await template.end();

  project.provide("postgres", url);
  return async () => {
    run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    await rm(dir, { recursive: true, force: true });
  };
}

// Fails with the tool's own output, since a bare exit code says nothing on a CI runner.
function run(command: string, args: string[]): void {
  try {
    execFileSync(command, args, { stdio: "pipe", encoding: "utf8" });
  } catch (error) {
    const { stdout = "", stderr = "", message } = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(`${command} failed: ${message}\n${stdout}${stderr}`);
  }
}
