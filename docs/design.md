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
    1. **Own resources only**: it changes or deletes only resources named the way Resource Identity says it names the app's.
    2. **Hostnames**: attaches app and preview hostnames in the zone, and never touches a record it did not create.
    3. **Lifecycle**: creates, updates and deletes its own resources, previews included.
    4. **Helper code**: for everything it sets up, the runtime library ships the code that uses it, so apps never hand-write the plumbing.
3. **Line in app code**: see App Code.

## 6. Domains

1. **Split**: resources are named after the app, and hostnames after the prod hostname; a preview hostname is the prod hostname with `pr-<n>.` in front.
2. **One zone, many apps**: the project adds its apex domain, such as `example.com`, to Cloudflare once; every app in that account can live in it.
3. **Prod hostname**: each app picks its own as `hostname` in `platform.jsonc`, either the apex itself or any name below it.
4. **Zone**: the platform tries the hostname, then each parent name, until one is a zone in the account; that zone is the one it works in.
5. **Previews**: `pr-<n>.<hostname>`, directly under the app's prod hostname, so changing the prod hostname moves its previews too.
6. **Email**: prod sends from `noreply@<hostname>`, with Resend's records below that hostname, so the zone's own mail records are never touched; previews never send.
7. **Attached**: each hostname is a custom domain on its Worker, so Cloudflare makes its DNS record and certificate.
8. **Hidden values**: `hostname` may be written as `${NAME}`, filled from a gitignored `.env` locally and a GitHub secret in CI, to keep it out of a public repo.
9. **Examples**:

| Setup | `name` | `hostname` | Zone | Preview for PR 3 | Email from |
| --- | --- | --- | --- | --- | --- |
| **App on the apex** | `shop` | `shop.dev` | `shop.dev` | `pr-3.shop.dev` | `noreply@shop.dev` |
| **App on a subdomain** | `notes` | `notes.example.com` | `example.com` | `pr-3.notes.example.com` | `noreply@notes.example.com` |
| **Second app, same zone** | `blog` | `blog.example.com` | `example.com` | `pr-3.blog.example.com` | `noreply@blog.example.com` |
| **Deeper subdomain** | `api` | `api.tools.example.com` | `example.com` | `pr-3.api.tools.example.com` | `noreply@api.tools.example.com` |

## 7. Resource Identity

1. **Names are identity**: a resource belongs to an app when its name is one the app's names produce, matched in full, never by prefix.
2. **Namespace**: every name the platform makes is the app name, alone or followed by a suffix that starts with `--`.
3. **App names**: 3 to 50 characters of `a-z`, `0-9` and single hyphens, starting with a letter; never `--`, so each name splits into app and suffix one way only.
4. **Length**: 50 leaves room for the longest suffix within the 63-character limit Cloudflare puts on Worker names, bucket names and hostname labels.
5. **Three or more**: a hostname label with `--` in positions 3 and 4 is reserved for internationalized names, such as `xn--`, so `ab--pr-1` is never made.
6. **Reserved**: anything in the account named `<app>` or `<app>--…`, and the bucket `celsoft-platform`, belongs to the platform; never create one by hand.
7. **App claims**: an app name belongs to one repo per Cloudflare account, enforced by a registry.
    1. **Registry**: the account-wide bucket `celsoft-platform` holds one object per app, `apps/<app>.json`, recording the deploying repo's numeric GitHub ID and its `owner/repo` name.
    2. **Claim**: the first deploy writes the object through R2's S3 API with `If-None-Match: *`, so of two first deploys only one lands; R2's REST API ignores that condition.
    3. **Check**: every deploy, cleanup and destroy stops before any change when the claim names a different repo ID; renames and transfers keep the ID, so they pass.
    4. **Move**: the error names the exact `apps move` command that re-points the claim, for when a different repo is meant to take over.
    5. **Release**: `destroy` deletes the claim last.
    6. **Lost registry**: deleting the bucket by hand erases every claim, and each app's next deploy claims its name again.
8. **Placeholders**: `<app>` is `name` in `platform.jsonc`, `<n>` is the PR number, and `<hostname>` is described under Domains.
9. **Nothing written on resources**: identity is never stored on a resource, so Workers carry no platform tags and buckets no marker object; email DNS records are the one exception, since Resend chooses their names.
10. **Destroy**: removes every resource the app's names produce that exists, whatever `platform.jsonc` turns on now; a provider whose key is missing is skipped with a warning.
11. **Earlier names**: versions before the `--` namespace used `-pr-<n>`, `-files` and `-previews`, with tags and a bucket marker as proof.
    1. **Prod bucket**: the first deploy on the new version copies `<app>-files` into `<app>--files`, binds the Worker to it, then deletes the old bucket.
    2. **Old previews**: cleanup and sweep also remove `<app>-pr-<n>` Workers and Hyperdrive configs and the `<app>-previews` bucket, only when they carry the old `app:<app>` tag or marker.
    3. **Dropped**: that old-name code is removed in the next major.
12. **Resources**:

<table>
<thead>
<tr><th>Resource</th><th>Preview name</th><th>Prod name</th><th>Matched by</th><th>Removed by</th></tr>
</thead>
<tbody>
<tr><td colspan="5"><strong>Cloudflare</strong>. Scope is an account ID, the one account <code>CLOUDFLARE_API_TOKEN</code> reaches, shared by every app in it.</td></tr>
<tr><td><strong>Worker</strong></td><td><code>&lt;app&gt;--pr-&lt;n&gt;</code></td><td><code>&lt;app&gt;</code></td><td>Exact name</td><td>Cleanup, sweep, destroy</td></tr>
<tr><td><strong>Hostname</strong></td><td><code>pr-&lt;n&gt;.&lt;hostname&gt;</code></td><td><code>&lt;hostname&gt;</code></td><td>A custom domain of the app's Worker for that PR</td><td>Deleted with its Worker</td></tr>
<tr><td><strong>Hyperdrive config</strong></td><td><code>&lt;app&gt;--pr-&lt;n&gt;</code></td><td><code>&lt;app&gt;</code></td><td>Exact name</td><td>Cleanup, sweep, destroy</td></tr>
<tr><td><strong>R2 bucket</strong></td><td><code>&lt;app&gt;--previews</code></td><td><code>&lt;app&gt;--files</code></td><td>Exact name; one preview bucket is shared by every PR</td><td>Destroy; the prod bucket only with <code>--data</code></td></tr>
<tr><td><strong>App claim</strong></td><td>(none)</td><td><code>apps/&lt;app&gt;.json</code> in <code>celsoft-platform</code></td><td>Exact name</td><td>Destroy, last</td></tr>
<tr><td><strong>Preview files folder</strong></td><td><code>pr-&lt;n&gt;/</code></td><td>(none)</td><td>Exact name, inside the preview bucket</td><td>Cleanup, sweep, and 14-day expiry</td></tr>
<tr><td><strong>Email DNS records</strong></td><td>(none)</td><td><code>resend._domainkey.&lt;hostname&gt;</code>, <code>send.&lt;hostname&gt;</code></td><td>Resend chooses the names, so each record's comment field reads <code>managed by @celsoft/platform for &lt;app&gt;</code></td><td>Destroy</td></tr>
<tr><td colspan="5"><strong>Neon</strong>. Scope is a project ID, <code>database.neonProject</code> in <code>platform.jsonc</code>, which every Neon call names and the only project its project-scoped <code>NEON_API_KEY</code> reaches, checked on every run because only a broader key can list projects; each app has its own project, and prod uses the project's default branch, which the project owns.</td></tr>
<tr><td><strong>Preview branch</strong></td><td><code>pr-&lt;n&gt;</code></td><td>(none)</td><td>Exact name</td><td>Cleanup, sweep, destroy</td></tr>
<tr><td><strong>Backup branch</strong></td><td>(none)</td><td><code>backup-&lt;time&gt;</code></td><td>Name starting <code>backup-</code></td><td>Deploy keeps the newest 3; <code>destroy --data</code></td></tr>
<tr><td><strong>Dev branch</strong></td><td>(none)</td><td><code>dev</code></td><td>Exact name</td><td><code>destroy --data</code></td></tr>
<tr><td colspan="5"><strong>Resend</strong>. Scope is an API key, <code>RESEND_API_KEY</code>, whose account may be shared by several apps; there is no account ID.</td></tr>
<tr><td><strong>Sending domain</strong></td><td>(none)</td><td><code>&lt;hostname&gt;</code></td><td>Exact name</td><td>Destroy</td></tr>
<tr><td><strong>Sending key</strong></td><td>(none)</td><td><code>platform &lt;hostname&gt;</code></td><td>Exact name</td><td>Replaced when a Worker lacks it; destroy</td></tr>
<tr><td colspan="5"><strong>GitHub</strong>. Scope is a repo name, the <code>owner/repo</code> the workflow runs in, from <code>GITHUB_REPOSITORY</code>.</td></tr>
<tr><td><strong>Preview link comment</strong></td><td>(none)</td><td>(none)</td><td>One per PR; its text starts with the hidden HTML comment <code>&lt;!-- platform-preview --&gt;</code></td><td>Never; edited in place on each push</td></tr>
</tbody>
</table>

## 8. Bootstrap

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

## 9. Project Configuration

1. **One file**: `platform.jsonc` at the repo root, validated by a published JSON schema, is everything a project tells the platform.
    1. **App name**: unique within the Cloudflare account; every resource name derives from it, as Resource Identity describes.
    2. **Hostname**: the prod hostname in the zone, apex allowed.
    3. **Worker**: the path to the Worker's entry module.
    4. **Frontend**: the directory holding the built static files, if any; when `package.json` has a `build` script, every deploy runs it first, and a failed build stops the deploy with the running version left in place. Output is static: pages search engines must read without JavaScript are rendered at build time by the app's own tool, such as SvelteKit's static adapter or Astro; anything rendered per request is a server page in the platform's Worker (section 13, item 14).
    5. **Database**: the app's Neon project id; its tables are found in `src/schema.ts` by convention.
    6. **Auth**: on or off, and whether organizations are on; either can change at any time.
    7. **Secrets**: the names of the secrets the app needs; values live in GitHub Environments.
    8. **Compatibility date**: the Workers runtime date the app runs against.
2. **Variables**: any value may be `${NAME}`, filled from a gitignored `.env` locally and from GitHub secrets in CI, so values the project would rather not publish stay out of the repo and its logs; `init` copies them to GitHub as secrets, because GitHub prints Actions variables in public logs.
3. **Derived**: everything else comes from that file and the environment, never written by the project.
    1. **Resource names**: Worker, Neon branch and Hyperdrive config, for prod and each PR.
    2. **Preview hostnames**: one per PR, under the zone.
    3. **Wrangler config**: generated at deploy with the real ids and bindings.

## 10. Deployment Methods

1. **GitHub Actions**: the default; deploys happen without anyone running anything.
    1. **Triggers**: a push to main deploys prod; PR events create, update or delete previews.
    2. **Secrets**: app secrets come from the repo's GitHub Environments.
    3. **Tokens**: the Cloudflare and Neon tokens `init` stored as GitHub secrets.
2. **Local CLI**: a developer runs a command by hand.
    1. **Uses**: trying a deploy before CI is wired, debugging, or recovering from a failed run.
    2. **Secrets and tokens**: both come from a local `.env.secrets` file.
3. **Same result**: both methods run the same CLI commands, so a deploy behaves identically either way.

## 11. Lifecycle

1. **Push to main**: deploys prod.
    1. **Backup**: takes a Neon backup branch of prod, with no compute, keeping only the newest 3.
    2. **Migrate**: runs migrations against prod, then installs the platform's access triggers and functions, fills any missing stored chains, and writes the app's static points.
    3. **Connect**: ensures the prod Hyperdrive config.
    4. **Secrets**: loads `production` Environment secrets onto the Worker.
    5. **Deploy**: deploys the Worker and attaches the prod hostname, with Cloudflare's placement hint set to the Neon project's region, so the Worker runs next to its database.
2. **PR opened or pushed**: creates or updates that PR's preview.
    1. **Branch**: ensures a Neon branch for the PR, copied from prod; a new copy drops prod's auth signing keys, which only prod's secret can decrypt, and Better Auth makes the preview its own. A newly generated auth secret does the same anywhere, and so does a new `dev` branch.
    2. **Migrate**: runs migrations against that branch, then the same access setup as prod.
    3. **Connect**: ensures a Hyperdrive config for that branch.
    4. **Secrets**: loads `preview` Environment secrets onto the preview Worker.
    5. **Deploy**: deploys the preview Worker and attaches its preview hostname.
    6. **Link**: posts or updates the preview link on the PR.
3. **PR closed**: deletes that PR's preview.
    1. **Trigger**: `pull_request_target`, because GitHub can skip a `pull_request` run for a close when the PR's test merge commit is missing; it still runs only for the repo's own PRs.
    2. **Code**: the job checks out the PR's last commit, so the version that made the preview, and its `platform.jsonc`, clean it up.
    3. **By what exists**: cleanup removes whatever it finds for that PR, not only what the config says it made; see Resource Identity.
    4. **Worker**: deletes the preview Worker, its hostname with it.
    5. **Connect**: deletes its Hyperdrive config.
    6. **Branch**: deletes its Neon branch.
    7. **Files**: deletes the PR's folder in the preview bucket.
4. **Daily sweep**: a scheduled run lists every preview, asks GitHub which PRs are still open, and cleans up the rest, for any close whose cleanup never ran.
5. **Rules**: hold for every event.
    1. **Create or reuse**: every step finds by name first, so reruns are safe.
    2. **One run per PR**: a new push cancels the PR's run in progress.
    3. **Fail early**: a failed migration stops the run before deploy, leaving the running version in place.
    4. **Fork PRs**: get no secrets, so no preview.

## 12. Platform Components

1. **CLI**: holds all platform logic.
    1. **`init`**: the bootstrap's platform steps; rerunning it rewrites the workflow.
    2. **`deploy`**: deploys prod.
    3. **`dev`**: runs the app locally against its own `dev` Neon branch, with email captured to the terminal; regenerates migrations on start; when `package.json` has a `dev` script it also starts the frontend's dev server, which forwards the Worker's paths to the local Worker, so edits reload instantly; the package's Vite plugin sets that forwarding up.
    4. **`preview`**: creates or updates a PR's preview.
    5. **`cleanup`**: deletes a PR's preview.
    6. **`ci`**: run by the workflow; reads the GitHub event and runs `deploy`, `preview` or `cleanup`.
    7. **`db generate`**: writes new migrations from the platform's tables and the app's schema; `--custom <name>` writes an empty one the app fills with its own SQL, such as moving data.
    8. **`destroy`**: deletes everything the platform created for an app, prod and previews; `--data` also drops the prod database's tables. It lists what will go, makes the user type the app's name, then asks a final Y/N.
    9. **`upgrade`**: the one command that rewrites an older `platform.jsonc` to the current shape.
    10. **`previews`**: lists every preview that exists, with its pull request's state and the pieces found; changes nothing.
    11. **`apps move`**: gives the app's name to the repo it runs in; only ever suggested by the error that needs it.
    12. **`db run <file> --pr <n>`**: runs a file of SQL on a preview's database in one transaction, such as load test data; it refuses prod.
    13. **`db stats [--pr <n>] [--reset]`**: lists the database's costliest queries from `pg_stat_statements`, turning it on the first time; `--reset` clears the counts before a measured run.
    14. **`--dry-run`**: on any command, prints what would be created, changed or deleted.
    15. **Alignment checks**: every run stops with a fix if `platform.jsonc` has an older shape, the workflow differs from what `init` writes, or the schema has changes with no generated migration.
    16. **Resource modules**: one per resource (Worker, hostname, Neon branch, Hyperdrive config, secrets), each able to find, ensure and destroy it.
2. **Runtime library**: imported by the app's Worker; `defineApp` and its helpers, listed in App Code.
3. **App template**: scaffolds a new app already wired to the platform, through `npm create`.
4. **Agent skills**: the package ships `skills/`, each a `SKILL.md`, describing how to work on an app at that version.
    1. **Version-matched**: they live in `node_modules/@celsoft/platform/skills/`, so upgrading the package upgrades them; nothing is copied into the app.
    2. **Found through AGENTS.md**: `generate`, which runs on install, writes a marked block into the app's `AGENTS.md` pointing agents at them, and rewrites only that block.
    3. **Kept current**: every change to what apps write or run updates the skills in the same pull request.
5. **Deploy workflow**: written into the project by `init`; installs dependencies and runs `platform ci`.
    1. **Environment**: picks `production` for main and `preview` for PRs, which decides the secrets the job receives.
    2. **Concurrency**: cancels a PR's run in progress when a new one starts.

## 13. App Code

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
    7. **Edits**: the platform does not guard against editing a migration that already ran; the app owns its migration history.
5. **Platform provides**: through `defineApp` in the runtime library. How it stays fast on the same hardware is in [performance.md](performance.md).
    1. **Database**: `app.db`, a Drizzle client typed with the app's schema, over one `pg` pool shared with auth.
    2. **Auth routes**: every `/api/auth/*` route (sign-up, sign-in, sign-out, verification, password reset).
    3. **Session**: `app.session()`, looked up once per request, and `app.requireUser()`, which returns the user or answers 401.
    4. **Screens**: login, sign-up, forgot-password and reset pages with a default stylesheet and documented class names; `defineApp({ screens: { stylesheet } })` adds the app's own stylesheet after it.
    5. **Email**: `app.email.send()`, from `noreply@` the app's hostname in prod, captured to logs in previews and local dev. A preview really emails only the addresses in `previews.sendEmailTo` in `platform.jsonc`, such as `*@yourcompany.com`, sending from prod's domain with a Resend key of its own that only sends, made when the preview is and deleted by its cleanup; every other address stays captured, since a preview's database is a copy of prod. Each app sends from its own hostname, so the project's existing email setup is never touched: the platform registers the hostname in Resend and writes its DKIM and bounce records in the zone, tagged as its own. Mail comes from `noreply@`, with no receiving and no reply-to.
    6. **Files**: `app.files` in R2, storing, reading, listing, deleting and serving objects by path, `/` making folders, with JSON helpers; prod has a bucket per app, and previews share one bucket under a per-PR folder, added out of sight, which closing a PR deletes and which expires after 14 days as a backstop.
    7. **Live rooms**: Durable Objects rooms over WebSockets, offered as building blocks with no outside service; rooms carry messages and know nothing about documents or saving, which stay entirely the app's business.
        1. **Switch**: `"live": true` in `platform.jsonc`; no new token permission or account.
        2. **Rooms**: one per name the app chooses, such as `note:123`, each reaching one Durable Object; rooms start on first use and go idle when empty, so cost follows activity, not page count.
        3. **Joining**: browsers open `/api/live/<room>`; the app's `canJoin` decides who may join and refuses by default.
        4. **Sending**: the app's server sends with `app.live.publish(room, message)`; a browser may send to its room when the app's `canSend` allows, refused by default, with each message stamped with the sender's user id, and the app's optional `onMessage` sees every browser message on the server.
        5. **Messages**: any JSON up to 64 KB, delivered unchanged; no save hooks or merge library are built in.
        6. **Message schema**: an optional Zod schema, `live: { message }`, checks every browser message before `onMessage` and types `onMessage` and `app.live.publish`; rooms with several kinds of message use a discriminated union on a `type` field, which the docs show.
        7. **Catch up**: each room numbers its announcements and keeps the last 500 in its own storage; a reconnecting browser gets what it missed, or is told to reload.
        8. **Presence**: each room tracks who is connected and tells everyone on join and leave; quiet connections hibernate at no cost.
        9. **Client**: a small dependency-free browser client, served at `/api/live/client.js` for plain pages and exported from the package for bundled apps such as Svelte, which handles reconnecting and catching up.
        10. **Previews**: each preview Worker has its own rooms, deleted with it.
        11. **Entry file**: deploy generates a hidden entry module exporting the app's handler and the room class, so apps never export platform code.
    8. **Logs**: every Worker has Cloudflare's Workers Logs on; the platform adds no other observability.
6. **Auth behavior**: set by the platform for every app with auth on.
    1. **Private by default**: every `/api/*` route needs a signed-in user except those under `/api/public/`.
    2. **Cross-site forms**: POST, PUT, PATCH and DELETE requests sent as forms are refused unless their Origin is the app's own.
    3. **Cookie cache**: the session cookie carries a signed copy for 1 minute, so a request with a fresh cookie finds its caller without a query, and an active browser pays one session query a minute; a revoked session or a ban reaches every browser within that minute. Better Auth is built once per Worker instance, reaching each request's own connection, and the JWT plugin signs no `set-auth-jwt` header, so finding the session runs no plugin queries either.
    4. **Rate limits**: the Workers rate limiting binding guards sign-in and reset by email address and sign-up by client IP, with no database involved; counts are approximate per Cloudflare location. Every app also limits each caller on `/api/*`, server pages and `/mcp` to `rateLimit` requests a minute from `platform.jsonc`, 1,200 by default, counted per signed-in person, per API token, or per address when signed out, and answers 429 over it, so one caller cannot spend everyone's capacity. A token's allowance is spent before the token is looked up, so a refused token costs no query; a token that fails its check also spends from its sender's address, and an address with none left is refused for a minute before any lookup, so a stream of fake tokens cannot each claim a fresh allowance.
    5. **First owner**: the first account an app creates gets the owner role, through Better Auth's admin plugin.
    6. **Owner recovery**: `npx @celsoft/platform owner reset <email>` makes that account the owner and sets a password typed into the terminal; only people holding the project's tokens can run it, and they already control the app, so no recovery secret ever exists or appears on a screen.
    7. **Signup**: open to anyone.
    8. **Organizations**: the platform's own organizations, teams, members and invitations, behind `auth.organizations` in `platform.jsonc`, replacing Better Auth's organization plugin so no role checks run beside control points; turning it off hides its routes and keeps its tables and data.
        1. **Names**: an organization is the top-level group people join, and a team is a group inside an organization; teams hold no teams. Docs, the skill and the demo use both words only that way.
        2. **No roles**: members carry no roles; who may invite, remove, create teams or change settings is decided by control points, and the built-in Admins team does what an admin role would.
        3. **Membership**: `app.organizations.requireMember(organizationId)` throws a 404 unless the signed-in user belongs, so outsiders cannot tell an organization exists.
        4. **Explicit organization**: endpoints take the organization they act on as an input, such as `/api/orgs/:org/notes`; sessions carry no active organization.
        5. **Owner columns**: `...owner()` from `@celsoft/platform/schema` adds `userId` and an optional `organizationId`, each referencing the platform's tables and deleted with them, for the app's own queries.
        6. **Calls**: `app.organizations` creates, lists, renames and deletes organizations, invites and removes members, and creates teams and changes their members; browsers reach the same under `/api/platform/`, answered by the platform before the app.
        7. **Who may**: each call checks the organization's or the team's point: reading needs `read`, renaming `write`, deleting `delete`, creating teams `create`, and inviting, removing others and changing a team's members `manage`; anyone may leave, except the last admin.
        8. **Invitations**: emailed with a link to `/login?invitation=<id>` and accepted by whoever signs in with that confirmed address, so the id is no secret; an invitation can also name a team. People see the invitations sent to their confirmed address and may accept or decline them.
    9. **Access**: who may do what to an app's resources, through control points in `app.access`; see App Code, Access.
    10. **API tokens**: personal tokens for scripts, behind `"auth": { "apiTokens": true }`, through Better Auth's API key plugin, which stores only hashes; while off, its routes answer 404 and tokens are never accepted, and its table exists whenever auth is on.
        1. **Sending**: `Authorization: Bearer <token>` on `/api/` outside `/api/auth/`, and on server page GET and HEAD; the request runs as the person who made the token. A token is never accepted on `/api/auth/*`, so it can never make tokens, change a password or touch the account, and `/mcp` takes only OAuth tokens.
        2. **Cap**: the creator picks the token's highest level, `read` to `manage`, defaulting to `manage`; every control point check gives it at most that, and a `read` token is refused on every method but GET, HEAD and OPTIONS. Endpoints declared `"none"` are limited only by that method rule.
        3. **Lifetime**: 90 days unless the creator picks another length, at most 365, never unlimited; tokens cannot be updated.
        4. **Making**: only a name, a lifetime and a cap are taken; Better Auth's server-only settings are dropped.
        5. **Screen**: `/tokens`, styled like `/login`, lists the signed-in person's tokens with name, level, last use and expiry, makes one shown exactly once, and revokes; apps may build their own on the same routes, `/api/auth/api-key/create`, `list`, `get` and `delete`.
        6. **Refused**: an unknown, altered, expired or revoked token, one whose owner is gone, or one whose cap is no level, is a 401, even beside a good cookie.
        7. **Checking**: one query reads the token and its owner, refusing a disabled, expired or revoked token and a banned owner; the last use is written at most hourly, which is the accuracy the screen shows.
7. **App writes**:
    1. **API**: routes, request handling and validation, with public routes under `/api/public/`.
    2. **Data**: tables in `src/schema.ts`, reviewed migrations, and every query.
    3. **Pages**: the frontend, any server pages, and any styling of the auth screens.
    4. **Content**: what its own emails say and how its files are organized.
8. **Access**: who may do what to an app's resources, through control points, kept in the app's Postgres database and reached through `app.access`, behind `"access": true` in `platform.jsonc`, which needs auth; its tables exist whenever auth is on.
    1. **Control points**: a control point gates one resource, such as one note, and is where access is checked and where a permissions page appears.
    2. **Identity**: a control point is identified by its resource, any value the app chooses, as long as it is globally unique, such as a note's id.
    3. **Principals**: a person, a team, an organization, or Everyone, which matches every visitor, signed in or not and is granted `read` only; principals only describe who belongs to what.
    4. **Static points**: declared in `defineApp` as `access: { points }`, written by every deploy and `dev` after migrations, never by a request, with their grants replaced each time, so they are reviewed in code and exist before the new code serves; at runtime their grants, links, parent and inheritance cannot change.
    5. **Dynamic points**: created by the app at runtime with `app.access.create(id, { parent, inherit, grants })`, whenever it sees fit, by a signed-in user; whoever creates one is always granted `manage` on it. Ids starting `organization:` and `team:` belong to the platform's own points for organizations and teams, which move and go only with them.
    6. **Parents**: a dynamic point's parent must already exist, and naming it requires at least `create` on it.
    7. **Levels**: one fixed ladder, each level including the ones below it: `read`, `create` (add things under it, such as notes in a team), `write`, `delete`, `manage` (change grants). Apps declare no permissions; an unusual action is mapped onto a level or checked by the app.
    8. **Grants**: a point is granted to one or more principals, each at its own level. Only users with `manage` on a point change its grants and whether it inherits, granting up to `manage`.
    9. **Email grants**: a grant can name an email address, and becomes a grant to that person when they sign up and confirm it.
    10. **Across organizations**: points under an organization can be granted to that organization, its teams and any person, never to another organization or its teams.
    11. **Sharing email**: a new grant to a person or an email address sends them an email from `noreply@` the app's hostname with a link to the path the app gives; the app may give its own `subject` and `text`, or send none; teams, organizations and changed levels get none; it is sent after the answer, so a failed email never fails the grant; previews and local dev capture it, except for the addresses previews may email.
    12. **Inheritance**: a point has its own grants and can also be set to inherit, so a check also uses its parents' grants, walking up until a point that does not inherit.
    13. **Resolving**: each of the user's principals (themselves, their teams, their organizations and Everyone) walks up on its own and stops at its nearest matching grant, and the user gets the highest level across their principals; so a grant to a narrow principal can lower that principal's level on one resource, while a grant to a broad one never lowers a narrower one.
    14. **Links**: an exception to principals; a link carries a secret token and gives anyone holding it, signed in or not, the link's level on that one point only, never walking up or down, until it expires or is revoked; it carries `read`, `create` or `write`, never `delete` or `manage`. A request carries the token in its `x-access-link` header, which the generated browser client fills from the page's `#link=<token>` fragment, so tokens never reach server logs; the client also posts it once to `/api/platform/link`, which keeps it as an HttpOnly cookie for its point so plain links such as downloads and server pages count it; only a hash of each is stored.
    15. **Admins**: every organization has a built-in Admins team whose members always get `manage` on every point under the organization's point; whoever creates an organization joins it, and the platform refuses to remove an organization's last admin.
    16. **Organization and team defaults**: a new organization's point grants the organization `read`, and a new team's point grants the team `write`, both changeable afterwards.
    17. **Creators stay**: a creator's `manage` is a grant to them personally, so it outlasts their leaving a team or organization; admins remove it when needed.
    18. **Checking**: the platform never checks on its own; with access on, each endpoint declares `access: { point, level }`, the point being an input field or a function of the input, or `access: "none"`, and the app answers every request with a 500 naming the endpoint until each does.
    19. **The check**: takes the current user and a point's identifier, and answers 404 when the user has less than `read`, the same as a point that does not exist, so people cannot tell what exists; otherwise it returns the user's level, which the handler compares before writing or deleting.
    20. **Tokens and jobs**: with an API token, a check returns the lower of the owner's level and the token's cap; a background job carries the user it acts for and checks as them; code acting as the app itself uses `app.access.asApp()`, which skips checks.
    21. **Lists**: `await app.access.readable(column)` and `allows(level, column)` are filters for the app's own query, such as `.where(await app.access.readable(notes.id))`, so the database returns only readable rows in one query, with paging and counts still correct.
    22. **Moving**: a platform call changes a point's parent, requiring `manage` on the point and `create` on the new parent; its grants travel with it.
    23. **Deleting**: `app.access.remove(id)` needs `delete`, removes the point and every point under it with their grants and links, and returns their ids so the app deletes those resources in the same transaction; deleting a person, team or organization deletes every grant it holds, and an organization or team takes its points with it.
    24. **Queries**: each point's chain is stored in `access_ancestor`, kept by triggers on `access_point` that the deploy installs, so a check reads it by index instead of walking parents, at most a fixed number of levels as a backstop; a move or an inheritance change rewrites only the chains above the changed point. The rules live in the PL/pgSQL function `platform_access_level`, which each database connection plans once; the caller's teams and organizations are worked out once per statement, so a list filter pays for them once. Within one request a point's level is asked once and remembered until the request changes any grant, link, point or membership; nothing is cached between requests, so a removed member or a revoked grant takes effect on the next request. Every change to the tree (create, move, remove, inheritance) takes one lock, so two at once never leave a stored chain stale. A JSON read gets an `ETag` from its body and `private, no-cache`, so a browser asking again for data that has not changed gets a `304` with no body; the read still runs, so this saves transfer, not database work. Prod logs the `Server-Timing` of one request in 100, never sending it to the caller; previews and `dev` send it on every response.
    25. **Files**: files are stored in R2 under keys that never change, such as `files/<id>`, and where they sit lives only in their points' parents, so moving a file or a whole folder is one row, never a copy.
    26. **Later**: a Durable Object store for grants stays an option if checks ever need to be faster than a Postgres query.
9. **Escape hatches**: every helper exposes the tool underneath, so an app is never boxed in.
    1. **SQL**: `app.db` is Drizzle itself, with raw SQL through its `sql` tag.
    2. **Auth**: `app.auth` is the full Better Auth instance and API.
    3. **Bindings**: `app.env.DB` and `app.env.FILES` are Cloudflare's own bindings.
10. **Auth setup**: owned by the platform and never copied into apps, so upgrades can change it safely; permissions live in control points.
11. **Left out**: GitHub sign-in.
12. **Endpoints**: typed functions an app declares once and serves over its API, MCP, or both; some choices are still open.
    1. **Zod only**: every type an app writes is a Zod schema; whatever the API and MCP need beyond that is the package's wrapping, never the app's.
    2. **Named**: declared by name in `defineApp`'s `endpoints`; the name is the MCP tool name, so it stays stable when a path changes.
    3. **Where served**: each endpoint says `serve: ["api"]`, `["mcp"]` or both; only an API endpoint has a method and path.
    4. **URL inputs**: API endpoints take inputs from the path, the query and the JSON body, merged into one object matching the input schema; MCP passes that object directly.
    5. **Library**: oRPC does the API's path, query and body mapping and string conversion behind the package's wrapper, so apps never see it; MCP is the package's own: the official MCP SDK handles the protocol, and the package registers each MCP endpoint as a tool with its Zod schemas.
    6. **Types**: input and output are Zod schemas, which give the TypeScript types, the runtime checks and the JSON Schema MCP describes tools with.
    7. **Outputs checked**: every response is validated against its output schema; a mismatch is a 500, logged.
    8. **Errors**: a handler fails by throwing one typed error; over HTTP it is that status with `{ error }`, over MCP a tool result with `isError: true` and the message, input check failures included, as MCP asks so a model can correct itself.
    9. **Access**: the existing path rule; `/api/public/` needs no user, every other `/api/` path needs one, MCP calls always carry a signed-in user, and each endpoint declares the control point it checks or that it checks none.
    10. **Hand-written routes**: the `defineApp` handler stays for uploads, downloads, streaming and webhooks; both live in the package's request handling, so the app only writes its functions.
    11. **MCP sign-in**: AI clients connect with OAuth 2.1 served by Better Auth's MCP plugin; a person approves a client once, its calls run as that person, and its registered clients, tokens and consents add auth tables and a consent screen.
    12. **Frontend calls**: frontends call `call("getNote", { id: 42 })` from the package, which builds the URL from the endpoint's path and input and returns the output typed from its Zod schemas; oRPC's client does the URL building underneath, hidden; the paths come from a generated file the frontend imports.
    13. **Generated folder**: the package writes generated files into a gitignored `.platform/` folder in the app, such as the endpoint path list, generated on install, when `dev` starts and at deploy; the deploy's temporary files move there too.
13. **MCP**: the app's MCP endpoints served to AI clients, behind auth.
    1. **Switch**: `"mcp": true` in `platform.jsonc`, which needs auth; off by default, and while off `/mcp`, the OAuth routes and the consent screen do not exist.
    2. **Route**: the app's Worker answers `/mcp` and OAuth discovery under `/.well-known/`; each call is one stateless request, run as the user the token was issued to.
    3. **Tokens**: JWTs bound to the app's `/mcp`, checked against signing keys read from the app's own database, since a Worker cannot fetch its own hostname.
    4. **Screens**: AI clients sign in through the built-in `/login`, which carries the OAuth request through, then approve on a built-in `/consent` screen.
    5. **Tables**: the JWT and MCP plugins' tables are installed for every app with auth, so turning MCP on never needs a migration.

14. **Server pages**: pages the Worker renders on each request, for share previews, pages search engines must read with per-request content, and pages that need the session or the database.
    1. **Claiming a path**: the app claims a path such as `/notes`, and the Worker answers it and everything below it, such as `/notes/7/edit`, with no static file ever served under it and no `*` to write; every path not claimed is still served from the static files.
    2. **Claimable**: plain segments, never the root, a parameter or a trailing slash, so a parameter is never the first segment of a URL and vanity URLs sit under a prefix, such as `/u/ann`; the root stays static, since a claim owns everything below it and `/` would take the whole site; never under a path the platform answers itself, such as `/api`, `/mcp`, `/.well-known` or the sign-in and tokens screens, and never the same as or nested in another claim.
    3. **Pages in code**: `defineApp`'s `pages` declares each with `page({ path, routes })`, such as `routes: { "/": ..., "/:id": ..., "/:id/edit": ... }`, where `"/"` is the claimed path itself; text segments win over parameters, so `/new` beats `/:id`, and a path under the claim that no route matches is a 404.
    4. **Deploy**: the platform reads the claims from the Worker's code, as it reads the endpoints for the browser client, and routes each claim and everything below it to the Worker before static files.
    5. **Parameters**: a route is a function getting its `:name` segments decoded as strings, or `route({ params, access }, handler)`, whose Zod `params` checks and converts them as an endpoint's input does; a value it refuses is a 404.
    6. **Rendering**: a handler returns HTML as a string, sent uncached as `text/html`; server pages are never cached, since only static files are, which Cloudflare serves without the Worker, and turning on Workers Cache would bill every static file request and make a signed-in page leaking to another visitor one platform bug away; or a whole `Response` such as a redirect; it renders with any library the app likes, with `app.db`, `app.session()` and `app.access` available.
    7. **Methods**: pages answer GET and HEAD only; changes go through endpoints.
    8. **Assets**: a claimed page links its CSS, scripts and images from unclaimed paths such as `/assets/`, as the auth screens do with an app stylesheet.
    9. **Errors**: a thrown `EndpointError` is a small HTML page with its status and escaped message.
    10. **Signed-out visitors**: `requireUser()` outside `/api/` redirects to `/login?next=<the page>`, and `/login` returns there after signing in, only ever to a path on the same site.
    11. **Access**: with access on, every route declares `access: { point, level }`, the point a parameter or a function of the parameters, or `access: "none"`, as endpoints do; a refusal is one 404 whether or not the point exists, whose script takes a `#link=` token as item 13 says, and otherwise sends a signed-out visitor to sign in.
    12. **API tokens**: `Authorization: Bearer` is accepted on page GET and HEAD, capped at the token's level as on the API.
    13. **Links on pages**: a refused signed-out page visit answers a tiny page whose script, finding `#link=` in the fragment, posts the token to the platform, which sets an HttpOnly, same-site cookie holding it and reloads; every request with that cookie counts the link, on pages, downloads and the API alike, so the token never appears in a URL the server sees; with no link in the fragment, the script goes to `/login?next=`.
    14. **No framework server builds**: framework apps use their static or build-time output, and anything rendered per request is a server page in the platform's Worker.

## 14. Upgrades

1. **Versioning**: the CLI and runtime library release together under one version.
    1. **One pin**: the project pins a major range of the platform package in `package.json`, the lockfile freezes the exact version, and the workflow runs that CLI version.
    2. **Stable workflow**: the workflow holds no logic, so it rarely changes, and rerunning `init` updates it when it does.
    3. **Template**: used only to create an app, never upgraded.
    4. **One Drizzle**: `drizzle-orm` is a peer dependency, so the app and the platform share one installed copy.
2. **Tested**: any PR that changes the platform version gets a preview with the new version and a prod `--dry-run` of the prod-only steps.
3. **Detection**: the platform acts on what exists, not on version numbers.
    1. **Converge**: every run compares the cloud to what the version wants and fixes the difference.
    2. **Structural changes**: a resource module also finds a resource's old form and converts it.
    3. **Config shape**: the CLI recognizes an older `platform.jsonc` by its fields, with no version number for anyone to write; other commands stop and point to `upgrade`, which rewrites it for the project to review and commit.
4. **Release rules**: what each kind of release may do.
    1. **Minor and patch**: never require project changes beyond committing the migration `db generate` writes when the platform's tables change.
    2. **Compatible within a major**: resource changes only add, so mixed versions and rollbacks keep working.
    3. **Majors only**: breaking runtime changes, new token permissions and new secrets.
    4. **Preflight**: every run checks tokens and secrets first and stops with exact fix instructions.
    5. **One major at a time**: projects never skip a major.
    6. **Latest major**: the only version that gets fixes.
    7. **Additive**: a new feature ships in a minor release, off until a project turns it on in `platform.jsonc`.
5. **Compatibility date**: set by the project in `platform.jsonc`, never changed by the platform.

## 15. Testing

1. **Dogfood**: the platform repo is itself a project, deploying a demo app with the platform as far as it can.
    1. **Demo app**: a real, usable app (proposed: shared notes) living in the repo with its own `platform.jsonc`, in an account and zone the maintainer owns.
    2. **Demo first**: no feature ships until the demo uses it, so the running app always uses everything the platform offers.
        1. **Auth and email**: sign-up, login, verification and reset emails.
        2. **Files**: attachments on notes.
        3. **Live rooms**: team notes inside an organization, changing live with presence.
        4. **MCP**: team notes are tools, plus an MCP-only tool listing the user's teams; the preview smoke test signs in as an AI client and calls them.
        5. **Access**: personal notes shared by email and by link, with a list of notes shared with you.
    3. **Platform PRs**: each gets a demo preview deployed by that PR's CLI build.
    4. **Main**: a merge deploys the demo's prod.
    5. **Release**: publishes to npm only after the main deploy succeeds, using npm trusted publishing. Deferred until an outside project adopts the platform; the first version is published by hand, since trusted publishing needs the package to exist.
2. **Fast tests**: resource modules run against in-memory fakes, covering every event's steps with no cloud account.
3. **Upgrade test**: deploys the demo with the last published version, then the new build, proving the new one converges.
4. **Template test**: scaffolds an app from the template and builds it.
5. **Fork PRs**: get no secrets, so a maintainer runs the end-to-end tests before merging.
