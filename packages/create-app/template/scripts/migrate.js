import { readdir, readFile } from "node:fs/promises";
import postgres from "postgres";

const dir = new URL("../migrations/", import.meta.url);
const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });

try {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set((await sql`select name from schema_migrations`).map((row) => row.name));
  const pending = (await readdir(dir)).filter((name) => name.endsWith(".sql") && !applied.has(name)).sort();

  for (const name of pending) {
    const text = await readFile(new URL(name, dir), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${name})`;
    });
    console.log(`applied ${name}`);
  }
  if (pending.length === 0) console.log("migrations up to date");
} finally {
  await sql.end();
}
