import { describe, expect, it } from "vitest";
import { renderWorkflow } from "./workflow.js";

const workflow = renderWorkflow({ appDir: "apps/demo", packageManager: "pnpm", secrets: ["CLOUDFLARE_API_TOKEN"], variables: [] });

describe("renderWorkflow", () => {
  it("closes on pull_request_target, which GitHub starts even when it has no merge commit", () => {
    expect(workflow).toMatch(/pull_request:\n    types: \[opened, synchronize, reopened\]\n/);
    expect(workflow).toMatch(/pull_request_target:.*\n    types: \[closed\]\n/);
  });

  it("cleans up with the pull request's own commit and keeps no credentials in the checkout", () => {
    expect(workflow).toContain("ref: ${{ github.event_name == 'pull_request_target' && github.event.pull_request.head.sha || '' }}");
    expect(workflow).toContain("persist-credentials: false");
  });

  it("sweeps once a day and never for fork pull requests", () => {
    expect(workflow.match(/- cron: /g)).toHaveLength(1);
    expect(workflow).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("keeps no expression inside a run step", () => {
    for (const line of workflow.split("\n").filter((l) => l.trimStart().startsWith("- run:"))) expect(line).not.toContain("${{");
  });
});
