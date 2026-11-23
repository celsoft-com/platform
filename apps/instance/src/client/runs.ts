// How a run reads on the pages.

import type { RunView } from "./api";

export const runTone = (state: RunView["state"]) => (({ queued: "info", running: "accent", done: "success", failed: "danger" }) as const)[state];

export function runWord(run: RunView): string {
  const what = run.kind === "cleanup" ? "Cleanup" : run.target.kind === "prod" ? "Deploy" : `Preview ${run.target.pr}`;
  return `${what} ${{ queued: "queued", running: "running", done: "done", failed: "failed" }[run.state]}`;
}

export const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "");
