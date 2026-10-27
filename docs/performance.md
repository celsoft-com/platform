# Performance

How the platform stays fast as an app grows from one user to high volume: where a request's time
and load go, the limits that bind first, and the design rules that keep both in check. It covers
every part of a request, from the visitor's browser to Postgres and back. Each section says what
is true **today** and what is **proposed**; nothing proposed is decided until it moves into
[design.md](design.md). The open decisions are on the
[performance decisions page](https://claude.ai/artifact/K11uC7jybNXceuoKYHajYR).

## 1. Problem

The platform must serve apps at high volume, and today it is slow at one user. With one user,
simple requests take 0.3 to 1.3 seconds: reading one note took over 400ms on the server, the
permissions panel 460ms, and one Make a link click about 3 seconds in the browser. The causes are
the platform's own work, not the app's: in the 12 queries that read a note, one is the note.

At one user that work costs time. At high volume the same work costs database load: every query
the platform adds to a request is multiplied by every request, and Postgres is the one part of
the stack that does not scale out on its own. So the design target is the database's work per
request, with latency following from it.

## 2. Targets (proposed)

### 2.1 Scale

The volume one app on the platform must handle without changes to its code. The numbers are
proposals to set, not measurements.

1. **Traffic:** a sustained 1,000 API requests per second, with bursts of 5,000.
2. **People:** 1,000,000 accounts, 50,000 signed in at once.
3. **Data:** 100,000,000 rows in an app's largest table, and 10,000,000 control points.
4. **Sharing:** a point with 10,000 grants, a person in 1,000 teams, a chain of points 20 deep.
5. **Live:** 10,000 open live connections, 1,000 in one room.

### 2.2 Speed

1. **Read:** a signed-in API read, such as reading one note, answers in under 50ms on the server
   at the median and under 150ms at the 99th percentile, at the scale above.
2. **Write:** a write such as making a link answers in under 100ms at the median.
3. **Browser:** a click in the demo shows its result in under 300ms for a visitor near the app's
   region.

### 2.3 Work per request

1. **Session:** no query while the session cookie is fresh.
2. **Access:** at most one access query per point a request touches; a list is one query
   whatever its length.
3. **No writes on reads:** a request that changes nothing writes nothing.
4. **App:** the app's own queries, run together where they are independent.
5. **Budget:** a read costs at most the app's queries plus one; a write at most the app's queries
   plus two, `begin` and `commit` included.

## 3. Anatomy of a request

Every API request passes through these steps, in order. The database steps repeat per query, and
each query is both time for the caller and work for Postgres.

| # | Step | Today | Cost seen | At volume |
| --- | --- | --- | --- | --- |
| 1 | Browser to Cloudflare | TLS to the nearest Cloudflare location | 25 to 120ms | Unchanged |
| 2 | Worker instance start | Only when a new instance is needed | 0.4 to 0.6s, inferred | Rarer: busy apps keep instances warm |
| 3 | Database connection | A `pg` pool per request, through Hyperdrive | 0 to 44ms | Bounded by Hyperdrive's and Neon's connection limits |
| 4 | Session | Better Auth, built per request | 60 to 170ms, 2 queries | 2 queries times every request |
| 5 | Static control points | Written per Worker instance | 7 queries, about 250ms, when it happens | A write storm whenever instances start |
| 6 | Access check | One recursive query, often repeated | 15 to 50ms each | Grows with chain depth and grant counts |
| 7 | The app's queries | As the handler runs them | 15 to 50ms each | The app's own scaling |
| 8 | Response | Output checked against its schema | Negligible | CPU only |

## 4. Measured baseline

From the `Server-Timing` trace on the PR 18 preview, one user, two Make a link clicks:

| Request | Browser time | Server total | Queries |
| --- | --- | --- | --- |
| Make the link | 0.3 to 1.1s | 109 to 613ms | 6 to 13 |
| Read the note | 1.0 to 1.3s | 261 to 451ms | 12 |
| Permissions panel | 1.0 to 1.2s | 636 to 740ms | 18 |
| List my organizations | 0.3 to 0.4s | 101 to 149ms | 3 |

1. **Server share:** the server's total is half or less of the browser's wait; the rest is
   reaching Cloudflare and, more often than not, starting a Worker instance.
2. **Query cost:** 15 to 50ms each, mostly distance (5.1).
3. **Not measured yet:** anything above one user; see section 7.

## 5. Causes and design, layer by layer

### 5.1 Distance to the database

1. **Today:** a Worker runs in the Cloudflare location nearest the visitor; Neon runs in one AWS
   region. Every query crosses that distance, even `begin` and `commit`, and queries in a request
   run one after another, so the distance is paid once per query: 15 to 50ms each.
2. **Proposed:** the deploy sets Cloudflare's placement hint to the Neon project's region, read
   from Neon, so the Worker runs in the Cloudflare location closest to the database
   ([placement](https://developers.cloudflare.com/workers/configuration/placement/)). A far
   visitor makes one long trip to the Worker instead of the Worker making many.
3. **At volume:** shorter queries also hold connections for less time, so the same connection
   limit serves more requests.
4. **Global users:** one database region means visitors far from it always pay one long trip;
   serving them faster needs data near them, a later design (section 8).
5. **Rule:** round trips per request are the main cost; fewer, larger queries beat many small ones.

### 5.2 Database capacity

1. **Today:** one Neon compute serves an app's prod branch, autoscaling between the sizes its
   project allows; previews get their own branches.
2. **Binding limit:** at volume, Postgres CPU and connections bind first; every platform query
   removed per request is capacity returned to the app.
3. **Proposed:** the platform documents the Neon compute range an app needs for the scale in 2.1,
   measured by the load test in section 7, and the deploy warns when the project allows less.
4. **Read replicas (later):** Neon read replicas could take reads such as access checks and lists;
   they lag the primary, so access checks would see grants late; not proposed now.
5. **Rule:** the database does work only the database can do; anything that can be answered
   without it, such as who the caller is, is.

### 5.3 Connections

1. **Today:** each request opens its own `pg` pool through Hyperdrive, lazily, at most 5
   connections, and closes it after the answer. Hyperdrive keeps the real connections to Neon
   warm, so opening one is a round trip to Hyperdrive, not a new Postgres connection.
2. **Limits:** Hyperdrive and Neon each cap concurrent connections; at 1,000 requests per second a
   request holding a connection for 100ms keeps about 100 busy, 25ms about 25.
3. **Rule:** connection time per request is query count times query time; both sections 5.1 and
   5.5 to 5.7 shrink it. A Worker cannot share a connection between requests, so per-request
   pools stay.
4. **Proposed:** the load test (section 7) records peak connections, and the platform documents
   the Hyperdrive and Neon limits an app at 2.1 needs.

### 5.4 Hyperdrive caching

1. **Today:** turned off on every config the platform makes, so no read returns stale rows.
2. **Why it stays off:** access checks and sessions read through it; a cached check would keep a
   revoked grant working for as long as the cache lasted.
3. **Rule:** speed comes from fewer queries, never from serving access decisions stale.

### 5.5 Session

1. **Today:** Better Auth is built on every request with every plugin the platform uses: admin,
   API keys, JWT and MCP. The session comes from a signed cookie, refreshed from the database at
   most every 5 minutes, yet every lookup runs two queries on `oauth_resource` and `jwks`, tables
   of the MCP sign-in plugins. What triggers them is not pinned down yet.
2. **Effect:** 60 to 170ms and 2 queries on every signed-in request; at 1,000 requests per second,
   2,000 queries per second that answer nothing new.
3. **Proposed:** find the trigger and remove those queries: load the MCP and JWT plugins only when
   MCP is on, and keep what they read, such as signing keys, per Worker instance.
4. **Revocation:** a signed-out or banned session keeps working until its cookie copy expires, up
   to 5 minutes; that trade stays, since it is what lets a session cost no query.
5. **Rule:** a fresh session cookie answers who is calling without a query.

### 5.6 Access checks

1. **Today:** one recursive query answers a level on one point, walking up its parents, joining
   the caller's teams, organizations and links; list filters put the same logic into the app's
   own query, so a list is one query, not one per row. Indexes cover a point's parent and every
   grantee column.
2. **Repeats:** an endpoint's declared check runs, then the handler often asks again, through
   `check`, `level`, `require`, or the platform's own calls such as `link` and `grant`. Reading a
   note checks twice; the permissions panel checks six times.
3. **Proposed:** within one request, `app.access` remembers each point's level after the first
   check and forgets everything when the request changes any grant, link, parent or point.
4. **At volume:** the check's cost grows with chain depth, the caller's team count and a point's
   grant count; the load test (section 7) measures it at the sizes in 2.1, with `explain` plans
   kept beside the test.
5. **Lists at volume:** a filtered list over 100,000,000 rows must use an index on the app's
   column; the shipped skill tells apps to filter and page in the database, never in the Worker.
6. **Rule:** a request asks the database about one point's level once.

### 5.7 Static control points

1. **Today:** `defineApp({ access: { points } })` is written before the first check of each Worker
   instance, in one transaction of about 7 queries.
2. **Effect:** 3 of 8 traced requests paid about 250ms for it. At volume, every new instance
   rewrites the same rows: when traffic spikes and Cloudflare starts many instances at once, they
   all write at once, a write storm on rows every check reads.
3. **Proposed:** the deploy writes them after migrations, and `dev` on start; requests never do.
4. **Rule:** anything that changes only with code is applied at deploy, never during requests.

### 5.8 Worker startup and CPU

1. **Today:** a new Worker instance loads the whole bundle: Better Auth and its plugins, Drizzle,
   `pg`, oRPC, Zod and the MCP SDK, whether the request needs them or not.
2. **Effect:** inferred 0.4 to 0.6s on most requests at one user; at volume instances stay warm,
   so startup hits fewer requests but every spike and every deploy.
3. **CPU:** Workers bill CPU time; building Better Auth per request and checking every output
   against its schema cost CPU on every request, unmeasured today.
4. **Proposed:** measure startup, bundle size and CPU per request on a preview first; then load
   rarely used parts, starting with the MCP SDK, only on the requests that use them, and build
   whatever can be built once per instance once.
5. **Rule:** a dependency in the Worker's import graph costs every cold request; heavy ones load on
   demand.

### 5.9 The app's own queries

1. **Today:** handlers run their queries one after another, as written.
2. **Rules:** independent queries run together with `Promise.all`; lists filter and page in the
   database with `app.access.readable`, by index, never row by row; every table an app queries by
   a column at volume has an index on it.
3. **Skill:** the shipped skill teaches these, so apps built on the platform start right.

### 5.10 Static files and server pages

1. **Static files:** served by Cloudflare nearest the visitor without running the Worker, free and
   cached; at volume they cost nothing more. Workers Cache stays off, since it would bill every
   static file request ([design.md](design.md), section 13, item 14).
2. **Server pages:** never cached, so every visit costs a Worker request and its queries; at volume
   they follow the same budgets as the API.
3. **Rule:** a page that is the same for everyone and must be fast for everyone is rendered at
   build time as a static file.

### 5.11 The browser

1. **Today:** the demo redraws a whole page after any change, re-running every request the page
   made, one after another; one Make a link click made four requests.
2. **At volume:** every extra request a page makes is multiplied by every visitor; the browser's
   habits are server load.
3. **Proposed:** an action redraws only the part it changed, and a page fetches independent data
   in parallel.
4. **Rule:** the demo shows how apps should use the platform, so it follows the same budgets.

### 5.12 Live rooms

1. **Today:** a join checks the app's `canJoin` once; messages then flow through the room's Durable
   Object without the database unless the app's `onMessage` queries.
2. **At volume:** one Durable Object runs one room on one thread; a room of 1,000 people
   broadcasting fans every message out 1,000 times from that one object.
3. **Proposed:** the load test measures a room at the size in 2.1; rooms beyond it are a later
   design, such as splitting a room across objects.
4. **Known gap:** access is checked only on joining (tracked in `tmp/issues/live-room-access.md`).

### 5.13 MCP

1. **Today:** every call is one stateless request whose OAuth token the MCP sign-in plugin
   verifies, with the same plugins built per request as in 5.5.
2. **At volume:** AI clients call in bursts; each call pays the full request cost, so 5.5 and 5.8
   matter most here.

### 5.14 Email, files and background work

1. **Email:** sent after the answer with `waitUntil`, so it never slows the response; at volume,
   Resend's rate limits bind, and a burst of sharing could exceed them.
2. **Files:** served from R2 by the Worker after an access check; large files stream.
3. **Background work:** not built yet (`tmp/issues/background-work.md`); at volume, email and
   cleanup belong on a queue with retries, not in `waitUntil`, which drops work on failure.

### 5.15 Rate limits and abuse

1. **Today:** only sign-in, sign-up and password routes are rate limited.
2. **At volume:** one caller can spend the app's database capacity; API tokens make scripted load
   easy.
3. **Proposed:** a per-caller limit on all API routes, by user or token, through Cloudflare's rate
   limiting binding, with the limit set in `platform.jsonc`.

## 6. Cost

1. **Workers:** billed per request and per CPU millisecond; static files are free.
2. **Neon:** billed by compute time and size; every platform query per request is paid for at
   volume, and an idle app scales to zero.
3. **Rule:** the work budgets in 2.3 are also the cost budgets; a query the platform removes is
   money saved on every request.
4. **Proposed:** the load test reports cost per million requests alongside its timings.

## 7. Measuring

1. **Server-Timing:** every response on a preview and in local dev lists each database query by
   its verb and tables with its time, connections, the session lookup and the server's total; the
   browser's network panel shows them under Timing. Prod never sends them.
2. **Budgets in the smoke test (proposed):** `mise run test:preview` fails when a traced request
   goes over its query count or server time budget, so a slowdown blocks a merge like a bug.
3. **Load test (proposed):** a mise task seeds a preview to the sizes in 2.1 and drives it at the
   traffic in 2.1, recording latency percentiles, queries per request, Postgres CPU, peak
   connections, errors and cost; it runs before each release that touches the request path.
4. **Prod (proposed):** sampled timings, such as one request in a thousand, sent to the app's logs
   through Workers observability, never to the client.
5. **Not covered yet:** startup time, which needs its own measurement.

## 8. Later

1. **Data near users:** read replicas or regional data for visitors far from the database.
2. **Large rooms:** splitting a live room across Durable Objects.
3. **Access at scale:** a Durable Object store for grants, if checks ever need to be faster than a
   Postgres query (already noted in design.md section 13, item 8.26).

## 9. Open decisions

Each proposal in sections 5.1, 5.5 to 5.8 and 5.11, and the trace in 7.1, is an item on the
[performance decisions page](https://claude.ai/artifact/K11uC7jybNXceuoKYHajYR). The targets in
section 2, the capacity work in 5.2 and 5.3, rate limits in 5.15, cost reporting, the smoke test
budgets, the load test and prod sampling are proposed here for the first time.
