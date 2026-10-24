# Setup

One-time setup before this repo can deploy its demo app. Every step is safe to repeat.

## 1. Accounts

1. **Cloudflare:** an account on the Workers Paid plan.
2. **Domain:** your apex domain added as a zone in that same Cloudflare account.
3. **Neon:** an account at [neon.com](https://neon.com).
4. **mise:** installed and activated in your shell ([mise.jdx.dev](https://mise.jdx.dev)).

## 2. Secrets file

Run this from the repo root:

```sh
mise run secrets:ensure
```

It creates `.env.secrets` (gitignored) with a blank entry for each token below, then lists which are still empty. It never prints a value.

## 3. Cloudflare API token

1. **Open:** [API Tokens](https://dash.cloudflare.com/profile/api-tokens), then **Create Token**, then **Create Custom Token**.
2. **Permissions:** add exactly these.

    | Permission | Why the platform needs it |
    |---|---|
    | Account > Workers Scripts > Edit | Deploy and delete Workers, and set their secrets |
    | Account > Hyperdrive > Edit | Create and delete database connection configs |
    | Account > Account Settings > Read | Find the account id |
    | Zone > Workers Routes > Edit | Attach app and preview hostnames |
    | Zone > Zone > Read | Find the zone by its domain |

3. **Account Resources:** Include, your account.
4. **Zone Resources:** Include, Specific zone, your apex domain.
5. **Save:** create the token and paste it after `CLOUDFLARE_API_TOKEN=` in `.env.secrets`.

## 4. Neon project

One Neon project per app. Its default branch is prod; the platform adds a branch per PR.

1. **Open:** the [Neon console](https://console.neon.tech), then **New project**.
2. **Name:** the app's name, such as `demo`.
3. **Region:** the one closest to most of your users.
4. **Postgres version:** the default.
5. **Create:** the console then shows the project's dashboard.
6. **Project ID:** copy it from **Settings**, then **General**; it is not a secret and goes in the app's `platform.jsonc`.

## 5. Neon API key

1. **Open:** your organization's **Settings**, then **API keys**, then **Create new API key**.
2. **Scope:** **Project-scoped**, and pick the project from step 4. It can manage everything inside that project and nothing else.
3. **No organization?** If the project is in a personal account, create a personal key at [API keys](https://console.neon.tech/app/settings/api-keys) instead.
4. **Save:** paste it after `NEON_API_KEY=` in `.env.secrets`.

## 6. Check

Run `mise run secrets:ensure` again. It exits cleanly once every entry is filled.

## 7. Demo values

`apps/demo/platform.jsonc` reads two non-secret values as `${NAME}`, so they stay out of the repo. Put them in a gitignored `.env` at the repo root:

```sh
DEMO_HOSTNAME=demo.example.com          # prod hostname, in your Cloudflare zone
DEMO_NEON_PROJECT=quiet-meadow-12345678 # Neon project id from step 4
```

## 8. Init

Needs the [GitHub CLI](https://cli.github.com) logged in with access to this repo.

```sh
mise run platform -- init --dir apps/demo
```

It checks both tokens can reach your accounts, stores them as GitHub secrets, copies the demo values to GitHub as Actions variables, creates the `production` and `preview` Environments, and writes `.github/workflows/platform.yml`. Commit that file; from then on, pushes to main deploy prod and every PR gets a preview.
