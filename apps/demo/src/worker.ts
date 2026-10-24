import postgres from "postgres";

interface Env {
  DB: Hyperdrive;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });

    const sql = postgres(env.DB.connectionString, { max: 5, fetch_types: false });
    try {
      return await api(request, url, sql);
    } finally {
      ctx.waitUntil(sql.end());
    }
  },
} satisfies ExportedHandler<Env>;

async function api(request: Request, url: URL, sql: postgres.Sql): Promise<Response> {
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
}
