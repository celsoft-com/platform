---
name: celsoft-platform-setup
description: "MUST READ to create a new app on @celsoft/platform, or to set one up to deploy for the first time: accounts, the Neon project, writing the app's files, API tokens, init and the first migration. Matches the installed version of the package."
---

# Setting up a @celsoft/platform app

Walk the user through these steps in order, one at a time. Run every command yourself from the
app's folder; the user only creates accounts and tokens. Every step is safe to repeat. Once the
app deploys, the `celsoft-platform` skill covers changing it.

- **Never read `.env.secrets`:** the user pastes each token into it; `init` reports which are empty.
- **No hand-written setup:** every file below is written by a command; never write them yourself, except a copied app's name and hostname (see **Copying an app**).
- **The app's own copy:** run every command from the app's folder after `npm install`; a different version, such as one npx downloads, is refused.

## 0. Start

Already done if you are reading this from the app's `.claude/skills/`.

```sh
npm install @celsoft/platform
npx @celsoft/platform skills
```

The first adds the package to `package.json`; the second copies its skills into `.claude/skills/`
and points `AGENTS.md` at them.

## 1. Accounts and tools

1. **Cloudflare:** an account on the Workers Paid plan.
2. **Domain:** your apex domain added as a zone in that same Cloudflare account.
3. **Neon:** an account at [neon.com](https://neon.com).
4. **Resend:** an account at [resend.com](https://resend.com), needed only if the app sends email or uses auth.
5. **GitHub:** a repo for the app, on a plan that allows Actions, with the app's folder inside a clone of it.
6. **Node:** version 24 or later, installed however you like; every command checks it.
7. **GitHub CLI:** [gh](https://cli.github.com), logged in with admin access to the repo.

## 2. Neon project

One Neon project per app. Its default branch is prod; the platform adds a branch per PR.

1. **Open:** the [Neon console](https://console.neon.tech), then **New project**.
2. **Name:** the app's name.
3. **Region:** the one closest to most of your users.
4. **Postgres version:** 18 or later; the platform's ids need it.
5. **Project ID:** copy it from **Settings**, then **General**; step 6 saves it with the API key.

## 3. App

Skip this step if the folder already has a `platform.jsonc`; for a copy of another app, see **Copying an app** below.

```sh
npx @celsoft/platform new --name my-app --hostname app.example.com
```

It writes `platform.jsonc`, `src/worker.ts`, `src/schema.ts`, `public/`, `tsconfig.json` and a
`README.md`, fills in `package.json` and `.gitignore`, keeps any file already there, then installs
the app's dependencies. The hostname is the prod hostname, in your Cloudflare zone. Without the
flags it asks for each in a terminal. Add `--dry-run` to list what it would write first.

## 4. Secrets file

```sh
npx @celsoft/platform init
```

It adds `.env.secrets` to `.gitignore` and writes a blank entry for each token the app needs, then stops while any is empty. Steps 5 to 7 fill them in.

- **Filled already:** once every token has a value, the same command runs the whole of step 9, so never run it just to see the blanks.

## 5. Cloudflare API token

1. **Open:** [API Tokens](https://dash.cloudflare.com/profile/api-tokens), then **Create Token**, then **Create Custom Token**.
2. **Permissions:** add exactly these.

    | Permission | Why the platform needs it |
    |---|---|
    | Account > Workers Scripts > Edit | Deploy and delete Workers, and set their secrets |
    | Account > Hyperdrive > Edit | Create and delete database connection configs |
    | Account > Account Settings > Read | Find the account id |
    | Account > Workers R2 Storage > Edit | Create file buckets, delete a preview's files when its PR closes, and record which repo owns each app name |
    | Zone > Workers Routes > Edit | Attach app and preview hostnames |
    | Zone > Zone > Read | Find the zone by its domain |
    | Zone > DNS > Edit | Write the email-sending records for each app hostname |

3. **Account Resources:** Include, your account.
4. **Zone Resources:** Include, Specific zone, your apex domain.
5. **Save:** create the token and paste it after `CLOUDFLARE_API_TOKEN=` in `.env.secrets`.

## 6. Neon API key

1. **Open:** your organization's **Settings**, then **API keys**, then **Create new API key**.
2. **Scope:** **Project-scoped**, and pick the project from step 2. It can manage everything inside that project and nothing else; the platform accepts no other kind of key.
3. **Admin:** only an organization admin can create one, so ask yours if the option is missing.
4. **Save:** paste it after `NEON_API_KEY=` in `.env.secrets`, and the project ID from step 2 after `NEON_PROJECT_ID=`.

## 7. Resend API key

Only if `platform.jsonc` turns on `email` or `auth`. Apps send from their own hostname, so your existing email setup is never touched. Previews only log email, except to the addresses you list in `"previews": { "sendEmailTo": ["*@yourcompany.com"] }`, so your testers can confirm accounts there.

1. **Open:** [API Keys](https://resend.com/api-keys), then **Create API Key**.
2. **Permission:** **Full access**, since the platform adds each app's hostname as a sending domain.
3. **Save:** paste it after `RESEND_API_KEY=` in `.env.secrets`.

## 8. Public repos

Optional. The Neon project id already stays out of the repo, in `.env.secrets`. To keep the hostname out too, write it in `platform.jsonc` as `${NAME}` and put the value in a gitignored `.env` at the repo root:

```jsonc
"hostname": "${APP_HOSTNAME}",
```

```sh
APP_HOSTNAME=app.example.com
```

`init` stores it as a GitHub secret, so deploy logs hide it too.

## 9. Init

```sh
npx @celsoft/platform init
```

It checks each token reaches your accounts, stores the tokens as GitHub secrets, creates the `production` and `preview` Environments, and writes `.github/workflows/platform.yml`.

## 10. First migration

```sh
npx @celsoft/platform db generate
```

It writes the SQL for the app's tables in `src/schema.ts`, plus the platform's own tables when auth is on, to `drizzle/`. Commit `drizzle/` and the workflow file, then push; from then on, pushes to main deploy prod and every PR gets a preview.

## Copying an app

When the repo starts as a copy of another app, such as a site made from a shared template, it already has `platform.jsonc`, `drizzle/` and `.github/workflows/platform.yml`.

1. **Name and hostname:** edit `name` and `hostname` in `platform.jsonc` by hand to this app's own; nothing else writes them. A name another repo already deploys is refused.
2. **Neon:** create a project of its own in step 2; never reuse the source app's.
3. **Workflow:** the copied workflow runs on the first push, and fails harmlessly until step 9 stores the secrets. From step 9 on, every push to `main` deploys prod.
4. **Hostname in use:** a deploy refuses a hostname that already has a DNS record the app did not make, or is another Worker's custom domain, and names it. To move a live site onto the app, delete that record where it is managed (in Terraform, if Terraform made it, or it comes back), then at once rerun the refused prod run or push to `main`; the site is down from the delete until that deploy finishes, a few minutes.
5. **Remotes:** keep the app's own repo as `origin`. With a second remote, such as the template as `upstream`, every GitHub call still goes to `origin`, and `init` names the repo before storing a secret.
6. **The rest:** steps 4 to 10 as written; `drizzle/` is kept, and `db generate` adds only what this app's schema changes.
