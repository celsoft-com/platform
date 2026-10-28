// Sends one throwaway API token past the app's per-caller limit on the real Cloudflare binding and
// prints how many requests it took to get a 429, and that 429's wait.
const [base, token, limit = "1200"] = process.argv.slice(2);
if (!base || !token) throw new Error("usage: _limit.mjs <preview url> <token> [limit]");

const most = Math.ceil(Number(limit) * 1.5);
let sent = 0;
let refused;
async function worker() {
  while (!refused && sent < most) {
    sent++;
    const response = await fetch(`${base}/api/notes`, { headers: { authorization: `Bearer ${token}` } });
    await response.arrayBuffer();
    if (response.status === 429) refused ??= { at: sent, wait: response.headers.get("retry-after") };
  }
}
await Promise.all(Array.from({ length: 50 }, worker));
console.log(`${"rate limit (429 near the limit)".padEnd(44)}${refused ? `429 after ${refused.at} of ${limit}, retry-after ${refused.wait}` : `none in ${sent}`}`);
