// The Worker's JSON API, as the pages call it.

export interface Build {
  version: string;
  deployedAt?: string;
}

// What a step reports: what it confirmed, and the sentence that stopped it.
export interface StepResult {
  done: string[];
  error?: string;
}

export async function get<T>(path: string): Promise<T | { error: string }> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  return response.json().catch(() => ({ error: `The instance answered ${response.status}; reload to try again.` }));
}

export async function post<T = StepResult>(path: string, body: unknown): Promise<T & { error?: string }> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return response.json().catch(() => ({ done: [], error: `The instance answered ${response.status}; try again.` }));
}

export interface RunView {
  id: string;
  kind: "deploy" | "cleanup";
  target: { kind: "prod" } | { kind: "preview"; pr: number };
  ref: string;
  commit?: string;
  by: string;
  state: "queued" | "running" | "done" | "failed";
  done: string[];
  warnings: string[];
  error?: string;
  log?: string[];
  url?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AppRow {
  name: string;
  address: string;
  repo: string;
  dir: string;
  updates: "push" | "releases" | "branch";
  deployed?: { ref: string; commit: string; at: string };
  available?: { ref: string; commit: string };
  previews: number[];
  last?: RunView;
}

export const UPDATES = [
  { id: "push", label: "On every push to the default branch", note: "Needs the instance's GitHub App on the repo; pull requests get previews." },
  { id: "releases", label: "When you deploy a new release", note: "A newer release shows as available; nothing changes until an admin deploys it." },
  { id: "branch", label: "Follow the default branch", note: "The instance checks every 15 minutes and deploys new commits." },
] as const;
