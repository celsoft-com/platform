import { readFile } from "node:fs/promises";
import { Client } from "pg";

async function withClient<T>(databaseUrl: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// Runs a file of SQL in one transaction, such as test data for a preview's load test.
export async function runSqlFile(databaseUrl: string, path: string): Promise<void> {
  const text = await readFile(path, "utf8");
  await withClient(databaseUrl, async (client) => {
    await client.query("begin");
    try {
      await client.query(text);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

export interface QueryStat {
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
  query: string;
}

// The costliest statements since the counts were last cleared, from pg_stat_statements, which
// this turns on the first time; `reset` clears the counts instead, before a measured run.
export async function queryStats(databaseUrl: string, reset: boolean, limit = 15): Promise<QueryStat[]> {
  return withClient(databaseUrl, async (client) => {
    await client.query("create extension if not exists pg_stat_statements");
    if (reset) {
      await client.query("select pg_stat_statements_reset()");
      return [];
    }
    const { rows } = await client.query<{ calls: string; total: number; mean: number; rows: string; query: string }>(
      `select calls, total_exec_time as total, mean_exec_time as mean, rows, query from pg_stat_statements
       where dbid = (select oid from pg_database where datname = current_database()) and query not ilike '%pg_stat_statements%'
       order by total_exec_time desc limit $1`,
      [limit],
    );
    return rows.map((r) => ({ calls: Number(r.calls), totalMs: r.total, meanMs: r.mean, rows: Number(r.rows), query: r.query.replace(/\s+/g, " ").trim() }));
  });
}
