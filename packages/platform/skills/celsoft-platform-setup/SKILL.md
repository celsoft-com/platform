---
name: celsoft-platform-setup
description: "MUST READ to create a new app on @celsoft/platform, or to set one up to deploy for the first time: accounts, the Neon project, writing the app's files, API tokens, init and the first migration. Matches the installed version of the package."
---

# Setting up a @celsoft/platform app

Walk the user through these steps in order, one at a time. Run every command yourself from the
app's folder; the user only creates accounts and tokens. Every step is safe to repeat. Once the
app deploys, the `celsoft-platform` skill covers changing it.

- **Never read `.env.secrets`:** the user pastes each token into it; `init` reports which are empty.
- **No hand-written setup:** every file below is written by a command; never write them yourself.

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
6. **Node:** version 24 or later.
7. **GitHub CLI:** [gh](https://cli.github.com), logged in with admin access to the repo.

## 2. Neon project

One Neon project per app. Its default branch is prod; the platform adds a branch per PR.

1. **Open:** the [Neon console](https://console.neon.tech), then **New project**.
2. **Name:** the app's name.
3. **Region:** the one closest to most of your users.
4. **Postgres version:** 18 or later; the platform's ids need it.
5. **Project ID:** copy it from **Settings**, then **General**; it is not a secret.

## 3. App

Skip this step if the folder already has a `platform.jsonc`.

```sh
npx @celsoft/platform new --name my-app --hostname app.example.com --neon-project quiet-meadow-12345678
```

It writes `platform.jsonc`, `src/worker.ts`, `src/schema.ts`, `public/`, `tsconfig.json` and a
`README.md`, fills in `package.json` and `.gitignore`, keeps any file already there, then installs
the app's dependencies. The hostname is the prod hostname, in your Cloudflare zone; the Neon
project id is from step 2. Without the flags it asks for each in a terminal.

## 4. Secrets file

```sh
npx @celsoft/platform init
```

The first run adds `.env.secrets` to `.gitignore`, writes a blank entry for each token the app needs, and stops. Steps 5 to 7 fill them in.

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
4. **Save:** paste it after `NEON_API_KEY=` in `.env.secrets`.

## 7. Resend API key

Only if `platform.jsonc` turns on `email` or `auth`. Apps send from their own hostname, so your existing email setup is never touched. Previews only log email, except to the addresses you list in `"previews": { "sendEmailTo": ["*@yourcompany.com"] }`, so your testers can confirm accounts there.

1. **Open:** [API Keys](https://resend.com/api-keys), then **Create API Key**.
2. **Permission:** **Full access**, since the platform adds each app's hostname as a sending domain.
3. **Save:** paste it after `RESEND_API_KEY=` in `.env.secrets`.

## 8. Public repos

Optional. To keep the hostname or Neon project id out of a public repo, write them in `platform.jsonc` as `${NAME}` and put the values in a gitignored `.env` at the repo root:

```jsonc
"hostname": "${APP_HOSTNAME}",
"database": { "neonProject": "${APP_NEON_PROJECT}", ... }
```

```sh
APP_HOSTNAME=app.example.com
APP_NEON_PROJECT=quiet-meadow-12345678
```

`init` stores them as GitHub secrets, so deploy logs hide them too.

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
