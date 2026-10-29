# {{name}}

Deployed to Cloudflare Workers with a Neon database by [@celsoft/platform](https://github.com/celsoft-com/platform).

## First deploy

Follow `.claude/skills/celsoft-platform-setup/SKILL.md` from "Secrets file". Once it is done, main
deploys to https://{{hostname}}, and every PR gets a preview.

## Your code

Read `.claude/skills/celsoft-platform/SKILL.md` before changing the app. Every install rewrites
the skills to match the installed version of the package.

1. **API:** `src/worker.ts`, where each `endpoint` is a typed function with Zod schemas for its input and output, given `db`, a Drizzle client typed with your tables.
2. **Calling endpoints:** a bundled frontend imports `call` from `.platform/client.ts`, which the platform generates on install, and calls `call("listItems", {})`; never edit or commit `.platform/`.
3. **Pages:** `public/`, served as static files.
4. **Tables:** `src/schema.ts`; after changing it, run `npx @celsoft/platform db generate`, read the SQL it writes, and commit it. Each deploy applies new migrations.
5. **Local:** `npx @celsoft/platform dev` runs the app against its own copy of the database, generating migrations as you go.
