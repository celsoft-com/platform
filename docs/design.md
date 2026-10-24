# Workers App Platform

This document is the source of truth for the platform's design. The original [Workers App Platform design page](https://claude.ai/artifact/VLaqjzoBjJ8DFivh2G9QUu) is superseded background: where they differ (Terraform, 1Password, two orgs, a GitHub Action), this document wins.

## 1. Context

Goal: an open-source platform any repo can adopt to deploy its apps on Cloudflare Workers with every feature from the [Workers App Platform design](https://claude.ai/artifact/VLaqjzoBjJ8DFivh2G9QUu), each app isolated from and independent of every other repo, adopters only wiring things up, and the maintainer's ongoing upkeep kept minimal.

## 2. Approach

A published CLI, runtime library and app template that create and reuse each app's cloud resources directly with no Terraform, using GitHub secrets as the secrets source.

## 3. Assumptions

1. **Apex on Cloudflare**: the project's apex domain is a zone in the same Cloudflare account as its Workers.
2. **GitHub hosted**: the project's repo is on GitHub, on a plan that allows Actions.
3. **Range pin**: projects pin a major version range, such as `^1`, not an exact version.

## 4. Tech Stack

1. **Runtime**: what runs a project's app.
    1. **Cloudflare Workers**: runs each app's server code at the edge, billed on CPU time only.
    2. **Static assets**: Workers feature that serves the built frontend from the same deploy, free.
    3. **Neon Postgres**: serverless Postgres whose instant branches give each PR its own database copy.
    4. **Hyperdrive**: Cloudflare's pool of Postgres connections between Workers and Neon, free on Workers Paid.
    5. **Drizzle**: the data layer; apps define tables in TypeScript, and the platform generates and applies the migrations.
    6. **Better Auth**: accounts and sessions as rows in the app's own Postgres, run inside the runtime library.
2. **Delivery**: what deploys it.
    1. **GitHub Actions**: runs the platform on pushes and PR events.
    2. **GitHub Environments**: hold the `production` and `preview` secrets.
    3. **Wrangler**: Cloudflare's CLI, used to deploy Workers and load their secrets.
3. **Platform**: what this repo is built with.
    1. **TypeScript on Node**: the language of the CLI and runtime library.
    2. **npm**: publishes the CLI, runtime library and template.
    3. **Cloudflare and Neon SDKs**: official TypeScript clients the CLI uses to find, create and delete resources.

## 5. Responsibilities

1. **Project**: owns its accounts, zone, Neon project and secrets.
    1. **Accounts**: Cloudflare (Workers Paid), Neon and GitHub, and their billing.
    2. **Zone**: the apex domain's Cloudflare zone and every record the platform did not create.
    3. **Neon project**: one per app, on Postgres 18, in a region of its choosing; the platform manages only branches inside it.
    4. **Tokens**: creates the scoped Cloudflare token and a Neon key scoped to the app's project.
    5. **Secret values**: sets each app's secrets in its GitHub Environments.
2. **Platform**: owns only what it creates.
    1. **Named resources**: everything it creates, found by names derived from the app, and nothing else.
    2. **Hostnames**: attaches app and preview hostnames in the zone, tagging every record it creates.
    3. **Lifecycle**: creates, updates and deletes its own resources, previews included, and never touches untagged records.
    4. **Helper code**: for everything it sets up, the runtime library ships the code that uses it, so apps never hand-write the plumbing.
3. **Line in app code**: see App Code.

## 6. Bootstrap

1. **Project steps**: one time, by hand, before the platform can act.
    1. **Accounts**: create the Cloudflare (Workers Paid) and Neon accounts.
    2. **Neon project**: create the app's Neon project, on Postgres 18.
    3. **Tokens**: create the scoped Cloudflare and Neon tokens and paste them into `.env.secrets`.
2. **Platform steps**: `init`, run from the project's machine; safe to rerun until it completes.
    1. **Prepare**: ensures a gitignored `.env.secrets` exists with a blank entry for every token, each documented with where to create it, and stops until all are filled.
    2. **Verify**: confirms each token reaches the zone, Workers and Neon.
    3. **Store**: saves the tokens as GitHub secrets and creates the `production` and `preview` Environments.
    4. **Wire**: writes the deploy workflow to the repo.
3. **Handoff**: after `init`, the next push to the main branch deploys prod, and every PR gets a preview.

## 7. Project Configuration

1. **One file**: `platform.jsonc` at the repo root, validated by a published JSON schema, is everything a project tells the platform.
    1. **App name**: unique within the Cloudflare account; every resource name derives from it.
    2. **Hostname**: the prod hostname in the zone, apex allowed.
    3. **Worker**: the path to the Worker's entry module.
    4. **Frontend**: the directory holding the built static files, if any.
    5. **Database**: the app's Neon project id; its tables are found in `src/schema.ts` by convention.
    6. **Auth**: on or off, and whether organizations are on; either can change at any time.
    7. **Secrets**: the names of the secrets the app needs; values live in GitHub Environments.
    8. **Compatibility date**: the Workers runtime date the app runs against.
    9. **Config version**: the platform major version the file's shape matches.
2. **Variables**: any value may be `${NAME}`, filled from a gitignored `.env` locally and from GitHub secrets in CI, so values the project would rather not publish stay out of the repo and its logs; `init` copies them to GitHub as secrets, because GitHub prints Actions variables in public logs.
3. **Derived**: everything else comes from that file and the environment, never written by the project.
    1. **Resource names**: Worker, Neon branch and Hyperdrive config, for prod and each PR.
    2. **Preview hostnames**: one per PR, under the zone.
    3. **Wrangler config**: generated at deploy with the real ids and bindings.

## 8. Deployment Methods

1. **GitHub Actions**: the default; deploys happen without anyone running anything.
    1. **Triggers**: a push to main deploys prod; PR events create, update or delete previews.
    2. **Secrets**: app secrets come from the repo's GitHub Environments.
    3. **Tokens**: the Cloudflare and Neon tokens `init` stored as GitHub secrets.
2. **Local CLI**: a developer runs a command by hand.
    1. **Uses**: trying a deploy before CI is wired, debugging, or recovering from a failed run.
    2. **Secrets and tokens**: both come from a local `.env.secrets` file.
3. **Same result**: both methods run the same CLI commands, so a deploy behaves identically either way.

## 9. Lifecycle

1. **Push to main**: deploys prod.
    1. **Backup**: takes a Neon backup branch of prod, with no compute, keeping only the newest 3.
    2. **Migrate**: runs migrations against prod.
    3. **Connect**: ensures the prod Hyperdrive config.
    4. **Secrets**: loads `production` Environment secrets onto the Worker.
    5. **Deploy**: deploys the Worker and attaches the prod hostname.
2. **PR opened or pushed**: creates or updates that PR's preview.
    1. **Branch**: ensures a Neon branch for the PR, copied from prod.
    2. **Migrate**: runs migrations against that branch.
    3. **Connect**: ensures a Hyperdrive config for that branch.
    4. **Secrets**: loads `preview` Environment secrets onto the preview Worker.
    5. **Deploy**: deploys the preview Worker and attaches its preview hostname.
    6. **Link**: posts or updates the preview link on the PR.
3. **PR closed**: deletes that PR's preview.
    1. **Worker**: deletes the preview Worker, its hostname with it.
    2. **Connect**: deletes its Hyperdrive config.
    3. **Branch**: deletes its Neon branch.
4. **Rules**: hold for every event.
    1. **Create or reuse**: every step finds by name first, so reruns are safe.
    2. **One run per PR**: a new push cancels the PR's run in progress.
    3. **Fail early**: a failed migration stops the run before deploy, leaving the running version in place.
    4. **Fork PRs**: get no secrets, so no preview.

## 10. Platform Components

1. **CLI**: holds all platform logic.
    1. **`init`**: the bootstrap's platform steps; rerunning it rewrites the workflow.
    2. **`deploy`**: deploys prod.
    3. **`dev`**: runs the app locally against its own `dev` Neon branch, with email captured to the terminal; regenerates migrations on start.
    4. **`preview`**: creates or updates a PR's preview.
    5. **`cleanup`**: deletes a PR's preview.
    6. **`ci`**: run by the workflow; reads the GitHub event and runs `deploy`, `preview` or `cleanup`.
    7. **`db generate`**: writes new migrations from the platform's tables and the app's schema.
    8. **`destroy`**: deletes everything the platform created for an app, prod and previews; `--data` also drops the prod database's tables. It lists what will go, makes the user type the app's name, then asks a final Y/N.
    9. **`upgrade`**: rewrites `platform.jsonc` to the next major's shape.
    10. **`--dry-run`**: on any command, prints what would be created, changed or deleted.
    11. **Alignment checks**: every run stops with a fix if `platform.jsonc` is an older major, the workflow differs from what `init` writes, or the schema has changes with no generated migration.
    12. **Resource modules**: one per resource (Worker, hostname, Neon branch, Hyperdrive config, secrets), each able to find, ensure and destroy it.
2. **Runtime library**: imported by the app's Worker; `defineApp` and its helpers, listed in App Code. Each roadmap stage adds its helper here.
3. **App template**: scaffolds a new app already wired to the platform, through `npm create`.
4. **Deploy workflow**: written into the project by `init`; installs dependencies and runs `platform ci`.
    1. **Environment**: picks `production` for main and `preview` for PRs, which decides the secrets the job receives.
    2. **Concurrency**: cancels a PR's run in progress when a new one starts.

## 11. App Code

1. **Rule**: the platform writes the plumbing for anything it sets up; the app writes everything about what it does.
2. **Conventions over settings**: where a fixed name or path does the job, the platform uses it instead of a setting.
3. **No app deploys**: the app's API is the Worker entry named by `worker` in `platform.jsonc`, exporting a `defineApp` handler; every platform deploy bundles it with its imports and ships it with the pages, bindings and secrets, so apps never deploy anything themselves.
4. **Schema and migrations**: one flow for the platform's tables and the app's.
    1. **Tables**: the app defines its tables with Drizzle in `src/schema.ts` and references users through `user` from `@celsoft/platform/schema`.
    2. **Generate**: `platform db generate` (and `platform dev` on start) runs `drizzle-kit` over the platform's tables, auth when on, and the app's file, writing timestamped SQL files to `drizzle/` for the app to review and commit.
    3. **Apply**: every deploy applies new files with Drizzle's migrator, against prod after its backup, each PR's own branch, or the `dev` branch locally; the app has no migration script or setting.
    4. **Check**: `platform ci` stops a run whose schema has changes with no generated migration; CI never generates, because rename prompts need a person.
    5. **Shape**: every table's id is a `uuid` filled by Postgres's `uuidv7()`, with snake_case columns and `created_at` and `updated_at`.
    6. **Upgrades**: a platform release that changes its tables shows up as a new generated migration in the app.
5. **Platform provides**: through `defineApp` in the runtime library.
    1. **Database**: `app.db`, a Drizzle client typed with the app's schema, over one `pg` pool shared with auth.
    2. **Auth routes**: every `/api/auth/*` route (sign-up, sign-in, sign-out, verification, password reset, organizations when on).
    3. **Session**: `app.session()`, looked up once per request, and `app.requireUser()`, which returns the user or answers 401.
    4. **Screens**: login, sign-up, forgot-password and reset pages with a default stylesheet and documented class names; `defineApp({ screens: { stylesheet } })` adds the app's own stylesheet after it.
    5. **Email**: `app.email.send()`, from `noreply@` the app's hostname in prod, captured to logs in previews and local dev.
    6. **Files**: `app.files`, storing, reading, listing, deleting and serving objects by path, with a preview's folder added out of sight.
6. **Auth behavior**: set by the platform for every app with auth on.
    1. **Private by default**: every `/api/*` route needs a signed-in user except those under `/api/public/`.
    2. **Cross-site forms**: POST, PUT, PATCH and DELETE requests sent as forms are refused unless their Origin is the app's own.
    3. **Cookie cache**: the session cookie carries a signed copy for 5 minutes, so most requests skip the session query; a revoked session lasts until it expires.
    4. **Rate limits**: the Workers rate limiting binding guards sign-in and reset by email address and sign-up by client IP, with no database involved; counts are approximate per Cloudflare location.
    5. **First owner**: the first account an app creates gets the owner role and a one-time recovery code, through Better Auth's admin plugin.
    6. **Signup**: open to anyone.
    7. **Organizations**: Better Auth's organization plugin, with members, roles, invitations and teams, behind `auth.organizations` in `platform.jsonc`; turning it off hides its routes and keeps its tables and data.
7. **App writes**:
    1. **API**: routes, request handling and validation, with public routes under `/api/public/`.
    2. **Data**: tables in `src/schema.ts`, reviewed migrations, and every query.
    3. **Pages**: the frontend, and any styling of the auth screens.
    4. **Content**: what its own emails say and how its files are organized.
8. **Escape hatches**: every helper exposes the tool underneath, so an app is never boxed in.
    1. **SQL**: `app.db` is Drizzle itself, with raw SQL through its `sql` tag.
    2. **Auth**: `app.auth` is the full Better Auth instance and API.
    3. **Bindings**: `app.env.DB` and `app.env.FILES` are Cloudflare's own bindings.
9. **Auth setup**: owned by the platform and never copied into apps, so upgrades can change it safely; permissions beyond roles live in app tables keyed to `user.id`.
10. **Deferred**: GitHub sign-in stays out; MCP access and API tokens wait for the MCP stage and use Better Auth's plugins.

## 12. Upgrades

1. **Versioning**: the CLI and runtime library release together under one version.
    1. **One pin**: the project pins a major range of the platform package in `package.json`, the lockfile freezes the exact version, and the workflow runs that CLI version.
    2. **Stable workflow**: the workflow holds no logic, so it rarely changes, and rerunning `init` updates it when it does.
    3. **Template**: used only to create an app, never upgraded.
2. **Tested**: any PR that changes the platform version gets a preview with the new version and a prod `--dry-run` of the prod-only steps.
3. **Detection**: the platform acts on what exists, not on version numbers.
    1. **Converge**: every run compares the cloud to what the version wants and fixes the difference.
    2. **Structural changes**: a resource module also finds a resource's old form and converts it.
    3. **Config shape**: `platform.jsonc` records its major version; the CLI stops if it is older, and `upgrade` rewrites it one major at a time.
4. **Release rules**: what each kind of release may do.
    1. **Minor and patch**: never require project changes.
    2. **Compatible within a major**: resource changes only add, so mixed versions and rollbacks keep working.
    3. **Majors only**: breaking runtime changes, new token permissions and new secrets.
    4. **Preflight**: every run checks tokens and secrets first and stops with exact fix instructions.
    5. **One major at a time**: projects never skip a major.
    6. **Latest major**: the only version that gets fixes.
5. **Compatibility date**: set by the project in `platform.jsonc`, never changed by the platform.

## 13. Testing

1. **Dogfood**: the platform repo is itself a project, deploying a demo app with the platform as far as it can.
    1. **Demo app**: a real, usable app (proposed: shared notes) living in the repo with its own `platform.jsonc`, in an account and zone the maintainer owns.
    2. **Grows with the platform**: every roadmap stage adds its feature to the demo, so the running app always uses everything the platform offers.
        1. **Auth and email**: sign-up, login, verification and reset emails, and share notifications.
        2. **Files**: attachments on notes.
        3. **Background work**: emails and cleanup sent from jobs, plus a daily digest.
        4. **Realtime**: live co-editing and presence.
        5. **MCP**: AI clients read and write notes.
        6. **Observability**: errors and traces from the running demo.
    3. **Platform PRs**: each gets a demo preview deployed by that PR's CLI build.
    4. **Main**: a merge deploys the demo's prod.
    5. **Release**: publishes to npm only after the main deploy succeeds, using npm trusted publishing. Deferred until an outside project adopts the platform; the first version is published by hand, since trusted publishing needs the package to exist.
2. **Fast tests**: resource modules run against in-memory fakes, covering every event's steps with no cloud account.
3. **Upgrade test**: deploys the demo with the last published version, then the new build, proving the new one converges.
4. **Template test**: scaffolds an app from the template and builds it.
5. **Fork PRs**: get no secrets, so a maintainer runs the end-to-end tests before merging.

## 14. Roadmap

1. **Foundation**: everything in this plan: prod and previews, Worker with static assets, Neon through Hyperdrive, secrets, `init`, template and upgrades.
2. **Auth and email**: Better Auth run inside the runtime library, not a hosted auth service, with Resend for its email, and previews capturing email instead of sending it.
    1. **Sender**: each app sends from its own hostname, so the project's existing email setup is never touched; the platform registers the hostname in Resend and writes its DKIM and bounce records in the zone, tagged as its own.
    2. **Send only**: mail comes from `noreply@` the app's hostname, with no receiving and no reply-to.
3. **Files**: R2, with a prod bucket per app and previews under a per-PR prefix.
    1. **Helper**: `app.files` stores objects by path, `/` making folders, with JSON helpers and folder listing; a preview's prefix is added for it.
    2. **Cleanup**: closing a PR deletes its folder; the preview bucket also expires files after 14 days as a backstop.
4. **Background work**: Queues and Cron Triggers.
5. **Realtime**: Durable Objects rooms over WebSockets.
6. **MCP**: an MCP server in the runtime library, behind auth.
7. **Observability**: Sentry wired in by the runtime library.
8. **Sweep**: a scheduled cleanup of previews whose PR closed without cleanup running.
9. **Additive**: each stage after Foundation ships as a minor release, off by default until a project enables it in `platform.jsonc`.
10. **Demo first**: no stage ships until the demo app uses it.

