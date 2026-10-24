# CLAUDE.md

The celsoft-com platform repository.

## Design

- **Source of truth:** read [docs/design.md](docs/design.md) before designing or changing
  anything; update it when a design decision changes.

## Code conventions

- **Design:** design and change code following the `codebase-design` skill. If it is not
  available, install it with `npx -y skills add mattpocock/skills --skill codebase-design -g -y`.
- **Commits:** auto-commit, no push
- **Tools:** pin every tool version in this project's `mise.toml` and run tools through
  mise, following the `seanodell-mise-usage` skill. Install nothing globally (`brew`,
  `npm -g`, `pip --user`, `uv tool`, `go install`) unless mise cannot provide the tool, and
  then say why.
- **Tasks:** write automation as mise file tasks under `mise-tasks/`, never as tasks in
  `mise.toml` and never as standalone shell scripts unless a mise task cannot do the job.
  Group related tasks into folders, so `mise-tasks/db/migrate` runs as `mise run db:migrate`.
- **Running things:** at the start of a session run `mise tasks` to learn every task, and
  use a task over the equivalent raw command whenever one exists. Never run `mise exec`;
  when a command needs the mise environment
  (tools, env vars, `.env`), write a mise task for it and run that.
