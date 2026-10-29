# Setup

Start every new app the same way, from the app's folder inside a clone of its GitHub repo:

```sh
npm install @celsoft/platform
npx @celsoft/platform skills
```

The first adds the package to `package.json`. The second copies the skills the package ships into
`.claude/skills/` and points `AGENTS.md` at them.

Then follow the setup skill, step by step:
[celsoft-platform-setup](packages/platform/skills/celsoft-platform-setup/SKILL.md), also at
`.claude/skills/celsoft-platform-setup/SKILL.md` in the app. It covers the accounts, the Neon
project, `npx @celsoft/platform new` to write the app's files, the API tokens, `init` and the
first migration. An AI agent reads it and runs each command for you.
