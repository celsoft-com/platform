import { describe, expect, it } from "vitest";
import { waitForHttps } from "./https.js";

function clock(failures: number) {
  let time = 0;
  let calls = 0;
  return {
    calls: () => calls,
    wait: {
      now: () => time,
      sleep: async (ms: number) => void (time += ms),
      fetch: async () => {
        calls++;
        if (calls <= failures) throw new TypeError("fetch failed");
        return new Response(null, { status: 404 });
      },
    },
  };
}

describe("waitForHttps", () => {
  it("retries until the hostname answers, whatever the status", async () => {
    const c = clock(3);
    await waitForHttps("https://pr-4.example.com", c.wait);
    expect(c.calls()).toBe(4);
  });

  it("fails after the timeout, naming the certificate", async () => {
    const c = clock(Infinity);
    await expect(waitForHttps("https://pr-4.example.com", { ...c.wait, timeoutMs: 60_000 })).rejects.toThrow(/https:\/\/pr-4\.example\.com still fails its TLS handshake after 1 minutes: Cloudflare has not issued its certificate yet/);
  });
});
