# Performance

How fast the platform answers, where the time goes, and the design rules that keep it fast. It
covers every part of a request, from the visitor's browser to Postgres and back. Each section
says what is true **today** and what is **proposed**; nothing proposed is decided until it moves
into [design.md](design.md). The open decisions are on the
[performance decisions page](https://claude.ai/artifact/K11uC7jybNXceuoKYHajYR).

## 1. Problem

With one user, simple requests take 0.3 to 1.3 seconds. Reading one note took over 400ms on the
server, the permissions panel 460ms, and one Make a link click about 3 seconds in the browser.
None of that is the app's own work: the app's queries are a small share of it.

## 2. Goals (proposed)

1. **Budget:** a signed-in API read, such as reading one note, answers in under 100ms on the
   server, measured on a preview from a warm Worker instance.
2. **Query count:** a read costs the app's own queries plus at most one access check, with no
   query from the platform for the session.
3. **No writes on reads:** a request that changes nothing writes nothing.
4. **One action, one request:** a click in the demo makes one request, unless it truly needs more.
5. **Measured, not guessed:** every claim about speed comes from a trace or a test.

## 3. Anatomy of a request

Every API request passes through these steps, in order. Each costs time, and the steps marked
"per query" repeat for every database query.

| # | Step | Today | Cost seen |
| --- | --- | --- | --- |
| 1 | Browser to Cloudflare | TLS to the nearest Cloudflare location | 25 to 120ms, outside the platform |
| 2 | Worker instance start | Only when a new instance is needed; loads the whole bundle | 0.4 to 0.6s, inferred |
| 3 | Database connection | A `pg` pool per request, through Hyperdrive | 0 to 44ms per connection |
| 4 | Session | Better Auth, built per request; the session comes from a signed cookie | 60 to 170ms, two queries |
| 5 | Static control points | Written once per Worker instance before its first check | 7 queries, about 250ms, when it happens |
| 6 | Access check | One recursive query per check | 15 to 50ms each, often repeated |
| 7 | The app's own queries | Whatever the handler runs | 15 to 50ms per query |
| 8 | Response | Output checked against its schema | negligible |

## 4. Measured baseline

From the `Server-Timing` trace on the PR 18 preview, two Make a link clicks:

| Request | Browser time | Server total | Queries |
| --- | --- | --- | --- |
| Make the link | 0.3 to 1.1s | 109 to 613ms | 6 to 13 |
| Read the note | 1.0 to 1.3s | 261 to 451ms | 12 |
| Permissions panel | 1.0 to 1.2s | 636 to 740ms | 18 |
| List my organizations | 0.3 to 0.4s | 101 to 149ms | 3 |

1. **Server share:** the server's own total is half or less of what the browser waits; the rest
   is reaching Cloudflare and, more often than not, starting a Worker instance.
2. **App share:** in the 12 queries that read a note, one is the note itself.

## 5. Causes and design, layer by layer

### 5.1 Distance to the database

1. **Today:** a Worker runs in the Cloudflare location nearest the visitor. Neon runs in one AWS
   region. Every query crosses that distance, even `begin` and `commit`, which do no work, and
   queries in a request run one after another, so the distance is paid once per query.
2. **Effect:** 15 to 50ms per query; 18 queries is about 630ms.
3. **Proposed:** the deploy sets Cloudflare's placement hint to the Neon project's region, read
   from Neon, so the Worker runs in the Cloudflare location closest to the database
   ([placement](https://developers.cloudflare.com/workers/configuration/placement/)). A visitor
   far away then makes one long trip to the Worker instead of the Worker making many.
4. **Not affected:** static files are always served nearest the visitor.
5. **Rule:** the number of database round trips per request is the main cost to design against;
   fewer, larger queries beat many small ones.

### 5.2 Worker startup

1. **Today:** a new Worker instance loads the whole bundle: Better Auth and its plugins, Drizzle,
   `pg`, oRPC, Zod and the MCP SDK, whether the request needs them or not. Cloudflare starts new
   instances often, so many requests pay for it.
2. **Effect:** inferred from the gap between the browser's wait and the server's total, 0.4 to
   0.6s on most requests; not measured directly.
3. **Proposed:** measure startup time and bundle size on a preview first; then load rarely used
   parts, starting with the MCP SDK, only on the requests that use them.
4. **Rule:** a dependency in the Worker's import graph costs every cold request; heavy ones load
   on demand.

### 5.3 Database connections

1. **Today:** each request opens its own `pg` pool through Hyperdrive, lazily, and closes it after
   the answer. Hyperdrive keeps the real connections to Neon warm, so opening one costs a
   round trip to Hyperdrive, not a new Postgres connection.
2. **Hyperdrive caching:** turned off on every config the platform makes, so a read never returns
   stale rows; access checks depend on that, since a cached check would keep a revoked grant
   working.
3. **Transactions:** `begin` and `commit` are round trips like any query; a transaction of two
   writes costs four.
4. **Rule:** a Worker cannot share a connection between requests, so per-request pools stay; the
   saving comes from fewer queries, not fewer connections.

### 5.4 Session

1. **Today:** Better Auth is built on every request with every plugin the platform uses: admin,
   API keys, JWT and MCP. The session itself comes from a signed cookie, refreshed from the
   database at most every 5 minutes, yet every lookup runs two queries on `oauth_resource` and
   `jwks`, tables of the MCP sign-in plugins. What triggers them is not pinned down yet.
2. **Effect:** 60 to 170ms on every signed-in request.
3. **Proposed:** find the trigger and remove those queries: load the MCP and JWT plugins only when
   MCP is on, and keep what they read, such as signing keys, per Worker instance.
4. **Rule:** a fresh session cookie answers who is calling without a query.

### 5.5 Access checks

1. **Today:** one recursive query answers a level on one point, walking up its parents; list
   filters put the same logic into the app's own query, so a list is one query, not one per row.
2. **Repeats:** an endpoint's declared check runs, then the handler often asks again, through
   `check`, `level`, `require`, or the platform's own calls such as `link` and `grant`, which
   check `manage` themselves. Reading a note checks twice; the permissions panel checks six times.
3. **Proposed:** within one request, `app.access` remembers each point's level after the first
   check and forgets everything when the request changes any grant, link, parent or point.
4. **Rule:** a request asks the database about one point's level once.

### 5.6 Static control points

1. **Today:** `defineApp({ access: { points } })` is written to the database before the first
   check of each Worker instance, in one transaction of about 7 queries.
2. **Effect:** 3 of 8 traced requests paid about 250ms for it, on requests that changed nothing.
3. **Proposed:** the deploy writes them after migrations, and `dev` on start; requests never do.
4. **Rule:** anything that changes only with code is applied at deploy, never during requests.

### 5.7 The app's own queries

1. **Today:** handlers run their queries one after another, as written.
2. **Rule:** independent queries run together with `Promise.all`; a list is filtered in the
   database with `app.access.readable`, never checked row by row.
3. **Skill:** the shipped skill should teach both, so apps built on the platform start fast.

### 5.8 Static files

1. **Today:** served by Cloudflare from the location nearest the visitor without running the
   Worker, free and cached.
2. **Decided:** stays that way; Workers Cache is not used, since it would bill every static file
   request ([design.md](design.md), section 13, item 14).

### 5.9 Server pages

1. **Decided:** never cached, so every visit runs the Worker and the handler; their speed is the
   speed of everything above.
2. **Rule:** a page that must be fast for everyone and is the same for everyone is rendered at
   build time as a static file.

### 5.10 The browser

1. **Today:** the demo redraws a whole page after any change, re-running every request the page
   made, one after another; one Make a link click made four requests.
2. **Proposed:** an action redraws only the part it changed, and a page fetches independent data
   in parallel.
3. **Rule:** the demo shows how apps should use the platform, so it follows the same budget.

### 5.11 Live rooms, MCP and background work

1. **Live rooms:** a join checks the app's `canJoin` once; messages then flow through the room's
   Durable Object without the database unless the app's `onMessage` queries.
2. **MCP:** every call is one stateless request whose OAuth token the MCP sign-in plugin verifies,
   with the same plugins built per request as in 5.4.
3. **Background work:** email and similar side effects run after the answer with `waitUntil`, so
   they never slow the response.

## 6. Measuring

1. **Server-Timing:** every response on a preview and in local dev lists each database query by
   its verb and tables with its time, connections, the session lookup and the server's total;
   the browser's network panel shows them under Timing. Prod never sends them.
2. **Reading it:** `db-all` against `total` shows how much of a request is the database;
   repeated entries show repeated work.
3. **Proposed, budgets in the smoke test:** `mise run test:preview` fails when a traced request
   goes over its query count or server time budget, so a slowdown blocks a merge like a bug.
4. **Not covered yet:** load, many users at once, and startup time, which needs its own
   measurement.

## 7. Open decisions

Each proposal above is an item on the
[performance decisions page](https://claude.ai/artifact/K11uC7jybNXceuoKYHajYR), except the
goals in section 2 and the budgets in section 6.3, which this document proposes for the first
time.
