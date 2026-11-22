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
