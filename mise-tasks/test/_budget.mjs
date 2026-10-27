// Holds a preview to its performance budgets, from each response's Server-Timing: the database
// round trips a request makes, and its server time at the median of a few calls. A request over
// budget prints what it cost, so a slowdown fails review like any other wrong answer.
const [base, cookie, note] = process.argv.slice(2);
if (!base || !cookie || !note) throw new Error("usage: _budget.mjs <preview url> <cookie> <note id>");

const headers = { "content-type": "application/json", origin: base, cookie };
const budgets = [
  ["session", 0, 30, () => fetch(`${base}/api/auth/get-session`, { headers })],
  ["list my notes", 1, 60, () => fetch(`${base}/api/notes`, { headers })],
  ["read a note", 2, 60, () => fetch(`${base}/api/public/notes/${note}`, { headers })],
  ["permissions panel", 5, 90, () => fetch(`${base}/api/notes/${note}/access`, { headers })],
  ["make a link", 4, 120, () => fetch(`${base}/api/notes/${note}/links`, { method: "POST", headers, body: JSON.stringify({ level: "read" }) })],
  ["edit a note", 3, 120, () => fetch(`${base}/api/public/notes/${note}`, { method: "PUT", headers, body: JSON.stringify({ body: "budget" }) })],
  ["server page", 2, 60, () => fetch(`${base}/print/${note}`, { headers })],
];

const pad = (s) => String(s).padEnd(44);
for (const [name, queries, ms, call] of budgets) {
  await call();
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const response = await call();
    await response.arrayBuffer();
    const timing = response.headers.get("server-timing") ?? "";
    runs.push({ total: Number(/total;dur=([\d.]+)/.exec(timing)?.[1] ?? NaN), queries: Number(/desc="(\d+) queries"/.exec(timing)?.[1] ?? NaN) });
  }
  const most = Math.max(...runs.map((r) => r.queries));
  const median = runs.map((r) => r.total).sort((a, b) => a - b)[2];
  const ok = most <= queries && median <= ms;
  console.log(`${pad(`budget: ${name}`)}${ok ? "within" : `over: ${most} queries (budget ${queries}), ${Math.round(median)}ms (budget ${ms}ms)`}`);
}
