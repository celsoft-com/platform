import { defineApp } from "@celsoft/platform";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

const { notes } = schema;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const columns = { id: notes.id, body: notes.body, attachmentName: notes.attachmentName, createdAt: notes.createdAt };

// Every /api route here is private, so the platform has already checked the session.
export default defineApp(
  async (request, { db, files, requireUser }) => {
    const url = new URL(request.url);
    const user = await requireUser();
    const folder = (noteId: string) => `notes/${user.id}/${noteId}`;

    if (url.pathname === "/api/notes" && request.method === "GET") {
      return Response.json(await db.select(columns).from(notes).where(eq(notes.userId, user.id)).orderBy(desc(notes.createdAt)).limit(100));
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

      const [note] = await db
        .insert(notes)
        .values({ body: body.trim(), userId: user.id, attachmentName: attachment?.name ?? null, attachmentType: attachment?.type || null })
        .returning(columns);
      if (attachment) await files.put(`${folder(note!.id)}/${attachment.name}`, attachment, attachment.type || undefined);
      return Response.json(note, { status: 201 });
    }

    const download = /^\/api\/notes\/([0-9a-f-]{36})\/attachment$/.exec(url.pathname);
    if (download && request.method === "GET") {
      const [note] = await db.select(columns).from(notes).where(and(eq(notes.id, download[1]!), eq(notes.userId, user.id)));
      if (!note?.attachmentName) return new Response("not found", { status: 404 });
      return files.response(`${folder(note.id)}/${note.attachmentName}`);
    }

    return new Response("not found", { status: 404 });
  },
  { schema },
);
