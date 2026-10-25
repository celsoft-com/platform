import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A throwaway Postgres 18 for the tests that need a real database, from mise's pinned binaries.
    globalSetup: ["packages/platform/test/postgres.ts"],
  },
});
