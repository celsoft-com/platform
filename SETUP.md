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

## 4. Neon API key

1. **Open:** [API keys](https://console.neon.tech/app/settings/api-keys) in the Neon console.
2. **Type:** a personal key, or an organization key if the app lives in a Neon organization; a project-scoped key cannot create the app's Neon project.
3. **Save:** paste it after `NEON_API_KEY=` in `.env.secrets`.

## 5. Check

Run `mise run secrets:ensure` again. It exits cleanly once every entry is filled.
