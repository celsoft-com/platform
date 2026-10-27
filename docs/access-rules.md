# Access Rules

Every case the access system must get right. Each row is a test named by its row; the design is in
[design.md](design.md), App Code, Access, and Auth behavior, Organizations. Random worlds are also
checked against a plain reference version of these rules, in `access.model.test.ts`.

## In short

| Question | Answer |
| --- | --- |
| **What is checked** | A person's level on one control point: `read` < `create` < `write` < `delete` < `manage` |
| **Where levels come from** | Grants to the person, their email, their teams, their organizations and Everyone; a link; the organization's Admins team |
| **What inherits** | A point set to inherit also uses its parents' grants, up to the first point that does not inherit |
| **Which grant counts** | Each principal counts its nearest grant up the chain, and the highest across principals wins |
| **What happens otherwise** | No level means no access, shown as 404, the same as a point that does not exist |
| **When changes apply** | On the very next check |

## Levels

| # | Situation | Expected |
| --- | --- | --- |
| L1 | Asked for `read`, has `read` | Allowed; `check` returns `read` |
| L2 | Asked for `write`, has `read` | Refused, as 404 |
| L3 | Has `manage` | Every level allowed |
| L4 | Has no level at all | `level` is null; `check` is a 404 |
| L5 | Unknown level name | Error in the app's code, never allowed |
| L6 | Point does not exist | Exactly the same answer as one the caller cannot see |

## Points

| # | Situation | Expected |
| --- | --- | --- |
| P1 | Someone creates a point | They get `manage` on it |
| P2 | Signed out, or a caller id that is not a user | Refused, as 401 |
| P3 | Parent named, creator has less than `create` on it | 404, nothing made |
| P4 | Parent does not exist | 404 |
| P5 | Id already in use | 409; the existing point and its grants untouched |
| P6 | Id starts `organization:` or `team:` | Error in the app's code; those are the platform's |
| P7 | Id empty, over 200 characters, or not a string | Error in the app's code |
| P8 | Initial grants given | Applied with the creator's `manage`; a bad one creates nothing |
| P9 | Point under an organization's point | Takes that organization; a personal point has none |
| P10 | Chain would be deeper than 64 | 409 |
| P11 | The app acting as itself creates | No creator grant; the app passes every check |
| P12 | Ids with quotes, `%`, `_`, other scripts | Taken literally; never match another point |
| P13 | Reading a point's own settings | Parent, inheritance, static and organization, for those with `read`; 404 otherwise |

## Static points

| # | Situation | Expected |
| --- | --- | --- |
| S1 | Points declared in `defineApp` | Exist with their grants before the first check |
| S2 | Declared grants change | Each start replaces them |
| S3 | Runtime grant, revoke, inherit, link, move or remove | 409; they change only in code |
| S4 | Parent not static, a loop, or a platform prefix | The start fails, nothing written |
| S5 | Id already used by a runtime point | The start fails; the runtime point keeps its grants |
| S6 | Runtime point under a static one | Allowed with `create` on it |
| S7 | Everyone granted more than `read` | The start fails |
| S8 | Several Workers start at once | One set of grants |
| S9 | Applying fails | The check fails; the next one tries again |

## Grants

| # | Situation | Expected |
| --- | --- | --- |
| G1 | Granted to a person | That level |
| G2 | Granted to a team | Its members only |
| G3 | Granted to an organization | Every member |
| G4 | Granted to an email | The person whose confirmed address it is, in any case; unconfirmed gets nothing |
| G5 | Address confirmed, or the person signs up, after the grant | Applies on the next check |
| G6 | Granted to Everyone | Signed-out visitors and every person |
| G7 | Everyone granted more than `read` | Error in the app's code |
| G8 | Granting, revoking or listing with less than `manage` | 404, nothing changes |
| G9 | Someone with `manage` grants `manage` | Allowed; that person can grant too |
| G10 | Granted again | The level changes; never a second grant |
| G11 | Revoked | Gone on the next check; revoking nothing is fine |
| G12 | Listing grants | Every grant, for those with `manage` |
| G13 | Grantee does not exist, or is not a UUID | 404 |
| G14 | Point under an organization granted to another organization or its teams | 409; such a grant written anyway is ignored |
| G15 | Personal point granted to any organization or team | Allowed |
| G16 | Team row left behind by someone who left the organization | Gives nothing |
| G17 | Someone removed from a team or organization | Loses that access on the next check |
| G18 | Grantee names no principal, two, or an empty one | Error in the app's code |

## Sharing email

| # | Situation | Expected |
| --- | --- | --- |
| E1 | New grant to a person | Emailed, naming who shared and the level, linking to the app's path |
| E2 | New grant to an email address | That address is emailed |
| E3 | A grant's level changes | No email |
| E4 | Teams, organizations, Everyone | No email |
| E5 | `email: false`, or the grant is refused | No email |
| E6 | App's own subject and text | Used, with the link after the text |
| E7 | Path not starting with one `/` | Error in the app's code; a link never leaves the app |

## Links

| # | Situation | Expected |
| --- | --- | --- |
| K1 | Anyone holding a link, signed in or not | The link's level on its point |
| K2 | Points under or above the link's point | Nothing from the link |
| K3 | Link at `delete` or `manage` | Error in the app's code |
| K4 | Expired or revoked link | Nothing |
| K5 | Wrong token, or one for another point | Nothing |
| K6 | What is stored | Only a hash of the token |
| K7 | Making, listing, revoking links | Need `manage` |
| K8 | Revoking with another point's link id | Revokes nothing |
| K9 | Link and grant together | The higher wins |

## Inheritance

| # | Situation | Expected |
| --- | --- | --- |
| I1 | Point does not inherit | Its parent's grants do not count |
| I2 | Point inherits | Its parent's grants count |
| I3 | Chain of inheriting points | Walk stops after the first that does not inherit |
| I4 | Changing inheritance | Needs `manage`; applies on the next check |
| I5 | Narrower grant to the same principal | Lowers that principal on that point |
| I6 | Grant to a whole organization on one point | Never lowers its teams |
| I7 | Several principals | The highest wins |
| I8 | User grant and email grant to the same person | One principal; the nearer counts |
| I9 | Two teams with grants at different depths | Each stops at its own nearest |
| I10 | Everyone on a child, `manage` on the parent | `manage` |
| I11 | Team point stops inheriting | The organization's grants stop at it |

## Admins

| # | Situation | Expected |
| --- | --- | --- |
| A1 | Organization created | Its creator is in its Admins team, with `manage` on its point |
| A2 | Admin on any point under the organization | `manage`, even one with no grants that stands alone |
| A3 | Admin of one organization in another | Nothing |
| A4 | Admin left the organization, team row left behind | Nothing |
| A5 | Members' personal points | Admins have no reach |
| A6 | Last admin leaves, is removed, or leaves Admins | 409; allowed once there is another |
| A7 | Deleting the Admins team | 409 |
| A8 | Two admins removing each other at once | One admin left |

## Moving

| # | Situation | Expected |
| --- | --- | --- |
| M1 | Move | Needs `manage` on the point and `create` on the new parent; 404 otherwise |
| M2 | Under itself or anything under it | 409 |
| M3 | Chain would be deeper than 64 | 409 |
| M4 | Organization or team points | 409; they move and go only with their organization |
| M5 | Into an organization and out again | The whole subtree takes the organization, with its admins, and gives it up |
| M6 | Subtree granted to another organization's team, moved into an organization | 409 until revoked |
| M7 | To the top | Allowed |
| M8 | Two moves at once | Never a loop |

## Deleting

| # | Situation | Expected |
| --- | --- | --- |
| D1 | Remove | Needs `delete`; returns the point and everything under it, its own id first; grants and links go |
| D2 | Inside a rolled-back transaction | Everything kept |
| D3 | Person deleted | Their grants go; grants they gave stay |
| D4 | Team deleted | Its grants go, and its point with everything under it |
| D5 | Organization deleted | Every point under it and every grant to it |
| D6 | Removed in the app's transaction | The app deletes its rows in the same commit |

## Organizations

| # | Situation | Expected |
| --- | --- | --- |
| O1 | Created | Organization, member, Admins team, and its point granting the organization `read` and the creator `manage`; needs a signed-in user |
| O2 | Listing | Only the caller's organizations |
| O3 | Outsider asks for one, its members or teams | 404, the same as one that does not exist |
| O4 | Rename and delete | Need `write` and `delete` on its point; names are 1 to 100 characters |
| O5 | Inviting | Needs `manage`; sends an email; one invitation per address; a real address only |
| O6 | Accepting | Only with the signed-in person's confirmed matching email; once; not expired or revoked |
| O7 | Invitation naming a team | Adds the person to that team |
| O8 | Invitation naming another organization's team | 404; revoking through another organization does nothing |
| O9 | Removing someone else | Needs `manage`; anyone may leave |
| O10 | Leaving an organization | Leaves its teams |
| O11 | Creating a team | Needs `create`; the team gets `write` on its point, the creator `manage` |
| O12 | A team's members, name and deletion | `manage`, `write` and `delete` on its point; anyone may leave a team |
| O13 | Adding someone who is not a member to a team | 404 |
| O14 | Slugs | Unique, lowercase letters, digits and dashes |
| O15 | Ids that are not UUIDs | 404, never a server error |
| O16 | Organization deleted | Its teams, members, invitations and points go |
| O17 | Routes under `/api/platform/` | Same rules; 401 signed out; bad JSON 400; unknown paths and bad encodings 404 |
| O18 | A person's own invitations | Those sent to their confirmed address, unexpired; they may decline them; others' are 404 |
| O19 | One team | For those who can read its point; 404 otherwise |

## Endpoints, lists and wiring

| # | Situation | Expected |
| --- | --- | --- |
| N1 | Caller has the declared level | The function runs |
| N2 | Caller has less | 404; the function never runs |
| N3 | Point does not exist | The same 404 |
| N4 | MCP call | The same checks; a refusal is a tool error saying not found |
| N5 | `readable` and `allows` | List exactly what single checks allow |
| N6 | Point worked out from the input | Checked like a field |
| N7 | `access: "none"` | Runs with no check |
| N8 | Access on, an endpoint declares nothing | Every request answers 500, naming it in the logs |
| N9 | Declared field missing, unknown level, bad shape | Error when the endpoint is defined |
| N10 | Input gives no usable point id | 404, never a server error |
| N11 | Link token | Read from the `x-access-link` header, never the query |
| N12 | `app.access` with access off | Error |

## Attacks

| # | Situation | Expected |
| --- | --- | --- |
| X1 | SQL in an email grant | Just an address |
| X2 | Caller id that is not a UUID | Nobody |
| X3 | Member adds points under the organization's or a team's point | 404 |
| X4 | Creating a point with an existing id | 409; nothing taken over |
| X5 | Two people create the same id at once | One wins; the other gets nothing |
| X6 | Everyone above `read`, even straight into the table | Refused by the database |
| X7 | `manage` on a child | Nothing on its parent |
| X8 | Moving someone else's point under one's own | 404 |
| X9 | Moving one's own point under someone else's | 404 |
| X10 | Member joins Admins or a team, creates teams, or invites | 404 |
| X11 | Team member with `write` changes the team's grants or place | 404 |
| X12 | Platform ids, in the app or straight into the table | Refused |
| X13 | Accepting someone else's invitation by its id | 404 |
| X14 | One organization's admin acting on another's | 404 |
| X15 | Link to a point removed and recreated with the same id | Nothing |
| X16 | Link holder changes grants, makes links, removes | 404 |
| X17 | Signed-out link holder with `create` | 401 |
| X18 | App's table alias matches a name inside the access query | The filter still means the app's rows |
| X19 | Lowering a whole organization on one point | Its teams keep their level |
| X20 | Unconfirmed account with a granted email address | Nothing |
| X21 | Every refusal | Looks the same whether the point exists or not |
| X22 | Granting another organization's teams on one's own point | 409 |
