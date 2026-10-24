# {{name}}

Deployed to Cloudflare Workers with a Neon database by [@celsoft/platform](https://github.com/celsoft-com/platform).

## First deploy

1. **Repo:** create a GitHub repo for this directory and push it.
2. **Tokens:** run `npx @celsoft/platform init`; it adds blank token entries to `.env.secrets` and stops.
3. **Fill:** create the tokens described in the platform's [SETUP.md](https://github.com/celsoft-com/platform/blob/main/SETUP.md) and paste them into `.env.secrets`.
4. **Init:** run `npx @celsoft/platform init` again; it stores the tokens in GitHub and writes the deploy workflow.
5. **Migrations:** run `npx @celsoft/platform db generate`; it writes the SQL for `src/schema.ts` to `drizzle/`.
6. **Ship:** commit and push; main deploys to https://{{hostname}}, and every PR gets a preview.

## Your code

1. **API:** `src/worker.ts`, where `defineApp` hands each request `db`, a Drizzle client typed with your tables.
2. **Pages:** `public/`, served as static files.
3. **Tables:** `src/schema.ts`; after changing it, run `npx @celsoft/platform db generate`, read the SQL it writes, and commit it. Each deploy applies new migrations.
4. **Local:** `npx @celsoft/platform dev` runs the app against its own copy of the database, generating migrations as you go.
