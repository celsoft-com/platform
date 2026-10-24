import { defineApp } from "@celsoft/platform";

export default defineApp(async (request, { sql }) => {
  const url = new URL(request.url);

  if (url.pathname === "/api/notes" && request.method === "GET") {
    const notes = await sql`select id, body, created_at from notes order by created_at desc limit 100`;
    return Response.json(notes);
  }

  if (url.pathname === "/api/notes" && request.method === "POST") {
    const { body } = await request.json<{ body?: unknown }>();
    if (typeof body !== "string" || body.trim() === "" || body.length > 10000) {
      return Response.json({ error: "body must be 1 to 10000 characters" }, { status: 400 });
    }
    const [note] = await sql`insert into notes (body) values (${body.trim()}) returning id, body, created_at`;
    return Response.json(note, { status: 201 });
  }

  return new Response("not found", { status: 404 });
});
