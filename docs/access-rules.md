# Access Rules

Every case the access system must get right. Each row becomes a test; the design is in
[design.md](design.md), App Code, Access. Every row is decided.

## In short

| Question | Answer |
| --- | --- |
| **What is checked** | A person's level on one item: `read` < `create` < `write` < `delete` < `manage` |
| **Where levels come from** | Owning the item, an organization role, a grant to them, their team or their organization, or a link |
| **Which level counts** | The highest of all of them |
| **What inherits** | A level on an item applies to everything inside it, at any depth, until an item is restricted |
| **Raising and lowering** | A grant raises access on an item; restricting an item is the only way to lower it |
| **What happens otherwise** | No level means no access, shown as 404 |
| **When changes apply** | On the very next request |

## Levels

| # | Situation | Expected |
| --- | --- | --- |
| L1 | Asked for `read`, has `read` | Allowed |
| L2 | Asked for `write`, has `read` | Refused |
| L3 | Asked for `read`, has `manage` | Allowed: each level includes those below |
| L4 | Has no level at all | Refused, as 404 |
| L5 | Unknown level name asked for | Error in the app's code, never allowed |

## Ownership and organizations

| # | Situation | Expected |
| --- | --- | --- |
| O1 | User owns an item, placed directly under them | `manage` |
| O2 | Item placed under an organization; user is `member` | `read` |
| O3 | Same; user is `admin` | `delete` |
| O4 | Same; user is `owner` | `manage` |
| O5 | User is not in the organization | Refused |
| O6 | Member removed from the organization | Refused on the next request |
| O7 | Member's role changed from `admin` to `member` | `read` from the next request |
| O8 | Item placed under one organization; user is owner of a different one | Refused |
| O9 | User owns item personally, then leaves an organization they were in | Still `manage` on their own item |

## Grants

| # | Situation | Expected |
| --- | --- | --- |
| G1 | Item shared with the user at `write` | `write` |
| G2 | Shared with a team at `write`; user is in the team | `write` |
| G3 | Same; user removed from the team | Refused on the next request |
| G4 | Shared with an organization at `read`; user is a member | `read`, even if their role would give less on other items |
| G5 | Shared with an email; nobody has that address yet | Nobody gets access |
| G6 | Same; someone signs up with that address but has not confirmed it | Refused |
| G7 | Same; they confirm the address | The grant becomes theirs: allowed |
| G8 | Grant revoked | Refused on the next request |
| G9 | Shared at `read`, then shared again at `write` | One grant, at `write` |
| G10 | The person who shared loses their own access | Grants they gave stay |
| G11 | Someone with `write` tries to share | Refused: sharing needs `manage` |
| G12 | Someone with `manage` shares at `manage` | Allowed |
| G13 | Someone with `manage` from a grant revokes the owner's or an organization role's access | Refused: grants never remove ownership or roles |
| G14 | Grant at `manage` | Allowed: grants carry any level up to `manage` |

## Links

| # | Situation | Expected |
| --- | --- | --- |
| K1 | Request carries a valid link token for the item at `read` | `read`, signed in or not |
| K2 | Token for a different item | Refused |
| K3 | Token expired | Refused |
| K4 | Token revoked | Refused on the next request |
| K5 | Token for a folder; request for a page inside it | Allowed: links inherit like everything else |
| K6 | Signed-in user with `read` from a grant also carries a `write` link | `write`: highest wins |
| K7 | Token guessed or altered | Refused; tokens are long random secrets, compared in constant time |
| K8 | Link made at `write` | Allowed: links carry `read`, `create` or `write` |
| K9 | Link made at `delete` or `manage` | Refused |

## Inheritance

| # | Situation | Expected |
| --- | --- | --- |
| I1 | `write` on a folder; request for a page in it | `write` |
| I2 | `write` on a folder; request for a page three folders down | `write` |
| I3 | `write` on a page; request for its folder | Refused: levels flow down, never up |
| I4 | `read` on a folder, `write` on a page inside it | `write` on that page, `read` on its siblings |
| I5 | Page moved out of a shared folder | The folder's grants stop applying on the next request |
| I6 | Page moved into a shared folder | The folder's grants apply on the next request |
| I7 | Item never placed | Nobody has access, not even its creator: fail closed |
| I8 | Chain deeper than the depth limit | Refused, and logged as a bug |

## Restricted items

| # | Situation | Expected |
| --- | --- | --- |
| R1 | Folder restricted; user has `read` from the organization | Refused on the folder and everything inside it |
| R2 | Same; folder shared with the user at `read` | `read` |
| R3 | Read-only folder: restricted, shared with the organization at `read`; member asks for `create` | Refused |
| R4 | Page restricted inside a folder the user can `write` | Refused on that page, `write` on its siblings |
| R5 | Restricted folder; organization `admin` | `delete`: admins always reach restricted items |
| R6 | Restricted folder; organization `owner` | `manage` |
| R7 | Restricted folder; later a grant on its parent | The grant does not reach the folder |
| R8 | Grant on a page inside a restricted folder | That grant counts on the page |
| R9 | Restriction removed | Inheritance from above applies again on the next request |
| R10 | Restricted item owned by a user, not an organization | Only its own grants and its owner's `manage` count |
| R11 | Link token for the folder above a restricted page | Refused on the page: links stop at restrictions too |

## Placing

| # | Situation | Expected |
| --- | --- | --- |
| P1 | Place a page under a folder | Recorded |
| P2 | Place a folder under itself | Refused |
| P3 | Place a folder under its own child or grandchild | Refused |
| P4 | Two moves at the same moment that together would make a loop | One succeeds, the other is refused |
| P5 | App's own update fails after `place` in the same transaction | Neither is saved |
| P6 | Place an item at the top, under a user or an organization | Recorded |
| P7 | Mover has `write` on the item and `create` on the new parent | Recorded |
| P8 | Mover lacks `write` on the item, or `create` on the new parent | Refused, as 404 |

## Highest wins

| # | Situation | Expected |
| --- | --- | --- |
| H1 | `read` from the organization, `write` from a team grant | `write` |
| H2 | `delete` from ownership, `read` from a grant | `delete` |
| H3 | `read` on a folder from one team, `write` on the page from another | `write` |
| H4 | Same level from several places, one revoked | Unchanged: the others still apply |

## Endpoints and lists

| # | Situation | Expected |
| --- | --- | --- |
| E1 | Endpoint declares `access: { kind: "page", id: "id", level: "write" }`; caller has `write` | The function runs |
| E2 | Same; caller has `read` | 404, the function never runs |
| E3 | Same; the id names no item | 404, the same answer as no access |
| E4 | MCP call to the same endpoint | Same checks, as the token's user; refusal is a tool error saying not found |
| E5 | List of pages filtered by `accessible("page", "read")` | Exactly the pages a single check would allow, no more, no fewer |
| E6 | Hand-written route calls `app.access.can` | Same answers as an endpoint |

## Deleting

| # | Situation | Expected |
| --- | --- | --- |
| D1 | App deletes an item | Its grants, links and place go with it, in the same transaction |
| D2 | App deletes a folder that still has children | Refused: the app deletes or moves what is inside first |
| D3 | User account deleted | Their grants and pending email grants go; what they own goes with Better Auth's own deletion rules |
| D4 | Organization deleted | Its grants go; the items placed under it lose all access until the app deletes them |

## How the tests prove it

1. **Each row:** one test against a real Postgres 18 database.
2. **Against a reference:** a short, slow, obviously correct version of the rules in plain TypeScript; randomized tests build thousands of trees, members, grants and links and require the SQL to answer the same.
3. **Races:** many concurrent moves, checking no loop is ever stored.
4. **End to end:** E rows through real HTTP requests and MCP calls on a preview.
