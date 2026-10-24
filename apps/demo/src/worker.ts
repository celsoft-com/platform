import { defineApp } from "@celsoft/platform";

export default defineApp(async (request, { sql, session }) => {
  const url = new URL(request.url);
  if (url.pathname !== "/api/notes") return new Response("not found", { status: 404 });

  const current = await session();
  if (!current) return Response.json({ error: "sign in first" }, { status: 401 });
  const userId = current.user.id;

  if (request.method === "GET") {
    const notes = await sql`select id, body, created_at from notes where user_id = ${userId} order by created_at desc limit 100`;
    return Response.json(notes);
  }

  if (request.method === "POST") {
    const { body } = await request.json<{ body?: unknown }>();
    if (typeof body !== "string" || body.trim() === "" || body.length > 10000) {
      return Response.json({ error: "body must be 1 to 10000 characters" }, { status: 400 });
    }
    const [note] = await sql`insert into notes (body, user_id) values (${body.trim()}, ${userId}) returning id, body, created_at`;
    return Response.json(note, { status: 201 });
  }

  return new Response("method not allowed", { status: 405 });
});
