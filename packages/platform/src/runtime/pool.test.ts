import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { freshDatabase } from "../../test/database.js";
import { quietOnTermination } from "./pool.js";

const { url } = await freshDatabase();

describe("pools", () => {
  it("survive the server ending an idle connection, logging only an unexpected loss", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = quietOnTermination(new Pool({ connectionString: url, max: 1 }));
    const pid = (await pool.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    const other = new Pool({ connectionString: url, max: 1 });
    await other.query("select pg_terminate_backend($1)", [pid]);
    await new Promise((done) => setTimeout(done, 200));
    expect(logged).not.toHaveBeenCalled();
    expect((await pool.query("select 1 as ok")).rows[0]).toEqual({ ok: 1 });
    await Promise.all([pool.end(), other.end()]);
    logged.mockRestore();
  });
});
