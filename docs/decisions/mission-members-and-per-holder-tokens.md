---
title: Mission members and per-holder mission tokens — every call names who made it
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
  - api-key-format-vbn-live-argon2id
  - operator-deactivates-a-user
  - orphaned-missions-and-ownerless-connections
---

# Mission members and per-holder mission tokens — every call names who made it

> Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0 "Mission member",
> "Mission token"; §3.2; §7.9 bis; §8; §11.2 "Members and authority", "What a
> member sees". Handbooks: [missions](../handbook/missions.md) ("Members and
> tokens"), [execution-door](../handbook/execution-door.md) ("Token holders"),
> [audit](../handbook/audit.md), [store](../handbook/store.md) (migration 0010),
> [threat-model](../handbook/threat-model.md).

## Context

A mission had one token. The pivot ADR made that a rule — "one token per
mission, shared by all its agents, one budget" — so that multiplying agents
could never multiply a budget. It also meant that the gateway knew _which
mission_ a call belonged to and nothing about _who_ was behind it: several
people working on one mission passed the same Bearer around, and the only
attribution was the agent label, which the caller declares about itself.

The product owner's request, on 2026-10-13:

> When I use a mission token through MCP I want the MCP user to be
> identified, to know who uses the session.

Three things had to stay true while answering it:

- **one budget per mission** (spec §3.2): whatever identifies callers must not
  become a way to get more quota;
- **requests go to the creator, who alone answers** (spec §3.4, §3.5);
- **the execution door takes a mission token and nothing else** (spec §6): no
  browser, no OAuth flow, no session on that door.

## Decision

### D1 — A mission has one or more tokens, each with exactly one holder

Two kinds, a closed set (`MISSION_TOKEN_KINDS`, `@vaubaan/shared`):

| Kind     | Who holds it                                                                    | Who generates it       | Who sees the secret, once |
| -------- | ------------------------------------------------------------------------------- | ---------------------- | ------------------------- |
| `member` | a **member** of the mission (the creator, or a user the creator added)          | that member, signed in | that member only          |
| `named`  | something with no account (a CI runner, a shared machine), identified by a name | the creator            | the creator               |

At most one active member token per (mission, member) and one active named
token per (mission, name) — two partial unique indexes. A holder rotating
retires **their** token; nothing touches another holder's.

Every token of a mission shares its resources, its policy and its **one**
budget. A token is an identity, not an allowance: the counters stay keyed by
`(session, risk, period)` and nothing in the budget reads the holder.

### D2 — Members: added by the creator, read and use only

`mission_members(mission_id, user_id, added_by, added_at, removed_at)`. The
creator adds an **active user of the instance**, named by email, and removes
them. The creator is a member **by construction** and has no row
(`missions.creator_user_id` says it): there is nothing to keep in sync and no
way to "remove the creator".

A member may read the mission, its session and its team, and generate, rotate
and revoke **their own** token. Nothing else: not the mission, its gates, its
members, its named tokens, nor its requests. The rule is enforced where it
already was — every mutation of `MissionService` and every read or decision of
`RequestService` knows the creator only — and the new `MissionTeamService`
answers `not-found` to a member for the creator's acts. Reading goes through
one new function, `MissionService.access`, which is the only place that knows
members.

### D3 — A member works under the creator's authority

A member needs no share of the mission's connections (spec §11.2 assumption).
Adding a member checks no authority, and the derived `orphaned` rule keeps
looking at the **creator** alone: if the creator loses the authority, the
mission is orphaned for every holder; if a member has none, nothing changes.
The creator answers for the mission exactly as when they handed a token to a
colleague — which is what members replace.

### D4 — The creator never holds a member's secret

A member token is minted in the request of the member who asked
(`POST /api/missions/:id/tokens/mine`), returned in that response alone, and
stored as an argon2id hash (unchanged format, ADR
api-key-format-vbn-live-argon2id). No service method, no API answer, no audit
entry and no row can give it back. The creator can do one thing to it: revoke
it.

### D5 — What a token is worth is judged at every call, from the store

`MissionService.standingOf` is the one judgement, reached by both the hash
path (`verifyToken`) and the cached-proof path (`provenToken`) of the
execution door:

1. a member token whose holder is not, right now, an **active user** →
   `holder-deactivated`; not a **current member** → `holder-removed`;
2. a token row that is not `active` → `rotated` or `revoked`.

Nothing has to have been written for 1: a member removed, or a user
deactivated, a millisecond ago is refused. The writes exist too — removing a
member revokes their token in the same store transaction, and deactivating a
user revokes the tokens they hold on missions they did not create — so that
the end is durable: a member added again, or a user reactivated, generates a
new token instead of finding an old Bearer working again.

A creator's own token is not judged on the creator's status here: a
deactivated creator orphans the mission (`mission-inactive` for every holder),
and that is reversible with the same tokens, as before.

### D6 — A stopped token is an authentication failure with a reason, not a ninth refusal code

The door answers **401** (`-32001`) with `error.data.reason`, one of a closed
set in gateway-core (`AUTH_FAILURE_REASONS`): `token-rotated`,
`token-revoked`, `holder-removed`, `holder-deactivated`.

`mission-inactive` would be false: the mission is serving its other holders. A
new refusal code (`token-revoked`) was considered and not taken: the spec's
table of structured refusals (§4.1) is about a call by an **authenticated**
credential, each with a hint on what to ask the creator; a token that no
longer authenticates is the case the door already answers 401, and the eight
codes — in gateway-core, in the kit's per-code guidance, in the session events
and in the audit — stay exactly eight. The reason is only stated to a caller
who proved the secret, so it reveals nothing a working token would not.

One exception is kept from before: a token revoked **with its mission** still
identifies that mission, and its holder is told `mission-inactive` (revoked).
A removed member is not: the holder is judged first, so they learn that they
were removed and nothing about what became of the mission.

### D7 — The audit and the session name the token and its holder

Every call audit entry and every call session event carries `token_id`,
`token_kind` and the holder — the member's **user id** or the token's
**name** — taken from the authenticated context by the pipeline
(`tokenAttributionOf`), never from anything the caller sends. The agent label
stays what it was: a self-declared refinement _inside_ a token (which
sub-agent of that holder).

Entries written before this decision keep no holder: the audit is append-only
(its triggers refuse the `UPDATE` a backfill would need), and the truth about
those calls is that the instance did not know. They are listed as "not
attributed".

`GET /mcp/catalog` tells the caller whose token it holds (`token.holder`) and
who created the mission, so an agent can say "I am using Xavier's token on
mission X".

Nothing of this leaves the instance: the telemetry sink's event has no mission,
no token and no holder, and the structural telemetry test now plants a member
id, a member email, a token name and the token ids on every call.

### D8 — The management door stays as it was

`issue_mission` returns the delegating user's own member token; `rotate` and
`revoke` reach only missions the user **created**; `list_my_missions` also
lists the missions shared with the user, marked `role: member`. **No tool adds
a member, removes one or creates a named token**: who may act under a
person's authority is decided by a human in the interface.

## Consequences

- **Migration 0010** rebuilds `mission_tokens` (the holder rule is a CHECK over
  three columns and "one active token per mission" becomes "per holder").
  Existing tokens become member tokens of their mission's creator with the
  same id, prefix, hash and status: **no Bearer in use stops working and
  nothing is re-issued.**
- `MissionContext.token` (gateway-core) now carries the holder; `CallAuditEntry`
  gains `token_id`, `token_kind`, `token_holder`; four administrative acts are
  added (`mission-member-added`, `mission-member-removed`,
  `mission-token-issued`, `mission-token-revoked`).
- The verified-token cache and the verification throttle were already keyed by
  bearer and by prefix: they are per token without change. The cache's hit
  path no longer reads the token row itself; it asks the mission service, so a
  hit can never be more lenient than a miss.
- The surface rate limit stays **per mission** (spec §6): tokens of one mission
  share one window, as they share one budget.
- A member reads the whole session of the mission (spec §11.2 assumption). The
  **Audit page** stays scoped to the missions one created and the connections
  one owns: a member reads the session, not the audit.
- `mission_tokens.last_used_at` is written at most once a minute per token —
  the door's only write outside the pipeline, and it never refuses a request.
- Any signed-in creator can see the emails of the instance's active users in
  the "add a member" picker. On a single-company instance that is the
  directory people already have; it is written here because it is new.
- One more thing can go wrong for an agent: its token stops while the mission
  runs. The bootstrap kit and `/agent-bootstrap.md` say what each reason means
  and that the answer is always to go back to a human, never to look for
  another token.

## Rejected alternatives

- **Self-declared label only (the status quo, made mandatory).** Requiring an
  agent label, or a "user" header, on every call. Rejected: it is still a
  claim by the caller. Anyone holding the shared token can sign as anyone, a
  leaked token cannot be told from its rightful user, and revoking one person
  means rotating the token for everyone. The owner asked to _identify_ the
  user; a label cannot.
- **OAuth-authenticated executors on the execution door.** The executor would
  authenticate as a user (an OAuth flow, as on the management door) and the
  door would know the human directly, with no long-lived Bearer to hand out.
  Rejected **for now**: it puts a browser flow and token refresh in front of
  every agent, CI job and script, breaks the spec's "one door, one Bearer" for
  executors and the separation of the three credentials (§6), and leaves
  machines with no account unsolved. It is recorded as a possible later step:
  member tokens are the part of it that needs no client support, and the
  holder model (`member` | `named`) would carry an OAuth-proven member without
  change.
- **Per-member budgets.** Each member (or token) would get a share of the
  quota. Rejected: it contradicts "one budget per mission, however many agents
  or tokens" (spec §3.2) — adding a member would add budget, or the creator
  would have to split quotas by hand and re-split them at every change. If two
  groups need distinct budgets, that is two missions, as the spec says. The
  per-holder table of the session page is a count of calls, stated as not a
  budget.
- **A ninth refusal code `token-revoked`.** See D6.
- **A member row for the creator.** Uniform listing, but an invariant to keep
  ("the creator's row always exists and is never removed") that a column
  already states.
- **Members must hold the authority themselves** (a share of every
  connection). Rejected for v1 by the spec's own assumption (§11.2): it would
  turn "add a colleague" into "share N connections first", and make a mission
  orphan-able per member. Recorded there as an open question.
- **Backfilling the holder of past audit entries** as "the creator". It would
  need an `UPDATE` on an append-only table and would state something the
  instance never observed: with a shared token, the caller may have been
  anyone.
