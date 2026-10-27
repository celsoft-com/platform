import { defineApp, endpoint, EndpointError, organizationPoint, type AppContext, type PlatformBindings } from "@celsoft/platform";
import { user as users } from "@celsoft/platform/schema";
import { and, desc, eq, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./schema";

const { notes } = schema;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const columns = { id: notes.id, body: notes.body, attachmentName: notes.attachmentName, createdAt: notes.createdAt };
const orgColumns = { id: notes.id, body: notes.body, createdAt: notes.createdAt, author: users.name };
const ORG_ROOM = /^organization:[0-9a-f-]{36}$/;

type App = AppContext<PlatformBindings, typeof schema>;

// Every note is a control point named by its id. A personal note stands alone, so only its author
// and whoever they share it with can see it; an organization's note inherits from the
// organization's point, which the demo grants its members `create` on.

// A note as anyone who can open it sees it, with the level they have on it.
const SharedNote = z.object({ id: z.uuid(), body: z.string(), attachmentName: z.string().nullable(), createdAt: z.date(), author: z.string(), level: z.string() });
const NoteId = z.object({ id: z.uuid() });

async function sharedNote(app: App, id: string) {
  const [note] = await app.db.select({ ...columns, author: users.name }).from(notes).innerJoin(users, eq(users.id, notes.userId)).where(eq(notes.id, id));
  if (!note) throw new EndpointError(404, "not found");
  return { ...note, level: await app.access.check(id) };
}

const OrgNote = z.object({ id: z.uuid(), body: z.string(), createdAt: z.date(), author: z.string() });
const Org = z.object({ id: z.uuid(), name: z.string() });
const OrgId = z.object({ organization: z.uuid() });

// Everything said in an organization's room: new notes from the server, typing notices from browsers.
const OrgMessage = z.discriminatedUnion("type", [z.object({ type: z.literal("note"), note: OrgNote }), z.object({ type: z.literal("typing") })]);

// An organization's room is named after its control point, so whoever can read the organization may join.
async function inOrgRoom(room: string, _user: unknown, app: App): Promise<boolean> {
  return ORG_ROOM.test(room) && (await app.access.level(room)) !== null;
}

// Every hand-written /api route here is private, so the platform has already checked the session.
export default defineApp(
  async (request, app) => {
    const { db, files, requireUser } = app;
    const url = new URL(request.url);
    const user = await requireUser();
    const folder = (noteId: string) => `notes/${user.id}/${noteId}`;

    if (url.pathname === "/api/notes" && request.method === "GET") {
      const mine = and(eq(notes.userId, user.id), isNull(notes.organizationId));
      return Response.json(await db.select(columns).from(notes).where(mine).orderBy(desc(notes.createdAt)).limit(100));
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

      const note = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(notes)
          .values({ body: body.trim(), userId: user.id, attachmentName: attachment?.name ?? null, attachmentType: attachment?.type || null })
          .returning(columns);
        await app.access.in(tx).create(inserted!.id);
        return inserted;
      });
      if (attachment) await files.put(`${folder(note!.id)}/${attachment.name}`, attachment, attachment.type || undefined);
      return Response.json(note, { status: 201 });
    }

    const download = /^\/api\/notes\/([0-9a-f-]{36})\/attachment$/.exec(url.pathname);
    if (download && request.method === "GET") {
      await app.access.check(download[1]!);
      const [note] = await db.select({ ...columns, userId: notes.userId }).from(notes).where(eq(notes.id, download[1]!));
      if (!note?.attachmentName) return new Response("not found", { status: 404 });
      return files.response(`notes/${note.userId}/${note.id}/${note.attachmentName}`);
    }

    return new Response("not found", { status: 404 });
  },
  {
    schema,
    live: { message: OrgMessage, canJoin: inOrgRoom, canSend: inOrgRoom },
    endpoints: {
      // Public paths, so a signed-out visitor holding a link can read or edit the note it opens.
      getNote: endpoint({ method: "GET", path: "/api/public/notes/:id", input: NoteId, output: SharedNote, access: { point: "id", level: "read" } }, ({ id }, app) => sharedNote(app, id)),
      editNote: endpoint(
        {
          method: "PUT",
          path: "/api/public/notes/:id",
          input: NoteId.extend({ body: z.string().trim().min(1).max(10000) }),
          output: SharedNote,
          access: { point: "id", level: "write" },
        },
        async ({ id, body }, app) => {
          await app.db.update(notes).set({ body, updatedAt: new Date() }).where(eq(notes.id, id));
          return sharedNote(app, id);
        },
      ),
      shareNote: endpoint(
        {
          method: "POST",
          path: "/api/notes/:id/shares",
          input: NoteId.extend({ email: z.email(), level: z.enum(["read", "write"]) }),
          output: z.object({}),
          access: { point: "id", level: "manage" },
        },
        async ({ id, email, level }, app) => {
          await app.access.grant(id, { email }, level, { email: { path: `/#note=${id}` } });
          return {};
        },
      ),
      linkNote: endpoint(
        {
          method: "POST",
          path: "/api/notes/:id/links",
          input: NoteId.extend({ level: z.enum(["read", "write"]) }),
          output: z.object({ path: z.string() }),
          access: { point: "id", level: "manage" },
        },
        async ({ id, level }, app) => {
          const { token } = await app.access.link(id, level);
          return { path: `/#note=${id}&link=${token}` };
        },
      ),
      // Other people's personal notes the signed-in user can read, filtered by access in the query itself.
      sharedNotes: endpoint(
        { method: "GET", path: "/api/shared-notes", input: z.object({}), output: z.array(SharedNote.omit({ level: true })), access: "none" },
        async (_, app) => {
          const user = await app.requireUser();
          return app.db
            .select({ ...columns, author: users.name })
            .from(notes)
            .innerJoin(users, eq(users.id, notes.userId))
            .where(and(ne(notes.userId, user.id), isNull(notes.organizationId), await app.access.readable(notes.id)))
            .orderBy(desc(notes.createdAt))
            .limit(100);
        },
      ),
      listMyOrganizations: endpoint(
        {
          serve: ["api", "mcp"],
          method: "GET",
          path: "/api/organizations",
          description: "The organizations the signed-in user belongs to, with their ids for the organization note tools",
          input: z.object({}),
          output: z.array(Org),
          access: "none",
        },
        async (_, app) => (await app.organizations.list()).map(({ id, name }) => ({ id, name })),
      ),
      // Its members may add notes, so the organization's point gives them create, not only read.
      createOrganization: endpoint(
        { method: "POST", path: "/api/organizations", input: z.object({ name: z.string().trim().min(1).max(60) }), output: Org, access: "none" },
        async ({ name }, app) => {
          const org = await app.organizations.create({ name });
          await app.access.grant(organizationPoint(org.id), { organization: org.id }, "create");
          return { id: org.id, name: org.name };
        },
      ),
      listOrganizationNotes: endpoint(
        {
          serve: ["api", "mcp"],
          method: "GET",
          path: "/api/organizations/:organization/notes",
          description: "The newest 100 notes of an organization the signed-in user belongs to",
          input: OrgId,
          output: z.array(OrgNote),
          access: { point: ({ organization }) => organizationPoint(organization), level: "read" },
        },
        async ({ organization }, app) => {
          const orgNotes = app.db.select(orgColumns).from(notes).innerJoin(users, eq(users.id, notes.userId));
          return orgNotes
            .where(and(eq(notes.organizationId, organization), await app.access.readable(notes.id)))
            .orderBy(desc(notes.createdAt))
            .limit(100);
        },
      ),
      addOrganizationNote: endpoint(
        {
          serve: ["api", "mcp"],
          method: "POST",
          path: "/api/organizations/:organization/notes",
          description: "Add a note to an organization the signed-in user belongs to; its open pages see it live",
          input: OrgId.extend({ body: z.string().trim().min(1).max(10000) }),
          output: OrgNote,
          access: { point: ({ organization }) => organizationPoint(organization), level: "create" },
        },
        async ({ organization, body }, app) => {
          const user = await app.requireUser();
          const inserted = await app.db.transaction(async (tx) => {
            const [row] = await tx.insert(notes).values({ body, userId: user.id, organizationId: organization }).returning({ id: notes.id, body: notes.body, createdAt: notes.createdAt });
            await app.access.in(tx).create(row!.id, { parent: organizationPoint(organization), inherit: true });
            return row!;
          });
          const note = { ...inserted, author: user.name };
          // Saved first; the announcement only tells the organization's open pages.
          await app.live.publish(organizationPoint(organization), { type: "note", note });
          return note;
        },
      ),
    },
  },
);
