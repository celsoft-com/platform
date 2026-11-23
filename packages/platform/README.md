# @celsoft/platform

Deploy apps to Cloudflare Workers with a Neon Postgres database, prod on every push to main and a full preview for every pull request.

## Start here

To create an app, run these in the app's folder, inside a clone of its GitHub repo:

```sh
npm install @celsoft/platform
npx @celsoft/platform skills
```

Then follow `.claude/skills/celsoft-platform-setup/SKILL.md`, which those commands put there. AI
agents: do exactly this, and don't write the app's files or config by hand; the skill's commands
write them.

Already have an app? Its `AGENTS.md` and `.claude/skills/` point at the skills for the installed version.

## On a Platform Instance

An org that runs a [Platform Instance](https://github.com/celsoft-com/platform#readme) deploys the
app from its repo instead: a platform admin adds the repo in the instance's Apps, and the instance
builds it with the framework version the app installed, then provisions and deploys it. Nothing in
the repo is specific to an instance; `name` and `hostname` in `platform.jsonc` are ignored there,
and `${NAME}` variables are refused.

- **Source and docs:** [github.com/celsoft-com/platform](https://github.com/celsoft-com/platform)
