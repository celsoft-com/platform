---
name: celsoft-platform
description: "MUST READ before changing an app built on @celsoft/platform: its endpoints, tables and migrations, pages, auth, files, email, live rooms, MCP tools, platform.jsonc, deploys or previews. Matches the installed version of the package."
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
5. **Frontend calls:** a bundled frontend imports `call` from `.platform/client` and calls `call("getNote", { id })`, typed from the endpoints.
6. **Hand-written routes:** the `handler` (first argument, or `undefined`) takes every request no endpoint answers, for uploads, downloads and streaming.

## `app`

Each request gets `app`: `db` (Drizzle, typed with `schema`), `auth`, `session()`, `requireUser()`,
`files` (R2, folders), `email` (`app.email.send(...)`), `live` (`app.live.publish(room, message)`),
`env` and `waitUntil`. Each is created on first use.

## Tables and migrations

1. **Change** `src/schema.ts`, then run `npx @celsoft/platform db generate`; read and commit the SQL in `drizzle/`.
2. **Deploy** applies new migrations; it stops before any change when the schema has changes with no generated migration.
3. **Auth tables** come from the platform; reference users with `user.id` from `@celsoft/platform/schema`.
4. **Ids** are `uuid` filled by Postgres's `uuidv7()`; never supply them.

## Features in `platform.jsonc`

1. **`database`:** a Neon project id; prod, each preview and `dev` get their own branch.
2. **`email`:** sending from `noreply@<hostname>` through Resend; previews and `dev` capture email instead of sending.
3. **`auth`:** sign-up and sign-in at `/login`, `/signup`, `/forgot`, `/reset`; `{ "organizations": true }` adds teams. Needs `database` and `email`.
4. **`files`:** `app.files` in an R2 bucket; previews share one bucket under their PR's folder.
5. **`live`:** rooms over WebSockets; `live: { message: schema, canJoin, canSend, onMessage }` in `defineApp`; browsers use `live()` from `@celsoft/platform/live`. Joining and sending are refused unless `canJoin` and `canSend` say yes.
6. **`mcp`:** serves endpoints with `serve` including `"mcp"` at `/mcp` to AI clients that sign in with OAuth. Needs `auth`.

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

1. **Never edit generated files:** `drizzle/`, the workflow and `.platform/`; regenerate them instead.
2. **Never read or print** `.env.secrets`; it holds the deploy tokens.
3. **Resource names are reserved:** anything in the Cloudflare account named after the app, or the app followed by `--`, belongs to the platform.
4. **Failures stop the run:** a failed build, migration or check leaves the running version in place; fix the cause rather than working around it.
