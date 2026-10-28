// Measures a demo preview: each request's server time and database round trips from its
// Server-Timing header, and the browser-side wait, as percentiles per endpoint; then a short
// burst at a fixed concurrency. Keeps load small, so a run costs pennies.
const [base, rounds = "20", concurrency = "10", burst = "200"] = process.argv.slice(2);
if (!base) throw new Error("usage: _perf.mjs <preview url> [rounds] [concurrency] [burst requests]");

const json = { "content-type": "application/json", origin: base };
let cookie = "";
const send = async (path, init = {}) => {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...json, ...(cookie && { cookie }), ...init.headers } });
  const wait = performance.now() - started;
  const timing = response.headers.get("server-timing") ?? "";
  const total = Number(/total;dur=([\d.]+)/.exec(timing)?.[1] ?? NaN);
  const queries = Number(/db-all;dur=[\d.]+;desc="(\d+) queries"/.exec(timing)?.[1] ?? NaN);
  const body = await response.text();
  return { status: response.status, wait, total, queries, body, setCookie: response.headers.getSetCookie() };
};

const signUp = await send("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ name: "Perf", email: process.env.PERF_EMAIL ?? `perf-${crypto.randomUUID()}@example.com`, password: "a-long-password-1" }) });
cookie = signUp.setCookie.map((c) => c.split(";")[0]).join("; ");
const form = new FormData();
form.set("body", "perf note");
const made = await fetch(`${base}/api/notes`, { method: "POST", headers: { cookie, origin: base }, body: form });
const note = (await made.json()).id;
if (!note) throw new Error("could not make a note");

const endpoints = {
  "session": () => send("/api/auth/get-session"),
  "list my notes": () => send("/api/notes"),
  "read a note": () => send(`/api/public/notes/${note}`),
  "permissions panel": () => send(`/api/notes/${note}/access`),
  "make a link": () => send(`/api/notes/${note}/links`, { method: "POST", body: JSON.stringify({ level: "read" }) }),
  "edit a note": () => send(`/api/public/notes/${note}`, { method: "PUT", body: JSON.stringify({ body: `edited ${Date.now()}` }) }),
  "my organizations": () => send("/api/organizations"),
  "server page": () => send(`/print/${note}`),
  // Loaded by --seed: 61 points deep, readable through the top of its chain.
  ...(process.env.SEEDED && { "deepest note": () => send("/api/public/notes/00000000-0000-4000-8000-00000000dee9") }),
};

const pct = (values, p) => {
  const sorted = values.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN;
};
const ms = (v) => (Number.isNaN(v) ? "-" : `${Math.round(v)}ms`);
const pad = (s, n) => String(s).padEnd(n);

// One warm-up call each, so instance starts do not count against the endpoints.
for (const call of Object.values(endpoints)) await call();

console.log(`${pad("endpoint", 20)}${pad("server p50", 12)}${pad("server p95", 12)}${pad("wait p50", 10)}${pad("wait p95", 10)}queries`);
for (const [name, call] of Object.entries(endpoints)) {
  const runs = [];
  for (let i = 0; i < Number(rounds); i++) runs.push(await call());
  const bad = runs.find((r) => r.status >= 400);
  if (bad) console.log(`  ${name} answered ${bad.status}: ${bad.body.slice(0, 120)}`);
  const queries = [...new Set(runs.map((r) => r.queries))].join("/");
  console.log(`${pad(name, 20)}${pad(ms(pct(runs.map((r) => r.total), 50)), 12)}${pad(ms(pct(runs.map((r) => r.total), 95)), 12)}${pad(ms(pct(runs.map((r) => r.wait), 50)), 10)}${pad(ms(pct(runs.map((r) => r.wait), 95)), 10)}${queries}`);
}

// A short burst of reads at a fixed concurrency: requests per second and percentiles under load.
// The burst is spread over enough API tokens that no one caller meets the per-caller rate limit,
// as many people would spread it.
const tokens = [];
for (let i = 0; i < Math.ceil(Number(burst) / 1000); i++) {
  const made = await send("/api/auth/api-key/create", { method: "POST", body: JSON.stringify({ name: `perf ${i}`, metadata: { cap: "manage" } }) });
  tokens.push(JSON.parse(made.body).key);
}
let turn = 0;
const asToken = (path) => send(path, { headers: { authorization: `Bearer ${tokens[turn++ % tokens.length]}`, cookie: "" } });
const reads = [() => asToken(`/api/public/notes/${note}`), () => asToken("/api/notes"), () => asToken(`/api/notes/${note}/access`)];
const results = [];
let next = 0;
const started = performance.now();
await Promise.all(
  Array.from({ length: Number(concurrency) }, async () => {
    while (next < Number(burst)) {
      const i = next++;
      results.push(await reads[i % reads.length]());
    }
  }),
);
const seconds = (performance.now() - started) / 1000;
const failed = results.filter((r) => r.status >= 400).length;
console.log(
  `\nburst: ${results.length} reads at ${concurrency} at once in ${seconds.toFixed(1)}s, ${(results.length / seconds).toFixed(0)}/s; server p50 ${ms(pct(results.map((r) => r.total), 50))} p95 ${ms(pct(results.map((r) => r.total), 95))}; wait p50 ${ms(pct(results.map((r) => r.wait), 50))} p95 ${ms(pct(results.map((r) => r.wait), 95))}; ${failed} failed`,
);
