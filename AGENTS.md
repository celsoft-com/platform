# AGENTS.md

The celsoft-com platform repository. This file is for working on the platform itself; to build
a new app with it, follow [SETUP.md](SETUP.md) instead, in the app's own repo.

## Design

- **Source of truth:** read [docs/design.md](docs/design.md) before designing or changing
  anything; update it when a design decision changes.

- **Guide:** [docs/how-it-works.md](docs/how-it-works.md) explains what the platform provides
  and what an app writes, summary first; update it whenever either side changes.

## Setup

- **Guide:** [SETUP.md](SETUP.md) is the starting point for adopters: install the package,
  run `platform skills`, then follow the
  [celsoft-platform-setup](packages/platform/skills/celsoft-platform-setup/SKILL.md) skill,
  which holds every setup step. Keep both current when setup changes.
- **Dogfood:** this repo is set up and run exactly as the setup skill tells adopters, with
  `apps/demo` as the app; never build repo-only tooling that stands in for a user command.
- **No workarounds in the demo:** the demo exists to prove the platform, so it uses every
  feature the platform's own way; when it cannot, stop and fix or track the platform gap,
  never hand-write around it in the demo.
- **No mise for apps:** this repo runs on mise, but apps never have to; never require mise, or
  write `mise.toml` or any tool manager's files, in what the platform does to an app; what an app
  needs comes through its `package.json`.
- **Secrets:** `platform init` (here `mise run platform -- init`) writes a blank entry in
  `.env.secrets` for each token and reports which are empty. Never read `.env.secrets`.

## Agent skills

- **Shipped skills:** `packages/platform/skills/` is what agents read in every app, at that
  version; update it in the same change whenever what apps write or run changes.

## Issues

- **Tracking:** track things to deal with later as one markdown file each in `tmp/issues/`
  (gitignored, local only); add new ones as they come up and delete a file when it is done.

## Code conventions

- **Design:** design and change code following the `codebase-design` skill. If it is not
  available, install it with `npx -y skills add mattpocock/skills --skill codebase-design -g -y`.
- **Commits:** auto-commit and push every change, so any step can be rolled back
- **Pull requests:** after opening one, give the user the PR link and its preview link, and
  merge only when the user says to; the user tests the preview first.
- **Tools:** pin every tool version in this project's `mise.toml` and run tools through
  mise, following the `seanodell-mise-usage` skill. Install nothing globally (`brew`,
  `npm -g`, `pip --user`, `uv tool`, `go install`) unless mise cannot provide the tool, and
  then say why.
- **Tasks:** write automation as mise file tasks under `mise-tasks/`, never as tasks in
  `mise.toml` and never as standalone shell scripts unless a mise task cannot do the job.
  Group related tasks into folders, so `mise-tasks/db/migrate` runs as `mise run db:migrate`.
- **Task shell:** write tasks in bash (`#!/usr/bin/env bash`), not zsh, so CI runners run
  them without installing anything; keep them compatible with macOS's bash 3.2.
- **Running things:** at the start of a session run `mise tasks` to learn every task, and
  use a task over the equivalent raw command whenever one exists. Never run `mise exec`;
  when a command needs the mise environment
  (tools, env vars, `.env`), write a mise task for it and run that.
