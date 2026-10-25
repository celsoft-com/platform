# AGENTS.md

The celsoft-com platform repository.

## Design

- **Source of truth:** read [docs/design.md](docs/design.md) before designing or changing
  anything; update it when a design decision changes.

- **Guide:** [docs/how-it-works.md](docs/how-it-works.md) explains what the platform provides
  and what an app writes, summary first; update it whenever either side changes.

## Setup

- **Guide:** [SETUP.md](SETUP.md) is the one-time setup for adopters. When a user needs
  help setting up, walk them through it step by step, and keep it current when setup
  changes.
- **Dogfood:** this repo is set up and run exactly as SETUP.md tells adopters, with
  `apps/demo` as the app; never build repo-only tooling that stands in for a user command.
- **Secrets:** `platform init` (here `mise run platform -- init`) writes a blank entry in
  `.env.secrets` for each token and reports which are empty. Never read `.env.secrets`.

## Issues

- **Tracking:** track things to deal with later as one markdown file each in `tmp/issues/`
  (gitignored, local only); add new ones as they come up and delete a file when it is done.

## Code conventions

- **Design:** design and change code following the `codebase-design` skill. If it is not
  available, install it with `npx -y skills add mattpocock/skills --skill codebase-design -g -y`.
- **Commits:** auto-commit and push every change, so any step can be rolled back
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
