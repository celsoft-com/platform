---
name: celsoft-platform
description: "MUST READ before changing an app built on @celsoft/platform: its endpoints, tables and migrations, pages, auth, files, email, live rooms, MCP tools, item access, platform.jsonc, deploys or previews. Matches the installed version of the package."
---

# Working on a @celsoft/platform app

The app runs on Cloudflare Workers with a Neon Postgres database. The platform owns the Worker,
the cloud resources and the deploys; the app writes its endpoints, tables and pages. Run every
command as `npx @celsoft/platform <command>` from the app's folder.

## Files

| File | Who writes it | Rule |
| --- | --- | --- |
| `platform.jsonc` | The app | What the app turns on; validated on every run |
| `src/worker.ts` | The app | `export default defineApp(handler, { schema, endpoints, live })` |
| `src/schema.ts` | The app | Drizzle tables; `id()` and `timestamps()` from `@celsoft/platform/schema` |
| Frontend (`frontend` in `platform.jsonc`) | The app | Static files, or a `build` script's output |
| `drizzle/` | `db generate` | Commit; never edit |
| `.github/workflows/platform.yml` | `init` | Commit; never edit |
| `.platform/` | The platform | Gitignored; regenerated on install, `dev` and deploy; never edit |

## Endpoints

Every type is a Zod schema. Declare each API or MCP function in `defineApp`'s `endpoints`:

```ts
import { defineApp, endpoint, EndpointError } from "@celsoft/platform";
import { z } from "zod";

export default defineApp(undefined, {
  schema,
  endpoints: {
    getNote: endpoint(
      {
        serve: ["api", "mcp"],          // the API by default; "mcp" makes it an MCP tool
        method: "GET",
        path: "/api/notes/:id",         // under /api/; :name must be an input field
        description: "Read one note",   // the MCP tool's description
        input: z.object({ id: z.uuid() }),
        output: z.object({ id: z.uuid(), body: z.string() }),
      },
      async ({ id }, app) => {
        const user = await app.requireUser();
        const [note] = await app.db.select().from(notes).where(and(eq(notes.id, id), eq(notes.userId, user.id)));
        if (!note) throw new EndpointError(404, "not found");
        return note;
      },
    ),
  },
});
```

1. **Inputs:** path parameters, the query and a JSON body merge into one input object; URL strings are converted to the schema's types.
2. **Checks:** bad input is a 400; an output that does not match its schema is a 500, logged.
3. **Errors:** throw `EndpointError(status, message)`; a thrown `Response`, as `requireUser()` throws, keeps its status.
4. **Access:** every `/api/` path needs a signed-in user except under `/api/public/`; MCP calls always carry one.
5. **Item access:** with `access` on, `access: { kind: "note", id: "id", level: "write" }` in the definition checks the caller's level on the item whose id is in that input field before the function runs, and answers 404 when it falls short.
6. **Frontend calls:** a bundled frontend imports `call` from `.platform/client` and calls `call("getNote", { id })`, typed from the endpoints.
7. **Hand-written routes:** the `handler` (first argument, or `undefined`) takes every request no endpoint answers, for uploads, downloads and streaming.

## `app`

Each request gets `app`: `db` (Drizzle, typed with `schema`), `auth`, `session()`, `requireUser()`,
`files` (R2, folders), `email` (`app.email.send(...)`), `live` (`app.live.publish(room, message)`),
`access` (with `access` on), `organizations` (with organizations on), `env` and `waitUntil`. Each is created on first use.

## Access

With `"access": true`, the platform keeps who may do what to the app's resources through control points:

1. **A point per resource:** `await app.db.transaction(async (tx) => { ...insert...; await app.access.in(tx).create(row.id, { parent, inherit }); })`.
   The id is the resource's own id, any globally unique string; ids starting `organization:` or `team:` are the platform's. Whoever creates it gets `manage`; creating needs a signed-in user and, with a `parent`, `create` on it.
2. **Levels:** `read` < `create` < `write` < `delete` < `manage`; each includes those below.
3. **Principals:** a person (`{ user }` or a confirmed `{ email }`), `{ team }`, `{ organization }` and `{ everyone: true }` (read only, signed in or not).
4. **Inheritance:** with `inherit: true` a point also uses its parent's grants, up to the first point that does not inherit. Each principal stops at its nearest grant and the highest wins, so a grant to a person on a note can lower that person there, while a grant to a whole organization never lowers its teams.
5. **Grants:** `app.access.grant(point, to, level, { email: { path: "/notes/7" } })`, `revoke`, `grants`, `inherit(point, true)`; all need `manage`. A new grant to a person emails them a link to `path` (`email: false` sends none). Points under an organization take only its own teams and organization, plus people and Everyone.
6. **Links:** `app.access.link(point, level, { expires })` returns a token, at most `write`, good on that one point only; build addresses such as `/#note=7&link=<token>`, and `call()` sends the `#link=` token as the `x-access-link` header. Endpoints a signed-out link holder uses go under `/api/public/`.
7. **Endpoints:** with access on, every endpoint declares `access: { point: "id", level: "read" }`, `access: { point: (input) => organizationPoint(input.org), level: "create" }` or `access: "none"`; the app refuses every request until each one does.
8. **Check:** `app.access.check(point)` returns the level or throws a 404 below `read`; `require(point, level)` and `can(point, level)` in hand-written routes; `point(id)` returns its parent and whether it inherits.
9. **Lists:** `.where(await app.access.readable(notes.id))` or `allows(level, column)` filters in the same query.
10. **Move and delete:** `move(point, parent)` needs `manage` and `create` on the new parent; `remove(point)` needs `delete` and returns the ids of the point and everything under it, so delete those rows in the same transaction.
11. **Static points:** `defineApp(handler, { access: { points: { settings: { grants: [{ to: { email: "boss@x.com" }, level: "manage" }] } } } })`, applied at every start; their grants change only in code.
12. **Organizations:** each has the point `organizationPoint(id)` granting its members `read`, and each team `teamPoint(id)` granting the team `write`; members of the built-in Admins team get `manage` on everything under their organization.
13. **As the app:** `app.access.asApp()` passes every check, for work no person asked for; never use it for a request's own data.

## Organizations

With `"auth": { "organizations": true }`, the platform keeps organizations, teams, members and invitations itself, with no roles:

1. **In code:** `app.organizations` has `create`, `list`, `get`, `rename`, `remove`, `requireMember`, `members`, `removeMember`, `invite`, `invitations`, `revokeInvitation`, `accept`, `myInvitations`, `decline`, `teams`, `team`, `createTeam`, `renameTeam`, `removeTeam`, `teamMembers`, `addToTeam` and `removeFromTeam`.
2. **From browsers:** the same under `/api/platform/`: `organizations`, `organizations/:id`, `organizations/:id/members`, `organizations/:id/invitations`, `invitations` (the caller's own), `invitations/:id/accept`, `invitations/:id` (decline), `organizations/:id/teams`, `teams/:id` and `teams/:id/members`.
3. **Who may:** reading needs `read` on the organization's point, renaming `write`, deleting `delete`, inviting and removing others `manage`, creating teams `create`; a team's members need `manage` on its point. Anyone may leave, except the last admin.
4. **Admins:** the creator is the first member of the Admins team; add others with `addToTeam(adminsTeamId, userId)`.
5. **Invitations:** emailed with a link to `/login?invitation=<id>`, accepted by whoever signs in with that confirmed address; an invitation can name a team.

## Tables and migrations

1. **Change** `src/schema.ts`, then run `npx @celsoft/platform db generate`; read and commit the SQL in `drizzle/`.
   For data changes, `db generate --custom <name>` writes an empty migration to fill with SQL; it is the one `drizzle/` file you edit, before it is deployed.
2. **Deploy** applies new migrations; it stops before any change when the schema has changes with no generated migration.
3. **Auth tables** come from the platform; reference users with `user.id` from `@celsoft/platform/schema`.
4. **Ids** are `uuid` filled by Postgres's `uuidv7()`; never supply them.

## Features in `platform.jsonc`

1. **`database`:** a Neon project id; prod, each preview and `dev` get their own branch.
2. **`email`:** sending from `noreply@<hostname>` through Resend; previews and `dev` capture email instead of sending, except that previews really email the addresses in `"previews": { "sendEmailTo": ["*@yourcompany.com"] }`, so testers can confirm accounts and receive sharing emails.
3. **`auth`:** sign-up and sign-in at `/login`, `/signup`, `/forgot`, `/reset`; `{ "organizations": true }` adds organizations and teams; see Organizations above. Needs `database` and `email`.
4. **`files`:** `app.files` in an R2 bucket; previews share one bucket under their PR's folder.
5. **`live`:** rooms over WebSockets; `live: { message: schema, canJoin, canSend, onMessage }` in `defineApp`; browsers use `live()` from `@celsoft/platform/live`. Joining and sending are refused unless `canJoin` and `canSend` say yes.
6. **`mcp`:** serves endpoints with `serve` including `"mcp"` at `/mcp` to AI clients that sign in with OAuth. Needs `auth`.
7. **`access`:** `app.access`, for who may do what to the app's resources; see Access above. Needs `auth`.

## Commands

| Command | What it does |
| --- | --- |
| `dev` | Runs the app locally on its own `dev` database branch; starts the `dev` script beside it, with `plugins: [platform()]` from `@celsoft/platform/vite` |
| `db generate` | Writes migrations for schema changes |
| `generate` | Rewrites `.platform/`; also runs on install |
| `deploy` / `preview <pr>` | Deploy prod or a PR's preview; CI runs these on push and on pull requests |
| `previews` | Lists the previews that exist |
| `owner reset <email>` | Makes that account the owner and sets its password |
| `--dry-run` | On any command, shows what would change |

## Rules

1. **Never edit generated files:** `drizzle/` (except a new `--custom` migration), the workflow and `.platform/`; regenerate them instead.
2. **Never read or print** `.env.secrets`; it holds the deploy tokens.
3. **Resource names are reserved:** anything in the Cloudflare account named after the app, or the app followed by `--`, belongs to the platform.
4. **Failures stop the run:** a failed build, migration or check leaves the running version in place; fix the cause rather than working around it.
