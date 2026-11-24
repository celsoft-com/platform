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
  merge?: { source: { owner: string; name: string }; ref: string; clone: boolean };
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AppRow {
  name: string;
  address: string;
  repo: string;
  dir: string;
  // The repo it was cloned from, and the version of it last merged in.
  source?: string;
  sourceRef?: string;
  deployed?: { ref: string; commit: string; at: string };
  available?: { ref: string; commit: string };
  previews: number[];
  last?: RunView;
}
