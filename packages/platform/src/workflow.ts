export const WORKFLOW_PATH = ".github/workflows/platform.yml";

export type PackageManager = "pnpm" | "npm";

export interface WorkflowInput {
  appDir: string;
  packageManager: PackageManager;
  secrets: string[];
  variables: string[];
}

// Written by `platform init` and compared by `platform ci`, so it must stay deterministic.
// Each secret and variable is passed by name, so the step only ever sees what the app uses.
export function renderWorkflow({ appDir, packageManager, secrets, variables }: WorkflowInput): string {
  const install = packageManager === "pnpm" ? "pnpm install --frozen-lockfile" : "npm ci";
  const exec = packageManager === "pnpm" ? "pnpm exec platform ci" : "npx --no-install platform ci";
  const setupPnpm = packageManager === "pnpm" ? "\n      - uses: pnpm/action-setup@v4" : "";
  const workingDirectory = appDir === "." ? "" : `\n        working-directory: ${appDir}`;
  const env = [
    ...[...new Set(secrets)].sort().map((name) => `${name}: \${{ secrets.${name} }}`),
    // Config values are stored as secrets too: GitHub prints a step's variables in its public log, but hides secrets.
    ...[...new Set(variables)].sort().map((name) => `${name}: \${{ secrets.${name} }}`),
    "GITHUB_TOKEN: ${{ github.token }}",
  ];

  return `# Written by \`platform init\`; rerun it to update this file.
name: platform

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened]
  # GitHub can skip a pull_request run for a close; pull_request_target needs no merge commit, so it always runs.
  pull_request_target: # zizmor: ignore[dangerous-triggers] the job runs only for this repo's own pull requests
    types: [closed]
  # Once a day, remove any preview whose pull request is closed but was never cleaned up.
  schedule:
    - cron: "17 6 * * *"

concurrency:
  group: platform-\${{ github.event.pull_request.number || (github.event_name == 'schedule' && 'sweep') || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' || github.event_name == 'pull_request_target' }}

permissions:
  contents: read
  pull-requests: write

jobs:
  platform:
    if: github.event_name == 'push' || github.event_name == 'schedule' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: \${{ github.event_name == 'push' && 'production' || 'preview' }}
    steps:
      # A close cleans up with the pull request's own last commit, which knows everything its preview made.
      - uses: actions/checkout@v5
        with:
          ref: \${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || '' }}
          persist-credentials: false${setupPnpm}
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: ${packageManager}
      - run: ${install}
      - run: ${exec}${workingDirectory}
        env:
${env.map((line) => `          ${line}`).join("\n")}
`;
}
