---
name: celsoft-platform
description: "MUST READ before changing an app built on @celsoft/platform: its endpoints, tables and migrations, pages, auth, files, email, live rooms, MCP tools, item access, platform.jsonc, deploys or previews. Matches the installed version of the package."
---

# Working on a @celsoft/platform app

The app runs on Cloudflare Workers with a Neon Postgres database. The platform owns the Worker,
the cloud resources and the deploys; the app writes its endpoints, tables and pages. Run every
command as `npx @celsoft/platform <command>` from the app's folder. To create an app or deploy it
for the first time, follow the `celsoft-platform-setup` skill instead.

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
| `src/*.test.ts` | The app | Tests through `@celsoft/platform/testing`; see Testing |

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

1. **Inputs:** path parameters, the query and a JSON body merge into one input object; URL strings are converted to the schema's types. A GET carries arrays and objects in bracket notation: `?names[]=a&names[]=b&filter[status]=open`.
2. **Checks:** bad input is a 400; an output that does not match its schema is a 500, logged.
3. **Errors:** throw `EndpointError(status, message)`; a thrown `Response`, as `requireUser()` throws, keeps its status.
4. **Access:** every `/api/` path needs a signed-in user except under `/api/public/`; MCP calls always carry one.
5. **Access:** every endpoint says who may call it, or the app stops at start naming it; the function never runs for anyone refused, over the API and MCP alike.
   - **`{ level: "read" }`:** anyone signed in; an API token capped below the level gets a 403. Use `read` for reads, and `create`, `write`, `delete` or `manage` for what the call changes. Never under `/api/public/`.
   - **`{ point: "id", level: "write" }`:** with `access` on, the caller needs that level on the control point named by the input field, or by a function of the input, or gets a 404.
   - **A list of points:** the function, sync or async, may return several ids; the first that exists is checked, and only that one, so a point that refuses never falls through to the next: ``point: ({ path }) => [`path:${path}`, ...foldersAbove(path), "site"]``. A function returning anything but ids throws.
   - **`"anon"`:** anyone, signed in or not; only under `/api/public/`.
6. **Frontend calls:** a bundled frontend imports `call` from `.platform/client` and calls `call("getNote", { id })`, typed from the endpoints; a refusal throws `EndpointError` with the server's `status` and `message`, and failed validation names each field, such as `body: Too small`.
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
    "/new": route({ access: { level: "read" } }, () => "<h1>New</h1>"),   // text segments win over parameters
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
6. **Access gate:** with `access` on, every route declares who may read it: `{ point: "id", level: "read" }` (a param, or a function of the params), `{ level: "read" }` (anyone signed in) or `"anon"` (anyone); the app refuses every request until each does. It is checked before the handler and the cache.
   - **Refused:** a refused visitor, a missing point and an unmatched path get one 404 page; signed out, it offers Sign in and Sign up, which return to the page. Never build a redirect for it.
   - **Share links:** `/print/7#link=<token>` opens a gated page; the 404 page swaps the token for a cookie and reloads, so put links after `#`, never in the query.
   - **API tokens:** count on page GET and HEAD, capped at their level.
   - **Blind handler:** `app.session()`, `app.requireUser()` and `app.access` throw inside a page's handler; fetch anything personal in the browser from an endpoint.
7. **Errors:** throw `EndpointError(status, message)` for an HTML error page with that status; a 404 is the same 404 page the gate answers, its message only in the logs, so a missing page and a refused one look alike.
8. **Deploy:** claims are read from the Worker's code at deploy and `dev`; there is nothing to configure.
9. **Caching:** a page renders on every request unless its route opts in:
    `route({ cache: true }, async (_, app) => html)` keeps it 60 seconds; `cache: { seconds: 300 }` sets up to 3,600.
    1. **Where:** the platform keeps copies only in Cloudflare's Cache API, which the Worker reads and writes in each data center; every page answer it builds goes out with `cache-control: no-store`, so browsers and anything between keep none.
    2. **What:** a GET answered 200 without `Set-Cookie`; never a HEAD, an error page, a refused 404, the API, or a hand-written handler's answer.
    3. **Key:** the deploy, the page's version, which `invalidate` and `clear` bump, the path and the whole query string, so `/p` and `/p?preview` are separate copies.
    4. **Same for everyone who passes:** the gate runs on every request, hit or miss, before the cache; everyone who passes gets the kept copy, so a page's HTML must depend only on the URL and the data, never on cookies, `accept-language` or location. After a write, invalidate every page showing it, such as `/print/${id}`.
    5. **Drafts and per-person content:** the handler is blind and a query string picks a copy, never who may see it, so `/p?preview` renders for anyone `/p`'s gate lets in, cached or not. Content only some may see, such as drafts, gets its own route gated to them, such as `/preview/*path` with `{ point, level: "write" }`; anything that depends on who is looking is rendered in the browser from an endpoint.
    6. **Uncached answers:** an HTML string goes out `no-store`; a `Response` the handler returns keeps its own headers, so never give it `cache-control: public`.
    7. **Emptying it:** after a write commits, `await app.cache.invalidate("/stats")` empties that page (every query string of it), and `await app.cache.clear()` empties every page; both reach every data center within a second, need a database, and cost one tiny query.
    8. **Which to use:** `invalidate` for ordinary writes, from endpoints, handlers, live messages and jobs alike; `clear` only for rare, sweeping changes, since it makes every page render again, and the logs warn when it runs twice in a minute; if you cannot tell what a write affects, rely on `seconds`.
    9. **Deploys:** every deploy starts empty.
    10. **Seeing it:** the `platform-cache` header is `hit` or `miss`; a hit runs no handler and no query of yours.

## `app`

Each request gets `app`: `db` (Drizzle, typed with `schema`), `auth`, `invites`, `cache`, `session()`, `requireUser()`,
`files` (R2, folders; see `app.files`), `email` (`app.email.send(...)`), `live` (`app.live.publish(room, message)`),
`access` (with `access` on), `organizations` (with organizations on), `env` and `waitUntil`. Each is created on first use.

Code outside the handlers takes `app` as a parameter typed `App`, so `app.db` knows the app's tables:

```ts
import type { App } from "@celsoft/platform";
import * as schema from "./schema";

export async function getSettings(app: App<typeof schema>, id: string) {
  const [row] = await app.db.select().from(schema.settings).where(eq(schema.settings.id, id));
  return row;
}
```

`App<typeof schema, { STRIPE_KEY: string }>` also types the app's own secrets on `app.env`.

`app.env.APP_URL` is the app's own address with no trailing slash: the prod hostname, `https://pr-4.<preview zone>` on preview 4, and the local address in `dev`. Build absolute links from it, such as share links and the MCP address, since an endpoint never sees the request.

## `app.files`

With `"files": true`, `app.files` keeps files in an R2 bucket under paths such as `assets/logo.png`; `/` makes folders.

```ts
await app.files.put("assets/7f3a.png", request.body!, { contentType: "image/png", metadata: { name: "Logo.PNG" } });
const file = await app.files.get("assets/7f3a.png");      // null when missing
file?.metadata.name;                                     // "Logo.PNG"
await app.files.putJson("collections/products/42.json", { title: "Hat" });
await app.files.getJson<{ title: string }>("collections/products/42.json");
return app.files.response("assets/7f3a.png");            // streams it, with its content type; 404 when missing
await app.files.query("collections/books.json", "$[?@.stars == 4]", { limit: 50 });
// { items: [{ path: "$[1]", value: { title: "Emma", stars: 4 } }], total: 1 }; null when missing
```

1. **`put(path, body, options?)`:** `body` is a string, `ArrayBuffer`, `Blob` or `ReadableStream`, such as `request.body`; `options` is a content type string, or `{ contentType, metadata }` with up to 2 KB of string names and values.
2. **`get(path)`:** `{ body, size, httpMetadata: { contentType }, metadata, text() }`, or `null`; `body` is a stream, read once.
3. **`list(folder, { cursor, limit })`:** one page, at most `limit` entries, 1,000 by default and at most: `{ files: [{ path, size, uploaded }], folders: ["a/b/"], cursor }`; pass `cursor` back for the next page, and it is missing on the last. Loop for a whole folder; page an endpoint's own answer straight from it.
4. **`delete(path)`:** removes one file; deleting a missing one is not an error.
5. **`query(path, expression, { limit, offset })`:** runs a JSONPath (RFC 9535) expression over one JSON file and returns `{ items: [{ path, value }], total }`, or `null` when the file is missing.
   - **Paging:** `limit` is 100 by default, 0 to 1,000, with 0 returning only `total`; `offset` skips that many matches; `total` counts them all.
   - **Typed values:** they live in the expression, so `@.stars == 4` and `@.stars == '4'` differ, and a GET query string carries them exactly.
   - **Refused with a 400:** an expression that does not parse, or is over 1,000 characters, or a `match()` or `search()` pattern over 100.
   - **Other refusals:** a file that is not JSON (422) or over 25 MB (413), since each query reads and parses the whole file.
   - **Endpoint input:** `input: z.object({ where: jsonPath() })`, with `jsonPath` from `@celsoft/platform`, refuses a bad expression before the handler, naming where it fails.
   - **JSON already in hand:** `query(data, expression, options)` from `@celsoft/platform` does the same.
6. **Metadata or a table:** metadata goes with the file and is deleted with it, but cannot be searched; anything to query or sort across files belongs in `app.db`, keyed by the path.
7. **Limits:** an upload through the Worker is at most 100 MB; paths with `..` are refused; previews share one bucket under their PR's folder, which `app.files` adds and hides.

## Access

With `"access": true`, the platform keeps who may do what to the app's resources through control points:

1. **A point per resource:** `await app.db.transaction(async (tx) => { ...insert...; await app.access.in(tx).create(row.id, { parent, inherit }); })`.
   The id is the resource's own id, any globally unique string; ids starting `organization:` or `team:` are the platform's. Whoever creates it gets `manage`; creating needs a signed-in user and, with a `parent`, `create` on it.
2. **Levels:** `read` < `create` < `write` < `delete` < `manage`; each includes those below.
3. **Principals:** a person (`{ user }` or a confirmed `{ email }`), `{ team }`, `{ organization }`, `{ everyone: true }` (read only, signed in or not) and `{ owner: true }`, whoever has the owner role when the check runs, so `owner reset` moves it.
4. **Inheritance:** with `inherit: true` a point also uses its parent's grants, up to the first point that does not inherit. Each principal stops at its nearest grant and the highest wins, so a grant to a person on a note can lower that person there, while a grant to a whole organization never lowers its teams.
5. **Grants:** `app.access.grant(point, to, level, { email: { path: "/notes/7" } })`, `revoke`, `grants`, `inherit(point, true)`; all need `manage`. A new grant to a person emails them a link to `path` (`email: false` sends none). Points under an organization take only its own teams and organization, plus people and Everyone.
6. **Links:** `app.access.link(point, level, { expires })` returns a token, at most `write`, good on that one point only; build addresses such as `/#note=7&link=<token>`, and `call()` sends the `#link=` token as the `x-access-link` header and keeps it as a cookie, so plain `<a href>` downloads count it too. Endpoints a signed-out link holder uses go under `/api/public/`.
7. **Endpoints:** every endpoint declares `access: { point: "id", level: "read" }`, `access: { point: (input) => organizationPoint(input.org), level: "create" }`, `access: { level: "write" }` or `access: "anon"`; see Endpoints above.
8. **Check:** `app.access.check(point)` returns the level or throws a 404 below `read`; `require(point, level)` and `can(point, level)` in hand-written routes, `require` also taking a list whose first existing point is checked; `point(id)` returns its parent and whether it inherits.
9. **Lists:** `.where(await app.access.readable(notes.id))` or `allows(level, column)` filters in the same query.
10. **Move and delete:** `move(point, parent)` needs `manage` and `create` on the new parent; `remove(point)` needs `delete` and returns the ids of the point and everything under it, so delete those rows in the same transaction. `points(point)` needs `manage` and lists every point under it, nearest first, each with its parent and whether it inherits.
11. **Static points:** `defineApp(handler, { access: { points: { site: { grants: [{ to: { owner: true }, level: "manage" }] } } } })`, written by every deploy and `dev`; their grants change only in code. A grant to `{ owner: true }` gives the app's owner a point with no organization and no address in code.
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
3. **Cap:** each token has a level cap, `read` to `manage`; `app.access` checks give it at most that, an endpoint declared `{ level }` refuses a token capped below it with a 403, and a `read` token gets a 403 on anything but GET. Send structured reads as GET in bracket notation so read tokens reach them.
4. **Lifetime:** 90 days unless chosen, at most 365.
5. **Never:** on `/api/auth/*` or `/mcp`.

## Tables and migrations

1. **Change** `src/schema.ts`, then run `npx @celsoft/platform db generate`; read and commit the SQL in `drizzle/`.
   For data changes, `db generate --custom <name>` writes an empty migration to fill with SQL; it is the one `drizzle/` file you edit, before it is deployed.
   When a table, column or other name disappears as another appears, drizzle-kit asks whether it was renamed; `db generate` stops, writes nothing, and lists each question with the flags that answer it.
   Answer with `--rename <old>=<new>` or `--create <new>`, such as `--rename users=accounts` or `--rename accounts.full_name=accounts.name`, and run it again; a renamed table can raise new questions about its columns.
2. **Deploy** applies new migrations; it stops before any change when the schema has changes with no generated migration.
3. **Auth tables** come from the platform; reference users with `user.id` from `@celsoft/platform/schema`.
4. **Ids** are `uuid` filled by Postgres's `uuidv7()`; never supply them.

## Features in `platform.jsonc`

1. **`database`:** `true` turns on a Neon database, in the project `NEON_PROJECT_ID` names in `.env.secrets` beside `NEON_API_KEY`; prod, each preview and `dev` get their own branch. An older `"database": { "neonProject": ... }` stops every command until `npx @celsoft/platform upgrade` moves the id to `.env.secrets`; then run `init` to store it in GitHub.
2. **`email`:** sending from `noreply@<hostname>` through Resend; previews and `dev` capture email instead of sending, except that previews really email the addresses in `"previews": { "sendEmailTo": ["*@yourcompany.com"] }`, so testers can confirm accounts and receive sharing emails.
3. **`auth`:** sign-up and sign-in at `/login`, `/signup`, `/forgot`, `/reset`; `{ "organizations": true }` adds organizations and teams, and `{ "apiTokens": true }` personal API tokens; see those sections above. Needs `database` and `email`.
   `"signup"` is `"invite"` unless set to `"open"`: the first account is saved as the owner, and its sign-up reply and session say `role: "owner"`; after it, only invited addresses may sign up. The owner and admins invite at `/invites`, or in code with `app.invites.create(email)`, `list()` and `revoke(id)`; an open organization invitation or a share to an address also lets that address sign up. Never build a sign-up path around it; to open sign-up, set `"open"`.
4. **`files`:** `app.files` in an R2 bucket; see `app.files` above.
5. **`live`:** rooms over WebSockets; `live: { message: schema, canJoin, canSend, onMessage }` in `defineApp`; browsers use `live()` from `@celsoft/platform/live`. Joining and sending are refused unless `canJoin` and `canSend` say yes.
6. **`mcp`:** serves endpoints with `serve` including `"mcp"` at `/mcp` to AI clients that sign in with OAuth, with the same access checks as the API. Needs `auth`.
7. **`access`:** `app.access`, for who may do what to the app's resources; see Access above. Needs `auth`.
8. **`rateLimit`:** requests a minute one caller may make to `/api/*`, server pages and `/mcp`, 1,200 by default; counted per person, per API token, or per address when signed out, and a bad token also counts against its sender's address; over it, a 429 with `retry-after`.

## Testing

`@celsoft/platform/testing` runs the app's real runtime in a test: routing, access checks, token caps, validation and auth are the platform's own code, on a local Postgres, files in memory and captured email. Never build a fake `app` instead.

```ts
import { testApp } from "@celsoft/platform/testing";
import { afterAll, expect, it } from "vitest";
import { items } from "./schema";
import app from "./worker";

const t = await testApp(app);                             // run from the app's folder, or pass { dir }
afterAll(() => t.close());

it("lists items to the signed-in person", async () => {
  const alice = await t.signUp("alice@example.com");      // the first sign-up is the owner
  await t.db.insert(items).values({ name: "first" });
  expect(await t.as(alice).call("listItems", {})).toMatchObject([{ name: "first" }]);
});
```

1. **Database:** each `testApp` gets a database of its own, copied from one migrated with `drizzle/`, static points included; call it in `beforeEach` for a clean database per test. It stops when `src/schema.ts` has changes with no migration.
2. **Postgres:** from the app's `embedded-postgres` dev dependency, which `new` and `upgrade` add and npm installs for each machine, or else Postgres 18 or later on the `PATH`. With pnpm, allow its binaries' install script under `allowBuilds` in `pnpm-workspace.yaml`. One server starts per test process, in about a second, and stops within a second of that process ending.
3. **Calls:** `t.call(name, input)` signed out, `t.as(caller).call(...)` as a person, `t.as({ token })` with an API token; refusals throw `EndpointError` from `@celsoft/platform/client` with its `status` and the server's `message`, so `rejects.toThrow("only the owner may publish")` checks what it says. `t.fetch(path, init)` and `t.as(caller).fetch(...)` reach pages, hand-written routes and `/api/auth/*`.
4. **People:** `t.signUp(email)` signs up through the app's own sign-up, inviting the address first when sign-up is invite-only.
5. **Seen:** `t.db` and `t.files` are the app's own, for seeding and checking; `t.emails` holds every email sent, and `t.published` every live room message, `{ room, message }`. Browsers cannot join live rooms in a test.
6. **Running:** `npm test`, which runs `vitest run`.

## Commands

| Command | What it does |
| --- | --- |
| `skills` | Copies these skills into `.claude/skills/`; also runs on install |
| `new` | Writes a new app's files; see `celsoft-platform-setup` |
| `dev` | Runs the app locally on its own `dev` database branch; starts the `dev` script beside it, with `plugins: [platform()]` from `@celsoft/platform/vite` |
| `db generate` | Writes migrations for schema changes; `--rename <old>=<new>` and `--create <new>` answer its rename questions |
| `generate` | Rewrites `.platform/`; also runs on install |
| `deploy` / `preview <pr>` | Deploy prod or a PR's preview; CI runs these on push and on pull requests; each says `live at` once the hostname answers over HTTPS, waiting up to 10 minutes for a new certificate |
| `previews` | Lists the previews that exist |
| `owner reset <email>` | Makes that account the owner and sets its password |
| `db stats [--pr <n>] [--reset]` | Lists the costliest queries, or clears the counts |
| `db run <file> --pr <n>` | Runs a SQL file on a preview's database, such as load test data |
| `upgrade` | After installing a newer version: rewrites an older `platform.jsonc`, and adds what `new` now writes and the app lacks, such as a test script and `embedded-postgres`, keeping what the app has; review and commit |
| `--dry-run` | Shows what would change, writing nothing; `new` lists the files it would write and keep; `skills`, `generate`, `upgrade`, `db generate` and `db stats --reset` refuse it |

## Rules

1. **Never edit generated files:** `drizzle/` (except a new `--custom` migration), the workflow and `.platform/`; regenerate them instead.
2. **Never read or print** `.env.secrets`; it holds the deploy tokens.
3. **Resource names are reserved:** anything in the Cloudflare account named after the app, or the app followed by `--`, belongs to the platform.
4. **Failures stop the run:** a failed build, migration or check leaves the running version in place; fix the cause rather than working around it.
