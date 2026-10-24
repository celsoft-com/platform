export const WORKFLOW_PATH = ".github/workflows/platform.yml";

export type PackageManager = "pnpm" | "npm";

export interface WorkflowInput {
  appDir: string;
  packageManager: PackageManager;
}

// Written by `platform init` and compared by `platform ci`, so it must stay deterministic.
export function renderWorkflow({ appDir, packageManager }: WorkflowInput): string {
  const install = packageManager === "pnpm" ? "pnpm install --frozen-lockfile" : "npm ci";
  const exec = packageManager === "pnpm" ? "pnpm exec platform ci" : "npx --no-install platform ci";
  const setupPnpm = packageManager === "pnpm" ? "\n      - uses: pnpm/action-setup@v4" : "";
  const workingDirectory = appDir === "." ? "" : `\n        working-directory: ${appDir}`;

  return `# Written by \`platform init\`; rerun it to update this file.
name: platform

on:
  push:
    branches: [main]
  pull_request:
    types: [opened, synchronize, reopened, closed]

concurrency:
  group: platform-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

permissions:
  contents: read
  pull-requests: write

jobs:
  platform:
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    environment: \${{ github.event_name == 'push' && 'production' || 'preview' }}
    steps:
      - uses: actions/checkout@v5${setupPnpm}
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: ${packageManager}
      - run: ${install}
      - run: ${exec}${workingDirectory}
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
          NEON_API_KEY: \${{ secrets.NEON_API_KEY }}
          PLATFORM_SECRETS: \${{ toJSON(secrets) }}
          GITHUB_TOKEN: \${{ github.token }}
`;
}
