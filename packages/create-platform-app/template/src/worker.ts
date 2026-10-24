import { defineApp } from "@celsoft/platform";

export default defineApp(async (request, { sql }) => {
  const url = new URL(request.url);

  if (url.pathname === "/api/items" && request.method === "GET") {
    return Response.json(await sql`select id, name, created_at from items order by created_at desc limit 100`);
  }

  return new Response("not found", { status: 404 });
});
