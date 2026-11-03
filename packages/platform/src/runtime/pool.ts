// An idle pooled connection the server ends emits "error" on its pool, and with no listener that
// is an uncaught error that ends the process. A connection Postgres ended on purpose (57P01, as
// when a test's database is dropped) is expected; any other loss is logged.
export function quietOnTermination<P extends { on(event: "error", listener: (error: Error & { code?: string }) => void): unknown }>(pool: P): P {
  pool.on("error", (error) => {
    if (error.code !== "57P01") console.error(`database connection lost: ${error.message}`);
  });
  return pool;
}
