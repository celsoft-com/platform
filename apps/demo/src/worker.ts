import { defineApp, endpoint, EndpointError, type AppContext, type PlatformBindings } from "@celsoft/platform";
import { member, organization, user as users } from "@celsoft/platform/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import * as schema from "./schema";

const { notes } = schema;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const columns = { id: notes.id, body: notes.body, attachmentName: notes.attachmentName, createdAt: notes.createdAt };
const teamColumns = { id: notes.id, body: notes.body, createdAt: notes.createdAt, author: users.name };
const TEAM_ROOM = /^team:([0-9a-f-]{36})$/;

type App = AppContext<PlatformBindings, typeof schema>;

const TeamNote = z.object({ id: z.uuid(), body: z.string(), createdAt: z.date(), author: z.string() });

// Everything said in a team room: new notes from the server, typing notices from browsers.
const TeamMessage = z.discriminatedUnion("type", [z.object({ type: z.literal("note"), note: TeamNote }), z.object({ type: z.literal("typing") })]);

async function isMember({ db }: App, organizationId: string, userId: string): Promise<boolean> {
  const rows = await db.select({ id: member.id }).from(member).where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)));
  return rows.length > 0;
}

// A team's room is open to its members only; they also send typing notices through it.
async function inTeamRoom(room: string, user: { id: string } | null, app: App): Promise<boolean> {
  const team = TEAM_ROOM.exec(room)?.[1];
  return Boolean(team && user && (await isMember(app, team, user.id)));
}

// Every /api route here is private, so the platform has already checked the session.
export default defineApp(
  async (request, app) => {
    const { db, files, live, requireUser } = app;
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
  {
    schema,
    live: { message: TeamMessage, canJoin: inTeamRoom, canSend: inTeamRoom },
    endpoints: {
      // For AI clients only: which teams they can read and add notes to.
      listMyTeams: endpoint(
        {
          serve: ["mcp"],
          description: "The teams the signed-in user belongs to, with their ids for the team note tools",
          input: z.object({}),
          output: z.array(z.object({ id: z.uuid(), name: z.string() })),
        },
        async (_, app) => {
          const user = await app.requireUser();
          return app.db.select({ id: organization.id, name: organization.name }).from(member).innerJoin(organization, eq(organization.id, member.organizationId)).where(eq(member.userId, user.id));
        },
      ),
      listTeamNotes: endpoint(
        {
          serve: ["api", "mcp"],
          method: "GET",
          path: "/api/teams/:team/notes",
          description: "The newest 100 notes of a team the signed-in user belongs to",
          input: z.object({ team: z.uuid() }),
          output: z.array(TeamNote),
        },
        async ({ team }, app) => {
          const user = await app.requireUser();
          if (!(await isMember(app, team, user.id))) throw new EndpointError(404, "not found");
          const teamNotes = app.db.select(teamColumns).from(notes).innerJoin(users, eq(users.id, notes.userId));
          return teamNotes.where(eq(notes.organizationId, team)).orderBy(desc(notes.createdAt)).limit(100);
        },
      ),
      addTeamNote: endpoint(
        {
          serve: ["api", "mcp"],
          method: "POST",
          path: "/api/teams/:team/notes",
          description: "Add a note to a team the signed-in user belongs to; the team's open pages see it live",
          input: z.object({ team: z.uuid(), body: z.string().trim().min(1).max(10000) }),
          output: TeamNote,
        },
        async ({ team, body }, app) => {
          const user = await app.requireUser();
          if (!(await isMember(app, team, user.id))) throw new EndpointError(404, "not found");
          const [inserted] = await app.db.insert(notes).values({ body, userId: user.id, organizationId: team }).returning({ id: notes.id, body: notes.body, createdAt: notes.createdAt });
          const note = { ...inserted!, author: user.name };
          // Saved first; the announcement only tells the team's open pages.
          await app.live.publish(`team:${team}`, { type: "note", note });
          return note;
        },
      ),
    },
  },
);
