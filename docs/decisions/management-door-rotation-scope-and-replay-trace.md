---
title: Management door — rotation reaches only what the delegation issued; a replay names the missions to review
status: accepted
date: 2026-10-13
extends:
  - management-door-authorization-server
---

# Management door — rotation reaches only what the delegation issued; a replay names the missions to review

> Two decisions left open by the Phase 2 security review (notes 1 and 2 of its
> first slice), taken in P3.4. Handbook:
> [management-door](../handbook/management-door.md).

## Context

**Rotation.** `rotate_mission_token` answers with the new mission token. It
accepted any active mission of the delegating user, so a delegated client
could obtain the token of a mission the human had issued in the interface —
wider than anything the client issued, possibly with a gate the human had
opened for the period. The spec lists "rotate a mission's token" among the
door's acts (§4.1 bis) and the consent screen said so; it was nevertheless the
nearest thing to the path the door exists to exclude: an agent holding both a
mission token and a delegated token of its creator "must have no path by which
it enlarges itself".

**Replay.** A replayed refresh token or authorization code revokes the
delegation with all its tokens (RFC 9700). The missions that delegation had
issued stayed, as for any revocation ("the missions it issued are theirs and
stay"). After a replay that sentence is not safe: two parties held the
delegation, and whoever stole it may have issued a mission and still hold its
mission token, possibly with no expiry. Nothing told the user.

## Decision

### 1. A delegation rotates only the missions it issued

`rotate_mission_token` refuses a mission whose `delegation_id` is not the
delegation of the call, with `mission-not-issued-here`, before the mission's
state is looked at and before the mutation budget is touched. That covers a
mission the human issued, a mission another client issued, and a mission an
**earlier delegation of the same client** issued.

The rule is held twice: by the tool, which words the refusal, and by
`MissionService.rotate`, which answers `not-issued-by-delegation` whenever a
`delegation` option names another delegation than the mission's — so the
door's one `rotate` port cannot reach further whatever the tool does.

`list_my_missions` says which missions qualify
(`issued_via.this_delegation`). `revoke_mission` is unchanged: it reaches
every mission of the user, because ending a mission enlarges nothing. The
human rotates any of their missions on the mission's page. No consent option
widens this.

### 2. A replay names the missions to review; it revokes none

When a delegation is revoked for `refresh-token-replay` or
`authorization-code-replay`:

- its `delegation-revoked` entry carries `after.missions_to_review`: the id
  and name of each mission the delegation issued that still runs (not
  revoked, not expired; `orphaned` counts, the authority may return);
- the log line (`warn`) carries their ids;
- the Delegations page shows, on that delegation, a banner listing them with
  a link to each, saying they were **not** revoked and what to do: revoke the
  ones not recognised, rotate the token of the ones kept.

Nothing is stored for this: the list is derived at every read from the
delegation's revoke reason and the missions' `delegation_id`, and shrinks as
the user revokes missions or they expire.

## Consequences

- A delegated client can no longer come to hold a mission token it did not
  receive at issuance. The door's surface is narrower than spec §4.1 bis
  ("rotate … one of the user's missions"): **the spec should say "a mission it
  issued"** — reported to the planning agent, `docs/spec/` is not edited here.
- A client that is authorized again (a new delegation) does not rotate the
  missions of its previous delegation. After a replay this is the point: the
  new, honest delegation must not be handed the token of a mission the thief
  may have issued — and the user is told to review those.
- The consent screen and the Delegations page say "rotate the token of the
  missions it issued, and revoke any of your missions".
- New refusal code `mission-not-issued-here` (management door); new field
  `issued_via.this_delegation`. Both are additions to the door's contract.
- After a replay the stolen-then-issued mission keeps serving until the user
  acts. That is accepted (threat-model handbook): the alternative stops the
  honest client's agents on a suspicion, and the user now has the list.

## Rejected alternatives

- **Opt-in at consent** ("also let it rotate my own missions"). A second
  scope, a column on the delegation and a second consent sentence, for a need
  nobody stated: a human rotates their own mission in one click. It would
  also re-open exactly the path this closes, by default-off checkbox.
- **Scope rotation by client instead of by delegation.** After a replay the
  re-authorized client would rotate — and receive the token of — missions the
  thief issued under the same client id.
- **Revoke the missions of a replayed delegation.** The server cannot tell
  which party issued which mission. Most replays are an honest client's bug
  or a restored backup; revoking would stop running agents and destroy
  sessions and budgets on a guess.
- **Store a "to review" flag on the mission.** A verdict that goes stale: the
  derived list needs no write and no migration, and cannot disagree with the
  delegation's state.
