---
name: celsoft-platform
description: "MUST READ before changing an app built on @celsoft/platform: its endpoints, tables and migrations, pages, auth, files, email, live rooms, MCP tools, item access, platform.jsonc, deploys or previews. Matches the installed version of the package."
---

# Working on a @celsoft/platform app

The app runs on Cloudflare Workers with a Neon Postgres database. The platform owns the Worker,
the cloud resources and the deploys; the app writes its endpoints, tables and pages. Run every
command as `npx @celsoft/platform <command>` from the app's folder. To create an app or deploy it
for the first time, follow the `celsoft-platform-setup` skill instead.

## Platform gaps: stop, never work around

When the platform cannot do what the app needs, does it wrong, or a command fails in a way the
app cannot fix, **stop and ask the user to request a fix** at
https://github.com/celsoft-com/platform/issues. A workaround hides the gap, breaks on the next
upgrade, and keeps the fix from reaching every app.

1. **Stop:** tell the user what the app needs, what the platform lacks or did, and the exact output.
2. **Request:** the user opens an issue there with those three things; offer to draft it.
3. **Wait:** leave that part of the app undone until a release fixes it, then `npm install` the new version.
4. **Never instead:** run `wrangler`, the Cloudflare API or the Neon API yourself; create, change or delete cloud resources by hand; edit generated files or `node_modules`; patch the package; or rebuild in the app something the platform owns, such as auth, sessions, migrations, routing, files, email or live rooms.
5. **Not a gap:** a mistake in the app's own code or `platform.jsonc`, or a step the skills say the user does, such as creating an account or token; fix those.

## Files

| File | Who writes it | Rule |
| --- | --- | --- |
| `platform.jsonc` | The app | What the app turns on; validated on every run |
| `src/worker.ts` | The app | `export default defineApp(handler, { schema, endpoints, pages, live })` |
| `src/schema.ts` | The app | Drizzle tables; `id()` and `timestamps()` from `@celsoft/platform/schema` |
| Frontend (`frontend` in `platform.jsonc`) | The app | Static files, or a `build` script's output; anything rendered per request is a server page |
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
5. **Point access:** with `access` on, every endpoint says `access: { point: "id", level: "write" }`, naming the input field or a function of the input that gives the control point, or `access: "user"` (anyone signed in) or `"anon"` (anyone, only under `/api/public/`); the caller needs that level or gets a 404, over the API and MCP alike, and the function never runs.
6. **Frontend calls:** a bundled frontend imports `call` from `.platform/client` and calls `call("getNote", { id })`, typed from the endpoints.
7. **Hand-written routes:** the `handler` (first argument, or `undefined`) takes every request no endpoint answers, for uploads, downloads and streaming.

## Server pages

Pages the Worker renders on each request, for share previews, printable views and pages search
engines must read.

**Rendering rule:** the Worker renders HTML only for content that is identical for everyone
allowed to see it. Anything that depends on who is looking or on what they have done (sign-in
state, saved choices, checkmarks, drafts, admin screens) is never rendered on the server; the
browser adds it with JavaScript after the page loads. A page's access gate decides who gets the
page, never what it says. A page can mix both: the server renders the shared content in its
default state, such as a checklist with every box unchecked, and the browser fills in the
visitor's own state.

A page claims a path and everything below it:

```ts
import { defineApp, page, route } from "@celsoft/platform";

const notesPage = page({
  path: "/notes",                       // claims /notes and /notes/*; no static file is served there
  routes: {
    "/": route({ access: "anon" }, () => "<h1>Notes</h1>"),
    "/new": route({ access: "user" }, () => "<h1>New</h1>"),   // text segments win over parameters
    "/:id": route(
      { params: z.object({ id: z.uuid() }), access: { point: "id", level: "read" }, cache: true },
      async ({ id }, app) => `<h1>${escape(await publishedBody(app, id))}</h1>`,
    ),
  },
});

export default defineApp(undefined, { schema, endpoints, pages: [notesPage] });
```

1. **Paths:** plain segments, never a parameter, a trailing slash, or under `/api`, `/mcp`, `/.well-known`, the sign-in screens or `/tokens`; two claims never overlap. Every path not claimed is still a static file.
   - **Root page:** `page({ path: "/", routes: { "/": handler } })` answers `/` alone, never the paths below it; it wins over a static `index.html` at `/`, which still serves every other unmatched path.
2. **Routes:** `"/"` is the claimed path itself; a path matching no route under the claim gets the 404 page. A plain function gets its `:name` segments as decoded strings.
   - **Any depth:** a last `*name` segment, such as `"/*path"` or `"/:owner/*path"`, matches one or more segments and gets them joined by `/`, so `/trip/2026/italy/day1` gives `path` = `2026/italy/day1`; use it when paths are made after the deploy, never a route per depth. Text routes win over `:name`, which wins over `*name`; `*name` is only ever last, so split anything after it in the handler. Gate it with a function, `access: { point: ({ path }) => pointFor(path), level: "read" }`.
   - **Checked params:** `route({ params })` checks and converts them with Zod, and a refused value is a 404.
3. **Answers:** return an HTML string, sent as `text/html`, or a whole `Response`. Escape every value you put in the HTML; nothing escapes it for you.
4. **Methods:** GET and HEAD only; send changes to endpoints.
5. **Assets:** link CSS, scripts and images from unclaimed paths such as `/assets/`.
6. **Access gate:** with `access` on, every route declares who may read it: `{ point: "id", level: "read" }` (a param, or a function of the params), `"user"` (anyone signed in) or `"anon"` (anyone); the app refuses every request until each does. It is checked before the handler and the cache.
   - **Refused:** a refused visitor, a missing point and an unmatched path get one 404 page; signed out, it offers Sign in and Sign up, which return to the page. Never build a redirect for it.
   - **Share links:** `/print/7#link=<token>` opens a gated page; the 404 page swaps the token for a cookie and reloads, so put links after `#`, never in the query.
   - **API tokens:** count on page GET and HEAD, capped at their level.
   - **Blind handler:** `app.session()`, `app.requireUser()` and `app.access` throw inside a page's handler; fetch anything personal in the browser from an endpoint.
7. **Errors:** throw `EndpointError(status, message)` for an HTML error page with that status.
8. **Deploy:** claims are read from the Worker's code at deploy and `dev`; there is nothing to configure.
9. **Caching:** any page may opt in:
    `route({ cache: true }, async (_, app) => html)` keeps it 60 seconds; `cache: { seconds: 300 }` sets up to 3,600.
    1. **Same for everyone who passes:** the gate runs first, then everyone who passes gets the kept copy, and the cache key is the path and query only, so a page's HTML must never depend on anything else about the request, such as cookies, `accept-language` or location. After a write, invalidate every page showing it, such as `/print/${id}`.
    2. **Emptying it:** after a write commits, `await app.cache.invalidate("/stats")` empties that page (every query string of it), and `await app.cache.clear()` empties every page; both reach every data center within a second, need a database, and cost one tiny query.
    3. **Which to use:** `invalidate` for ordinary writes, from endpoints, handlers, live messages and jobs alike; `clear` only for rare, sweeping changes, since it makes every page render again, and the logs warn when it runs twice in a minute; if you cannot tell what a write affects, rely on `seconds`.
    4. **Deploys:** every deploy starts empty.
    5. **Seeing it:** the `platform-cache` header is `hit` or `miss`; a hit runs no handler and no query of yours.

## `app`

Each request gets `app`: `db` (Drizzle, typed with `schema`), `auth`, `invites`, `cache`, `session()`, `requireUser()`,
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
6. **Links:** `app.access.link(point, level, { expires })` returns a token, at most `write`, good on that one point only; build addresses such as `/#note=7&link=<token>`, and `call()` sends the `#link=` token as the `x-access-link` header and keeps it as a cookie, so plain `<a href>` downloads count it too. Endpoints a signed-out link holder uses go under `/api/public/`.
7. **Endpoints:** with access on, every endpoint declares `access: { point: "id", level: "read" }`, `access: { point: (input) => organizationPoint(input.org), level: "create" }`, `access: "user"` or `access: "anon"`; the app refuses every request until each one does.
8. **Check:** `app.access.check(point)` returns the level or throws a 404 below `read`; `require(point, level)` and `can(point, level)` in hand-written routes; `point(id)` returns its parent and whether it inherits.
9. **Lists:** `.where(await app.access.readable(notes.id))` or `allows(level, column)` filters in the same query.
10. **Move and delete:** `move(point, parent)` needs `manage` and `create` on the new parent; `remove(point)` needs `delete` and returns the ids of the point and everything under it, so delete those rows in the same transaction.
11. **Static points:** `defineApp(handler, { access: { points: { settings: { grants: [{ to: { email: "boss@x.com" }, level: "manage" }] } } } })`, written by every deploy and `dev`; their grants change only in code.
12. **Organizations:** each has the point `organizationPoint(id)` granting its members `read`, and each team `teamPoint(id)` granting the team `write`; members of the built-in Admins team get `manage` on everything under their organization.
13. **As the app:** `app.access.asApp()` passes every check, for work no person asked for; never use it for a request's own data.

## Speed

The platform keeps its own work per request near zero; keep the app's the same:

1. **Round trips:** every query is a trip to the database, and they add up; count them, not milliseconds.
2. **Together:** run independent queries with `Promise.all`, never one after another.
3. **Lists:** filter and page in the query, `.where(and(eq(notes.userId, me.id), await app.access.readable(notes.id))).limit(50)`, by an indexed column first; never check rows one by one in code.
4. **Lookups:** load related names for many rows with one `inArray` query, never one query per row.
5. **Checks:** asking the same point's level twice in a request costs nothing the second time.
6. **Seeing it:** previews and `dev` answer every request with a `Server-Timing` header listing each query and its time; the browser's network panel shows it under Timing. Prod logs it for one request in 100, in the Worker's logs, and `db stats` lists the costliest queries.
7. **Pages:** the browser should make one request per action, and redraw only what changed.
8. **Repeat reads:** a JSON read gets an `ETag`, and an unchanged repeat answers `304` by itself; send `cache-control: no-store` on a response that must never be kept, even privately.

## Organizations

With `"auth": { "organizations": true }`, the platform keeps organizations, teams, members and invitations itself, with no roles:

1. **In code:** `app.organizations` has `create`, `list`, `get`, `rename`, `remove`, `requireMember`, `members`, `removeMember`, `invite`, `invitations`, `revokeInvitation`, `accept`, `myInvitations`, `decline`, `teams`, `team`, `createTeam`, `renameTeam`, `removeTeam`, `teamMembers`, `addToTeam` and `removeFromTeam`.
2. **From browsers:** the same under `/api/platform/`: `organizations`, `organizations/:id`, `organizations/:id/members`, `organizations/:id/invitations`, `invitations` (the caller's own), `invitations/:id/accept`, `invitations/:id` (decline), `organizations/:id/teams`, `teams/:id` and `teams/:id/members`.
3. **Who may:** reading needs `read` on the organization's point, renaming `write`, deleting `delete`, inviting and removing others `manage`, creating teams `create`; a team's members need `manage` on its point. Anyone may leave, except the last admin.
4. **Admins:** the creator is the first member of the Admins team; add others with `addToTeam(adminsTeamId, userId)`.
5. **Invitations:** emailed with a link to `/login?invitation=<id>`, accepted by whoever signs in with that confirmed address; an invitation can name a team.

## API tokens

With `"auth": { "apiTokens": true }`, people make personal tokens for scripts:

1. **Screen:** `/tokens` lists, makes and revokes the signed-in person's tokens; link to it from the app's settings.
2. **Sending:** `Authorization: Bearer <token>` on `/api/` outside `/api/auth/`, and on page reads; `requireUser()` returns the token's owner.
3. **Cap:** each token has a level cap, `read` to `manage`; `app.access` checks give it at most that, and a `read` token gets a 403 on anything but GET. Endpoints declared `"user"` or `"anon"` are limited only by that, so put writes behind a point when tokens should not reach them.
4. **Lifetime:** 90 days unless chosen, at most 365.
5. **Never:** on `/api/auth/*` or `/mcp`.

## Tables and migrations

1. **Change** `src/schema.ts`, then run `npx @celsoft/platform db generate`; read and commit the SQL in `drizzle/`.
   For data changes, `db generate --custom <name>` writes an empty migration to fill with SQL; it is the one `drizzle/` file you edit, before it is deployed.
2. **Deploy** applies new migrations; it stops before any change when the schema has changes with no generated migration.
3. **Auth tables** come from the platform; reference users with `user.id` from `@celsoft/platform/schema`.
4. **Ids** are `uuid` filled by Postgres's `uuidv7()`; never supply them.

## Features in `platform.jsonc`

1. **`database`:** `true` turns on a Neon database, in the project `NEON_PROJECT_ID` names in `.env.secrets` beside `NEON_API_KEY`; prod, each preview and `dev` get their own branch. An older `"database": { "neonProject": ... }` stops every command until `npx @celsoft/platform upgrade` moves the id to `.env.secrets`; then run `init` to store it in GitHub.
2. **`email`:** sending from `noreply@<hostname>` through Resend; previews and `dev` capture email instead of sending, except that previews really email the addresses in `"previews": { "sendEmailTo": ["*@yourcompany.com"] }`, so testers can confirm accounts and receive sharing emails.
3. **`auth`:** sign-up and sign-in at `/login`, `/signup`, `/forgot`, `/reset`; `{ "organizations": true }` adds organizations and teams, and `{ "apiTokens": true }` personal API tokens; see those sections above. Needs `database` and `email`.
   `"signup"` is `"invite"` unless set to `"open"`: once the app has its first account (the owner), only invited addresses may sign up. The owner and admins invite at `/invites`, or in code with `app.invites.create(email)`, `list()` and `revoke(id)`; an open organization invitation or a share to an address also lets that address sign up. Never build a sign-up path around it; to open sign-up, set `"open"`.
4. **`files`:** `app.files` in an R2 bucket; previews share one bucket under their PR's folder.
5. **`live`:** rooms over WebSockets; `live: { message: schema, canJoin, canSend, onMessage }` in `defineApp`; browsers use `live()` from `@celsoft/platform/live`. Joining and sending are refused unless `canJoin` and `canSend` say yes.
6. **`mcp`:** serves endpoints with `serve` including `"mcp"` at `/mcp` to AI clients that sign in with OAuth, with the same access checks as the API. Needs `auth`.
7. **`access`:** `app.access`, for who may do what to the app's resources; see Access above. Needs `auth`.
8. **`rateLimit`:** requests a minute one caller may make to `/api/*`, server pages and `/mcp`, 1,200 by default; counted per person, per API token, or per address when signed out, and a bad token also counts against its sender's address; over it, a 429 with `retry-after`.

## Commands

| Command | What it does |
| --- | --- |
| `skills` | Copies these skills into `.claude/skills/`; also runs on install |
| `new` | Writes a new app's files; see `celsoft-platform-setup` |
| `dev` | Runs the app locally on its own `dev` database branch; starts the `dev` script beside it, with `plugins: [platform()]` from `@celsoft/platform/vite` |
| `db generate` | Writes migrations for schema changes |
| `generate` | Rewrites `.platform/`; also runs on install |
| `deploy` / `preview <pr>` | Deploy prod or a PR's preview; CI runs these on push and on pull requests |
| `previews` | Lists the previews that exist |
| `owner reset <email>` | Makes that account the owner and sets its password |
| `db stats [--pr <n>] [--reset]` | Lists the costliest queries, or clears the counts |
| `db run <file> --pr <n>` | Runs a SQL file on a preview's database, such as load test data |
| `--dry-run` | Shows what would change, writing nothing; `new` lists the files it would write and keep; `skills`, `generate`, `upgrade`, `db generate` and `db stats --reset` refuse it |

## Rules

1. **Never edit generated files:** `drizzle/` (except a new `--custom` migration), the workflow and `.platform/`; regenerate them instead.
2. **Never read or print** `.env.secrets`; it holds the deploy tokens.
3. **Resource names are reserved:** anything in the Cloudflare account named after the app, or the app followed by `--`, belongs to the platform.
4. **Failures stop the run:** a failed build, migration or check leaves the running version in place; fix the cause rather than working around it.
5. **No workarounds:** a platform gap stops the work until it is fixed; see Platform gaps above.
