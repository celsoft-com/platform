# Performance

How the platform gets the most out of the hardware it already runs on, from one user to a sizable
user base: where a request's time and load go today, and the design that removes them. Each
section says what is true **today** and what is **proposed**; nothing proposed is decided until it
moves into [design.md](design.md). The open decisions are on the
[performance decisions page](https://claude.ai/artifact/K11uC7jybNXceuoKYHajYR).

## 1. Problem

The platform is slow at one user. Simple requests take 0.3 to 1.3 seconds: reading one note took
over 400ms on the server, the permissions panel 460ms, and one Make a link click about 3 seconds
in the browser. The hardware is not the cause: in the 12 queries that read a note, one is the
note, and the other 11 are the platform's own overhead. Waste that costs time at one user costs
capacity at many, so the same hardware serves far fewer people than it could.

## 2. The rule

**Scale by design, never by adding resources.** The platform must make the most of exactly the
hardware and regions an app has today:

1. **Fixed:** the app's current Neon compute size, its one region, its Hyperdrive config and its
   Workers plan. No larger compute, no read replicas, no new regions, no paid add-ons.
2. **Allowed:** any change to the platform's design and code, including new software layers built
   on what already runs: Worker memory, the Durable Objects already deployed for live rooms, the
   browser, and Cloudflare's placement of the Worker within the app's existing region.
3. **Reworking is fine:** where the current design wastes the hardware, it is redesigned, however
   much that touches.
4. **Measure of success:** requests per second the same hardware sustains within the speed
   targets, found by load testing that hardware (section 8).

## 3. Targets (proposed)

### 3.1 Work per request

The hardware's capacity is spent on these, so they are the primary targets.

1. **Database round trips:** a read is one round trip; a write is the round trips its own writes
   need and nothing more. Today a note read is 12.
2. **Platform queries:** zero on a steady-state request: no query to find the session, no query
   for static points, and access answered inside the app's own query or without the database.
3. **No writes on reads:** a request that changes nothing writes nothing.
4. **CPU:** nothing built per request that could be built once per Worker instance.
5. **Browser:** one action makes one request.

### 3.2 Speed

1. **Read:** under 30ms on the server at the median, under 100ms at the 99th percentile.
2. **Write:** under 60ms on the server at the median.
3. **Browser:** a click in the demo shows its result in under 300ms for a visitor in the app's
   region.

### 3.3 Capacity

1. **Ceiling:** the requests per second the current hardware sustains within 3.2, measured by the
   load test, before and after each change; every change in section 6 is judged by how far it
   raises that number.

## 4. Anatomy of a request today

| # | Step | Today | Cost seen |
| --- | --- | --- | --- |
| 1 | Browser to Cloudflare | TLS to the nearest Cloudflare location | 25 to 120ms |
| 2 | Worker instance start | When a new instance is needed; loads the whole bundle | 0.4 to 0.6s, inferred |
| 3 | Database connection | A `pg` pool per request, through Hyperdrive | 0 to 44ms |
| 4 | Session | Better Auth, built per request; 2 queries on MCP plugin tables | 60 to 170ms |
| 5 | Static control points | Rewritten per Worker instance | 7 queries, about 250ms, when it happens |
| 6 | Access check | One recursive query, repeated 2 to 6 times per request | 15 to 50ms each |
| 7 | The app's queries | One after another | 15 to 50ms each |
| 8 | Response | Output checked against its schema | CPU only |

Measured on the PR 18 preview with `Server-Timing`, one user:

| Request | Browser time | Server total | Queries |
| --- | --- | --- | --- |
| Make the link | 0.3 to 1.1s | 109 to 613ms | 6 to 13 |
| Read the note | 1.0 to 1.3s | 261 to 451ms | 12 |
| Permissions panel | 1.0 to 1.2s | 636 to 740ms | 18 |
| List my organizations | 0.3 to 0.4s | 101 to 149ms | 3 |

## 5. Where the waste is

1. **Distance:** each query costs 15 to 50ms even when it does nothing, such as `begin`; the
   Worker runs near the visitor, not near the database, and pays the distance per query.
2. **Repeated work:** the same access check runs 2 to 6 times; static points are rewritten by
   instances that changed nothing; Better Auth and its plugins are rebuilt on every request.
3. **Unneeded work:** the session lookup queries MCP sign-in tables although the session comes from
   a signed cookie.
4. **Serial work:** every query waits for the one before it, including ones that do not depend on
   each other.
5. **Chatty clients:** one click redraws a whole page with four requests, each paying all of the
   above.

## 6. Design

### 6.1 Run next to the database

1. **Proposed:** the deploy sets Cloudflare's placement hint to the Neon project's region, read
   from Neon, so the Worker runs in the Cloudflare location closest to the database
   ([placement](https://developers.cloudflare.com/workers/configuration/placement/)). Same
   region, same hardware; only where the code runs changes.
2. **Effect:** every round trip shrinks; a far visitor makes one long trip to the Worker instead of
   the Worker making many to the database.
3. **Capacity:** shorter queries hold connections for less time, so the same connection limit
   serves more requests.

### 6.2 One round trip per request

The largest lever on fixed hardware: Postgres does work per statement and per round trip, so a
request that needs one should send one.

1. **Access inside the app's query (proposed):** an endpoint's declared check becomes a condition
   of the app's own query wherever it can, as list filters already are, so reading a note is one
   statement that returns the note only if the caller may read it, with the caller's level as a
   column. The separate check stays for writes and hand-written routes.
2. **Batching (proposed):** queries that do not depend on each other go out together, in one
   pipelined round trip or `Promise.all`; the platform's own multi-query calls, such as a grant
   with its checks, become single statements.
3. **Transactions:** `begin` and `commit` are round trips; platform writes that need a transaction
   send it as one statement where Postgres allows, such as one `with ... insert ... returning`.
4. **Rule:** count round trips, not milliseconds; the milliseconds follow.

### 6.3 Faster access checks

1. **Today:** a recursive query walks a point's parents on every check, joining the caller's
   teams, organizations and links.
2. **Ancestor table (proposed):** each point stores its ancestors in a closure table, kept by the
   platform on create, move and remove, so a check is one indexed lookup with no recursion.
   Moving a point rewrites its subtree's rows, a write cost paid once instead of a read cost paid
   on every check.
3. **Per-request memory (proposed):** within one request, `app.access` remembers each point's
   level after the first check and forgets everything when the request changes any grant, link,
   parent or point.
4. **Access in memory (proposed, larger):** a Durable Object per organization, plus one for
   personal points, holds that part of the access graph in memory, answers checks without
   Postgres, and is the only writer of its grants, so it never serves a stale answer. Checks then
   cost the database nothing at all. It runs on the Durable Objects the app already deploys.
5. **Order:** 3 first, then 2; 4 only if the load test shows checks still bind.
6. **Rule:** an access decision is never served stale; speed comes from fewer and cheaper queries
   and from memory that is invalidated by the writer, never from caches that expire.

### 6.4 Session without the database

1. **Today:** the session comes from a signed cookie, refreshed from the database at most every 5
   minutes, yet every lookup runs two queries on `oauth_resource` and `jwks`, tables of the MCP
   sign-in plugins; what triggers them is not pinned down yet.
2. **Proposed:** find the trigger and remove those queries; load the MCP and JWT plugins only when
   MCP is on, and keep what they read, such as signing keys, in Worker memory.
3. **Effect:** a steady-state request costs no query to know who is calling.

### 6.5 Build once, not per request

1. **Static points (proposed):** written by the deploy after migrations, and by `dev` on start;
   requests never write them. Removes 7 queries and the write storm every traffic spike would
   cause as new instances start.
2. **Auth (proposed):** Better Auth's configuration, plugin data and signing keys are built once
   per Worker instance; only the per-request database handle is per request, since a Worker
   cannot share connections between requests.
3. **Everything else:** route tables, compiled schemas and the access query's text are built once
   per instance already or will be.
4. **Startup (proposed):** measure startup time and bundle size, then load rarely used parts, such
   as the MCP SDK, only on the requests that use them.

### 6.6 Postgres efficiency

1. **Indexes:** every lookup the platform makes is by an index; `explain` plans for each platform
   query are kept beside the load test and checked when a query changes.
2. **Statement statistics (proposed):** the load test reads `pg_stat_statements` on its preview
   branch to rank queries by total time, so effort goes where the database actually spends.
3. **Prepared statements:** the platform's fixed queries are prepared once per connection where
   Hyperdrive keeps them, so Postgres plans them once.
4. **Hyperdrive caching stays off:** a cached read could keep a revoked grant working; capacity
   comes from fewer queries, not stale ones.

### 6.7 The app's own queries

1. **Rules the skill teaches:** filter and page in the database, by index; run independent queries
   together; read with access inside the query (6.2); never loop a query per row.
2. **Demo:** follows the rules, so it shows what good looks like.

### 6.8 Fewer requests from the browser

1. **Proposed:** an action redraws only the part it changed; a page that needs several things gets
   them from one endpoint built for it, or in parallel.
2. **Conditional requests (proposed):** reads return an `ETag`, and a repeat read whose data has not
   changed answers `304` with no body; this saves bandwidth, not database work, unless the tag can
   be checked without reading the rows.
3. **Rule:** every request a page makes is multiplied by every visitor.

### 6.9 Static files and server pages

1. **Static files:** served by Cloudflare nearest the visitor without the Worker, free and cached;
   the cheapest request there is.
2. **Server pages:** never cached ([design.md](design.md), section 13, item 14), so they follow
   the same per-request budgets as the API.
3. **Rule:** anything that is the same for everyone is built at build time as a static file.

### 6.10 Live rooms, MCP and background work

1. **Live rooms:** messages flow through the room's Durable Object without the database; a large
   room fans each message out from one object, measured by the load test.
2. **MCP:** each call pays the full request cost, so 6.4 and 6.5 matter most here.
3. **Background work:** email runs after the answer with `waitUntil`; when queues are built
   (`tmp/issues/background-work.md`), work that can wait leaves the request path entirely.

### 6.11 Protecting the hardware

1. **Today:** only sign-in, sign-up and password routes are rate limited.
2. **Proposed:** a per-caller limit on every API route, by user or token, through the rate limiting
   binding the Worker already has, so one caller cannot spend everyone's capacity.

## 7. Cost

On fixed hardware, waste is paid twice: in capacity, and in Workers CPU and Neon compute time,
since Neon bills the time its compute is busy. Every platform query removed is capacity returned
and cost saved on every request.

## 8. Measuring

1. **Server-Timing:** every response on a preview and in local dev lists each database query by
   its verb and tables with its time, connections, the session lookup and the server's total, in
   the browser's network panel under Timing. Prod never sends them.
2. **Budgets in the smoke test (proposed):** `mise run test:preview` fails when a traced request
   goes over its round-trip or server time budget, so a regression blocks a merge like a bug.
3. **Load test (proposed):** a mise task seeds a preview branch with realistic data, drives it on
   the same compute size as prod, and reports the ceiling in 3.3: requests per second within the
   speed targets, round trips per request, Postgres CPU, connections and `pg_stat_statements`.
4. **Prod (proposed):** sampled timings, such as one request in a thousand, sent to the app's logs
   through Workers observability, never to the client.

## 9. Status

Built in PR 19, each measured on its preview before the next:

| # | Change | Section | Built |
| --- | --- | --- | --- |
| 1 | Better Auth built once per Worker instance, reaching each request's connection | 6.4, 6.5 | Yes |
| 2 | No `set-auth-jwt` header, so a session lookup runs no query | 6.4 | Yes |
| 3 | Each point's level asked once per request | 6.3.3 | Yes |
| 4 | Static points and access triggers written at deploy | 6.5.1 | Yes |
| 5 | Worker placed next to the database | 6.1 | Yes |
| 6 | Stored chains (`access_ancestor`) and per-grantee indexes | 6.3.2 | Yes |
| 7 | The rules in a PL/pgSQL function, planned once per connection | 6.6.3 | Yes, in place of prepared statements |
| 8 | API tokens checked in one query, last use written hourly | 6.4 | Yes |
| 9 | Per-caller rate limit, `rateLimit` in `platform.jsonc` | 6.11 | Yes |
| 10 | MCP SDK loaded only on `/mcp` | 6.5.4 | Yes; startup stayed about 110ms, minifying did not help and broke the live client |
| 11 | Demo panel: one query per kind of name, reads together, redraws alone | 6.8.1 | Yes |
| 12 | Server-Timing on previews and `dev`; budgets in the smoke test; `mise run test:perf` | 8 | Yes |
| 13 | Access folded into the app's own query for single reads | 6.2.1 | No: a read is 2 round trips, the check and the row |
| 14 | Conditional requests | 6.8.2 | No |
| 15 | Prod sampling, `pg_stat_statements` in the load test | 8 | No |
| 16 | Access in Durable Objects | 6.3.4 | Not needed: a check is 0.26ms of database time |

## 10. Results

Measured on the PR 18 preview before and the PR 19 preview after, same Neon compute, same region,
`mise run test:perf`:

| Request | Server time before | After | Queries before | After |
| --- | --- | --- | --- | --- |
| Session | 335ms | 0ms | 2 | 0 |
| List my notes | 483ms | 18ms | 3 | 1 |
| Read a note | 811ms | 30ms | 5 | 2 |
| Permissions panel | 1,731ms | 47ms | 11 | 5 |
| Make a link | 956ms | 52ms | 6 | 4 |
| Server page | 427ms | 31ms | 5 | 2 |

1. **Under load:** before, 150 reads at 10 at once ran at 12 a second with 22 failures; after, 6,000
   reads at 300 at once ran at 563 a second with none, and at 150 at once the server's median was
   60ms. Past that, the preview's small Neon compute is the limit: queries queue inside it.
2. **Access at scale (local Postgres):** with 1,000 teams, a 20-deep chain and 10,000 grants on one
   point, a check went from 400ms to 1.4ms; a 50-row page filtered from 100,000 points takes 9ms;
   one check is 0.26ms of database time signed in, 0.035ms signed out.
3. **Costs:** no new services or larger compute. Fewer queries and no planning lower Neon compute
   time per request; placement and the rate limiting binding carry no listed charge. The one added
   cost is storage: `access_ancestor` holds one row per point per level of its chain, so a million
   points three deep is about three million small rows.
4. **Writes that got dearer:** moving a point, or changing whether it inherits, rewrites the chains
   below it: 2.2 seconds above 100,000 points, instant for a handful.
5. **Browser wait:** about 120ms more than the server's time, from the visitor to Cloudflare and on to
   the Worker next to the database; that is distance, not the platform.
6. **Fresh instances:** at low traffic, 30 to 45% of requests land on a Worker instance that just
   started, which costs about 110ms of startup and one query, the MCP sign-in plugin checking its
   `oauth_resource` row; busy apps keep instances warm, so both fade with volume. The smoke test's
   budgets leave that one query out.

## 11. Open decisions

The rule in section 2 and the targets in section 3 are proposed here; items 13 to 15 of section 9
are not built. The [performance decisions page](https://claude.ai/artifact/K11uC7jybNXceuoKYHajYR)
predates this work.
