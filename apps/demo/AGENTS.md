<!-- @celsoft/platform:start -->
## @celsoft/platform

This app is built on @celsoft/platform. Before changing it, read the skills the installed version
ships, starting with `node_modules/@celsoft/platform/skills/celsoft-platform/SKILL.md`; every
skill is a `SKILL.md` under `node_modules/@celsoft/platform/skills/`, also copied to
`.claude/skills/`. To set the app up or deploy it for the first time, follow
`celsoft-platform-setup`. They match the installed version, so read them again after an
upgrade. This block is rewritten on install; edit outside it.

**Never work around the platform.** When it cannot do what the app needs, or does it wrong, stop
and ask the user to request a fix at https://github.com/celsoft-com/platform/issues, saying
what the app needs and what the platform did. Never hand-write the missing piece: no direct
Cloudflare or Neon calls, no edits to generated files or `node_modules`, no copy of a
platform feature in the app. See "Platform gaps" in the `celsoft-platform` skill.
<!-- @celsoft/platform:end -->
