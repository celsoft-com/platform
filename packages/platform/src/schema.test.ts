import { getTableColumns } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getAuthTables } from "better-auth/db";
import { admin, jwt, organization } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { describe, expect, it } from "vitest";
import { authSchema } from "./schema.js";

const COLUMN_TYPES: Record<string, string[]> = {
  string: ["PgText", "PgUUID"],
  boolean: ["PgBoolean"],
  date: ["PgTimestamp"],
  number: ["PgInteger"],
  "string[]": ["PgArray"],
  json: ["PgJsonb"],
};

// A Better Auth upgrade that adds or changes a field fails here, before any app sees it.
describe("auth tables", () => {
  const expected = getAuthTables({
    plugins: [admin(), organization({ teams: { enabled: true } }), jwt(), mcp({ loginPage: "/login", consentPage: "/consent", resource: "https://app.test/mcp" })],
  } as never);

  it("cover every Better Auth model", () => {
    expect(Object.keys(authSchema).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [model, table] of Object.entries(expected)) {
    it(`match Better Auth's ${model} fields`, () => {
      const columns = getTableColumns(authSchema[model as keyof typeof authSchema] as PgTable);
      for (const [field, attr] of Object.entries(table.fields)) {
        const column = columns[field];
        expect(column, `${model}.${field}`).toBeDefined();
        expect(COLUMN_TYPES[String(attr.type)], `${model}.${field} type`).toContain(column!.columnType);
        if (attr.required && attr.defaultValue === undefined) expect(column!.notNull, `${model}.${field} not null`).toBe(true);
        if (attr.unique) expect(column!.isUnique, `${model}.${field} unique`).toBe(true);
      }
    });
  }
});
