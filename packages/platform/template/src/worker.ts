import { defineApp, endpoint } from "@celsoft/platform";
import { desc } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./schema";

const { items } = schema;

const Item = z.object({ id: z.uuid(), name: z.string(), createdAt: z.date(), updatedAt: z.date() });

// Each endpoint is one typed function; its Zod schemas are its only types. Every /api/ path
// needs a signed-in user except those under /api/public/.
export default defineApp(undefined, {
  schema,
  endpoints: {
    listItems: endpoint(
      { method: "GET", path: "/api/public/items", description: "The newest 100 items", input: z.object({}), output: z.array(Item), access: "anon" },
      async (_, { db }) => db.select().from(items).orderBy(desc(items.createdAt)).limit(100),
    ),
  },
});
