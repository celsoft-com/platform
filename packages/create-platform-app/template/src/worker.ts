import { defineApp } from "@celsoft/platform";
import { desc } from "drizzle-orm";
import * as schema from "./schema";

const { items } = schema;

export default defineApp(
  async (request, { db }) => {
    const url = new URL(request.url);

    if (url.pathname === "/api/items" && request.method === "GET") {
      return Response.json(await db.select().from(items).orderBy(desc(items.createdAt)).limit(100));
    }

    return new Response("not found", { status: 404 });
  },
  { schema },
);
