import { defineApp } from "@celsoft/platform";

const MAX_ATTACHMENT = 10 * 1024 * 1024;

export default defineApp(async (request, { sql, files, session }) => {
  const url = new URL(request.url);
  const current = await session();
  if (!current) return Response.json({ error: "sign in first" }, { status: 401 });
  const userId = current.user.id;
  const folder = (noteId: string) => `notes/${userId}/${noteId}`;

  if (url.pathname === "/api/notes" && request.method === "GET") {
    const notes = await sql`select id, body, attachment_name, created_at from notes where user_id = ${userId} order by created_at desc limit 100`;
    return Response.json(notes);
  }

  if (url.pathname === "/api/notes" && request.method === "POST") {
    const form = await request.formData();
    const body = form.get("body");
    const file = form.get("file");
    if (typeof body !== "string" || body.trim() === "" || body.length > 10000) {
      return Response.json({ error: "body must be 1 to 10000 characters" }, { status: 400 });
    }
    const attachment = file instanceof File && file.size > 0 ? file : undefined;
    if (attachment && attachment.size > MAX_ATTACHMENT) {
      return Response.json({ error: "attachments are limited to 10 MB" }, { status: 400 });
    }

    const [note] = await sql`
      insert into notes (body, user_id, attachment_name, attachment_type)
      values (${body.trim()}, ${userId}, ${attachment?.name ?? null}, ${attachment?.type || null})
      returning id, body, attachment_name, created_at`;
    if (attachment) await files.put(`${folder(note!.id)}/${attachment.name}`, attachment, attachment.type || undefined);
    return Response.json(note, { status: 201 });
  }

  const download = /^\/api\/notes\/(\d+)\/attachment$/.exec(url.pathname);
  if (download && request.method === "GET") {
    const [note] = await sql`select id, attachment_name from notes where id = ${download[1]!} and user_id = ${userId}`;
    if (!note?.attachment_name) return new Response("not found", { status: 404 });
    return files.response(`${folder(note.id)}/${note.attachment_name}`);
  }

  return new Response("not found", { status: 404 });
});
