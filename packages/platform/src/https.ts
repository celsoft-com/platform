export class HttpsError extends Error {}

export interface HttpsWait {
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  everyMs?: number;
}

// Waits until a new hostname answers over HTTPS, since Cloudflare issues its certificate minutes
// after the deploy and the TLS handshake fails until then. Any answer counts, whatever its status.
export async function waitForHttps(url: string, wait: HttpsWait = {}): Promise<void> {
  const { fetch: get = fetch, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, timeoutMs = 10 * 60_000, everyMs = 5_000 } = wait;
  const until = now() + timeoutMs;
  for (;;) {
    try {
      await get(url, { method: "HEAD", redirect: "manual" });
      return;
    } catch {
      if (now() >= until) throw new HttpsError(`${url} still fails its TLS handshake after ${Math.round(timeoutMs / 60_000)} minutes: Cloudflare has not issued its certificate yet; rerun the deploy once it has`);
      await sleep(everyMs);
    }
  }
}
