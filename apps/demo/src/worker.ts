import { defineApp, endpoint, EndpointError, organizationPoint, page, route, teamPoint, type AppContext, type Grantee, type PlatformBindings } from "@celsoft/platform";
import { organization, team, user as users } from "@celsoft/platform/schema";
import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./schema";

const { notes } = schema;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const columns = { id: notes.id, body: notes.body, attachmentName: notes.attachmentName, createdAt: notes.createdAt, organizationId: notes.organizationId, teamId: notes.teamId };
const groupColumns = { id: notes.id, body: notes.body, createdAt: notes.createdAt, author: users.name };
const ROOM = /^(organization|team):[0-9a-f-]{36}$/;

type App = AppContext<PlatformBindings, typeof schema>;

// The demo is where people try every access feature by hand. Every note is a control point named
// by its id. A personal note stands alone, so only its author and whoever they share it with can
// see it; an organization's or a team's note inherits from that organization's or team's point.
// Each note's permissions panel shows and changes its grants, links and inheritance.

// A note as anyone who can open it sees it, with the level they have on it.
const SharedNote = z.object({ id: z.uuid(), body: z.string(), attachmentName: z.string().nullable(), createdAt: z.date(), organizationId: z.uuid().nullable(), teamId: z.uuid().nullable(), author: z.string(), level: z.string() });
const NoteId = z.object({ id: z.uuid() });
const GroupNote = z.object({ id: z.uuid(), body: z.string(), createdAt: z.date(), author: z.string() });
const Org = z.object({ id: z.uuid(), name: z.string() });
const OrgId = z.object({ organization: z.uuid() });
const TeamId = z.object({ team: z.uuid() });
const Level = z.enum(["read", "create", "write", "delete", "manage"]);
// Who a grant is for, as the permissions panel names it.
const To = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), value: z.email() }),
  z.object({ kind: z.literal("user"), value: z.uuid() }),
  z.object({ kind: z.literal("team"), value: z.uuid() }),
  z.object({ kind: z.literal("organization"), value: z.uuid() }),
  z.object({ kind: z.literal("everyone") }),
]);
const Destination = z.discriminatedUnion("kind", [z.object({ kind: z.literal("personal") }), z.object({ kind: z.literal("organization"), id: z.uuid() }), z.object({ kind: z.literal("team"), id: z.uuid() })]);

function grantee(to: z.infer<typeof To>): Grantee {
  if (to.kind === "everyone") return { everyone: true };
  return { [to.kind]: to.value } as Grantee;
}

async function sharedNote(app: App, id: string) {
  const [note] = await app.db.select({ ...columns, author: users.name }).from(notes).innerJoin(users, eq(users.id, notes.userId)).where(eq(notes.id, id));
  if (!note) throw new EndpointError(404, "not found");
  return { ...note, level: await app.access.check(id) };
}

// A grant with the name of whoever it is for, so the panel never shows a bare id.
async function named(app: App, to: Grantee): Promise<{ kind: string; value: string | null; name: string }> {
  if ("everyone" in to) return { kind: "everyone", value: null, name: "Everyone, signed in or not" };
  if ("email" in to) return { kind: "email", value: to.email, name: to.email };
  if ("user" in to) {
    const [row] = await app.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, to.user));
    return { kind: "user", value: to.user, name: row ? `${row.name} <${row.email}>` : "someone" };
  }
  if ("team" in to) {
    const [row] = await app.db.select({ name: team.name }).from(team).where(eq(team.id, to.team));
    return { kind: "team", value: to.team, name: `Team ${row?.name ?? "?"}` };
  }
  const [row] = await app.db.select({ name: organization.name }).from(organization).where(eq(organization.id, to.organization));
  return { kind: "organization", value: to.organization, name: `Everyone in ${row?.name ?? "?"}` };
}

// A room is named after a control point, an organization's or a team's, so whoever can read it may join.
async function inRoom(room: string, _user: unknown, app: App): Promise<boolean> {
  return ROOM.test(room) && (await app.access.level(room)) !== null;
}

const noteFolder = (userId: string, noteId: string) => `notes/${userId}/${noteId}`;

// Notes in an organization or a team, newest first, only those the caller can read.
async function groupNotes(app: App, where: ReturnType<typeof eq>) {
  return app.db
    .select(groupColumns)
    .from(notes)
    .innerJoin(users, eq(users.id, notes.userId))
    .where(and(where, await app.access.readable(notes.id)))
    .orderBy(desc(notes.createdAt))
    .limit(100);
}

// A new note under a group's point, inheriting from it, announced to the group's room.
async function addGroupNote(app: App, values: { organizationId: string; teamId: string | null }, point: string, body: string) {
  const user = await app.requireUser();
  const inserted = await app.db.transaction(async (tx) => {
    const [row] = await tx.insert(notes).values({ body, userId: user.id, ...values }).returning({ id: notes.id, body: notes.body, createdAt: notes.createdAt });
    await app.access.in(tx).create(row!.id, { parent: point, inherit: true });
    return row!;
  });
  const note = { ...inserted, author: user.name };
  // Saved first; the announcement only tells the group's open pages.
  await app.live.publish(point, { type: "note", note });
  return note;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const printable = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>` +
  `<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif}main{max-width:40rem;margin:2rem auto;padding:0 1rem}.body{white-space:pre-wrap}.meta{opacity:.7}</style></head>` +
  `<body><main>${body}<p><a href="/#/notes">Back to the app</a></p></main></body></html>`;

// Pages the Worker renders on each request: /print lists the signed-in person's own notes, sending
// anyone signed out to sign in first, and /print/<id> shows one note to whoever can read it.
const print = page({
  path: "/print",
  routes: {
    "/": route({ access: "none" }, async (_, app: App) => {
      const me = await app.requireUser();
      const mine = await app.db.select(columns).from(notes).where(and(eq(notes.userId, me.id), isNull(notes.organizationId))).orderBy(desc(notes.createdAt)).limit(100);
      const items = mine.map((n) => `<li><a href="/print/${n.id}">${escape(n.body.slice(0, 80))}</a></li>`).join("");
      return printable("Your notes", `<h1>Your notes</h1>${items ? `<ul>${items}</ul>` : "<p>You have no notes of your own yet.</p>"}`);
    }),
    "/:id": route({ params: NoteId, access: { point: "id", level: "read" } }, async ({ id }, app: App) => {
      const note = await sharedNote(app, id);
      return printable(note.body.slice(0, 60), `<h1>Note</h1><p class="meta">By ${escape(note.author)}, ${note.createdAt.toISOString().slice(0, 10)}; you may ${note.level} it.</p><p class="body">${escape(note.body)}</p>`);
    }),
  },
});

// Everything said in a room: new notes from the server, typing notices from browsers.
const RoomMessage = z.discriminatedUnion("type", [z.object({ type: z.literal("note"), note: GroupNote }), z.object({ type: z.literal("typing") })]);

// Hand-written routes. The download is public so a signed-out link holder can use it, and checks
// the note's point; every other route here is private, so the platform has already checked the session.
export default defineApp(
  async (request, app) => {
    const { db, files, requireUser } = app;
    const url = new URL(request.url);

    const download = /^\/api\/public\/notes\/([0-9a-f-]{36})\/attachment$/.exec(url.pathname);
    if (download && request.method === "GET") {
      await app.access.check(download[1]!);
      const [note] = await db.select({ ...columns, userId: notes.userId }).from(notes).where(eq(notes.id, download[1]!));
      if (!note?.attachmentName) return new Response("not found", { status: 404 });
      return files.response(`${noteFolder(note.userId, note.id)}/${note.attachmentName}`);
    }

    const user = await requireUser();

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
      if (attachment) await files.put(`${noteFolder(user.id, note!.id)}/${attachment.name}`, attachment, attachment.type || undefined);
      return Response.json(note, { status: 201 });
    }

    return new Response("not found", { status: 404 });
  },
  {
    schema,
    pages: [print],
    // A static point, declared here and applied at every start: anyone may read the about line.
    access: { points: { about: { grants: [{ to: { everyone: true }, level: "read" }] } } },
    live: { message: RoomMessage, canJoin: inRoom, canSend: inRoom },
    endpoints: {
      about: endpoint(
        { method: "GET", path: "/api/public/about", input: z.object({}), output: z.object({ level: z.string() }), access: { point: () => "about", level: "read" } },
        async (_, app) => ({ level: await app.access.check("about") }),
      ),

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
      // Removes the note's point and every point under it, then those notes and their files.
      deleteNote: endpoint({ method: "DELETE", path: "/api/notes/:id", input: NoteId, output: z.object({ deleted: z.number() }), access: { point: "id", level: "delete" } }, async ({ id }, app) => {
        const gone = await app.db.transaction(async (tx) => {
          const ids = (await app.access.in(tx).remove(id)).filter((x) => z.uuid().safeParse(x).success);
          if (ids.length === 0) return [];
          return tx.delete(notes).where(inArray(notes.id, ids)).returning({ id: notes.id, userId: notes.userId, attachmentName: notes.attachmentName });
        });
        for (const note of gone) if (note.attachmentName) await app.files.delete(`${noteFolder(note.userId, note.id)}/${note.attachmentName}`).catch(() => {});
        return { deleted: gone.length };
      }),
      // Into an organization or a team the caller may add to, or back to the caller's own notes.
      moveNote: endpoint(
        { method: "POST", path: "/api/notes/:id/move", input: NoteId.extend({ to: Destination }), output: z.object({}), access: { point: "id", level: "manage" } },
        async ({ id, to }, app) => {
          let parent: string | null = null;
          let place: { organizationId: string | null; teamId: string | null } = { organizationId: null, teamId: null };
          if (to.kind === "organization") {
            parent = organizationPoint(to.id);
            place = { organizationId: to.id, teamId: null };
          } else if (to.kind === "team") {
            const [row] = await app.db.select({ organizationId: team.organizationId }).from(team).where(eq(team.id, to.id));
            if (!row) throw new EndpointError(404, "not found");
            parent = teamPoint(to.id);
            place = { organizationId: row.organizationId, teamId: to.id };
          }
          await app.db.transaction(async (tx) => {
            const access = app.access.in(tx);
            await access.move(id, parent);
            await access.inherit(id, parent !== null);
            await tx.update(notes).set({ ...place, updatedAt: new Date() }).where(eq(notes.id, id));
          });
          return {};
        },
      ),

      // The permissions panel: the note's place, grants and links, for those who manage it.
      noteAccess: endpoint(
        {
          method: "GET",
          path: "/api/notes/:id/access",
          input: NoteId,
          output: z.object({
            level: z.string(),
            parent: z.string().nullable(),
            inherits: z.boolean(),
            grants: z.array(z.object({ kind: z.string(), value: z.string().nullable(), name: z.string(), level: z.string() })),
            links: z.array(z.object({ id: z.string(), level: z.string(), expiresAt: z.date().nullable() })),
          }),
          access: { point: "id", level: "manage" },
        },
        async ({ id }, app) => {
          const point = await app.access.point(id);
          const grants = await Promise.all((await app.access.grants(id)).map(async (g) => ({ ...(await named(app, g.to)), level: g.level })));
          return { level: await app.access.check(id), parent: point.parent, inherits: point.inherits, grants, links: await app.access.links(id) };
        },
      ),
      grantNote: endpoint(
        { method: "POST", path: "/api/notes/:id/grants", input: NoteId.extend({ to: To, level: Level }), output: z.object({}), access: { point: "id", level: "manage" } },
        async ({ id, to, level }, app) => {
          await app.access.grant(id, grantee(to), level, { email: { path: `/#/notes/${id}` } });
          return {};
        },
      ),
      revokeNote: endpoint(
        { method: "POST", path: "/api/notes/:id/grants/revoke", input: NoteId.extend({ to: To }), output: z.object({}), access: { point: "id", level: "manage" } },
        async ({ id, to }, app) => {
          await app.access.revoke(id, grantee(to));
          return {};
        },
      ),
      inheritNote: endpoint(
        { method: "PUT", path: "/api/notes/:id/inherit", input: NoteId.extend({ inherit: z.boolean() }), output: z.object({}), access: { point: "id", level: "manage" } },
        async ({ id, inherit }, app) => {
          await app.access.inherit(id, inherit);
          return {};
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
          await app.access.grant(id, { email }, level, { email: { path: `/#/notes/${id}` } });
          return {};
        },
      ),
      linkNote: endpoint(
        {
          method: "POST",
          path: "/api/notes/:id/links",
          input: NoteId.extend({ level: z.enum(["read", "create", "write"]) }),
          output: z.object({ path: z.string() }),
          access: { point: "id", level: "manage" },
        },
        async ({ id, level }, app) => {
          const { token } = await app.access.link(id, level);
          return { path: `/#/notes/${id}&link=${token}` };
        },
      ),
      revokeLink: endpoint(
        { method: "DELETE", path: "/api/notes/:id/links/:link", input: NoteId.extend({ link: z.string() }), output: z.object({}), access: { point: "id", level: "manage" } },
        async ({ id, link }, app) => {
          await app.access.revokeLink(id, link);
          return {};
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
          description: "The newest 100 organization-wide notes of an organization the signed-in user belongs to",
          input: OrgId,
          output: z.array(GroupNote),
          access: { point: ({ organization }) => organizationPoint(organization), level: "read" },
        },
        async ({ organization }, app) => groupNotes(app, and(eq(notes.organizationId, organization), isNull(notes.teamId)) as ReturnType<typeof eq>),
      ),
      addOrganizationNote: endpoint(
        {
          serve: ["api", "mcp"],
          method: "POST",
          path: "/api/organizations/:organization/notes",
          description: "Add a note to an organization the signed-in user belongs to; its open pages see it live",
          input: OrgId.extend({ body: z.string().trim().min(1).max(10000) }),
          output: GroupNote,
          access: { point: ({ organization }) => organizationPoint(organization), level: "create" },
        },
        async ({ organization, body }, app) => addGroupNote(app, { organizationId: organization, teamId: null }, organizationPoint(organization), body),
      ),
      listTeamNotes: endpoint(
        {
          serve: ["api", "mcp"],
          method: "GET",
          path: "/api/teams/:team/notes",
          description: "The newest 100 notes of a team the signed-in user can read",
          input: TeamId,
          output: z.array(GroupNote),
          access: { point: ({ team: id }) => teamPoint(id), level: "read" },
        },
        async ({ team: id }, app) => groupNotes(app, eq(notes.teamId, id)),
      ),
      addTeamNote: endpoint(
        {
          serve: ["api", "mcp"],
          method: "POST",
          path: "/api/teams/:team/notes",
          description: "Add a note to a team the signed-in user can add to; the team's open pages see it live",
          input: TeamId.extend({ body: z.string().trim().min(1).max(10000) }),
          output: GroupNote,
          access: { point: ({ team: id }) => teamPoint(id), level: "create" },
        },
        async ({ team: id, body }, app) => {
          const [row] = await app.db.select({ organizationId: team.organizationId }).from(team).where(eq(team.id, id));
          return addGroupNote(app, { organizationId: row!.organizationId, teamId: id }, teamPoint(id), body);
        },
      ),
    },
  },
);
