---
title: A refused permission stays a no; the agent may ask for it, deliberately and with a reason
status: proposed
date: 2026-10-16
extends:
  - one-approval-request-covers-the-call
  - claim-reset-is-the-claimed-risk-only
---

# A refused permission stays a no; the agent may ask for it, deliberately and with a reason

> **Proposed** on 2026-10-16, for the product owner to accept. It follows a real
> case on the dogfood instance: an agent's `git push` of `v5`, `main` and a tag
> was refused (`github.uncategorized-write`, `github.merge-protected`,
> `github.tag-write` not in the mission), and the only way forward was for the
> creator to issue a new mission by hand. The product owner's rule: "it must
> not be the default. We answer no to the agent, and if it really finds the
> request legitimate, then it asks for the authorization." Not implemented.
> Amends spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.4 (the last
> paragraph: "`risk-not-accepted` through re-issuance of the mission by its
> creator") and §4.1 (the `risk-not-accepted` refusal).

## Context

Spec §3.4 sends every refusal that calls for more authority to a human
through a **request** in the creator's inbox — except one. `budget-exhausted`
opens a claim and `approval-required` opens an approval request, both
automatically, both with a URL in the refusal. `risk-not-accepted` opens
nothing: the creator must re-issue the mission, which hands out a new key and
leaves the old one to be revoked.

Opening a request automatically on every `risk-not-accepted` would fill the
inbox with what agents try by mistake: a refusal is the normal answer to an
agent exploring what it may do, and most of them should stay refusals. The
budget and approval cases are different: the creator already accepted the
risk; only the quantity or the moment is in question.

## Decision (proposed)

### D1 — The refusal stays a refusal

A call that touches a risk the mission does not accept is refused as today,
immediately, and **nothing is created** in the creator's inbox. The refusal
gains one field, `refusal_id`: an opaque identifier of this refusal, valid
for a short time (proposed: 15 minutes), and a `hint` that tells the agent it
may ask for the permission **only if the task it was given requires it**, and
how.

### D2 — Asking is a deliberate act of the agent: `vaubaan__request_permission`

A tool of the execution door, listed with the mission's tools, authenticated
by the mission key like any call. Arguments: `refusal_id` and `reason` (what
the task is and why it needs this permission; 1 to 1 000 characters). The
gateway checks that the refusal belongs to this mission and to this key's
holder and has not expired, then opens a **permission request** in the
creator's inbox and answers with its URL, which the agent hands to the human
as it does for a claim.

For a refused `git push`, the agent reads the `refusal_id` in the message git
prints and calls the tool through MCP. The git remote itself opens nothing.

The `reason` is the agent's text: the request page shows it as such ("the
agent says"), never as a statement of the gateway.

### D3 — What the creator can answer

The request page shows the call as the gateway saw it (tool or refs pushed,
arguments fingerprinted as for an approval), the missing permissions with
their labels and severity, the agent's reason, and the mission. Three answers:

- **Allow this call once.** A single-use grant bound to the call's
  fingerprint (the same binding as an approval request, ADR
  [[one-approval-request-covers-the-call]]): the agent replays the exact call
  and it passes, counted against no quota of the missing permission; any
  change asks again. For a git push the fingerprint is the list of refs with
  their old and new commits.
- **Add the permission to the mission**, with a quota, a rate limit and
  optionally "ask me first" — the same edit as changing the mission's limits
  (ADR [[mission-limits-editable-after-issuance]]). The key does not change.
- **Refuse.** The agent's next identical call is refused again, and its
  `refusal_id` cannot be used to ask a second time.

Either grant is bounded by the creator's authority at the moment they answer:
a permission they do not hold is not offered, with the reason.

### D4 — Bounded so that asking cannot become noise

- One open permission request per mission and holder for the same set of
  missing permissions; asking again returns the open one.
- A per-mission limit on requests (proposed: 10 per day), refused with
  `rate-limited` past it.
- An expired or refused request is closed; the agent learns it from the
  answer of the tool on its next attempt.
- The request, the answer and the single-use grant are audited, like a claim.

## Consequences

Positive:

- The default stays "no": nothing reaches the creator unless an agent decided
  the task needed it and said why.
- The creator answers in the inbox they already use, without issuing a new
  mission or handing out a new key.
- "Allow once" covers the one-off event (a release, a merge into `main`)
  without leaving the permission in the mission.

Negative:

- A new tool on the execution door, and a new kind of request beside claims
  and approvals.
- The agent's reason is text written by the agent; a creator can be talked
  into a grant. The page labels it as the agent's words and shows the exact
  call; the decision stays theirs.
- Agents must be taught when not to ask; the hint and the bootstrap kit's
  instructions carry that rule.

## Rejected alternatives

### Open a request automatically on every `risk-not-accepted`

Refused by the product owner: the inbox would fill with what agents try by
mistake, and an agent would learn that every refusal is a question to the
human.

### Let the agent widen its own mission through the management door

The management door can issue missions in the creator's name, but its
instructions forbid using it to get past a refusal, and a new mission is a new
key and a wider standing grant where a single call was needed.

### Keep re-issuance as the only path

What happened on 2026-10-16: the creator leaves the conversation to rebuild a
mission in the interface, for one push.

## Questions for the product owner

1. "Allow this call once" and "add to the mission" both, or only the second?
2. The limits of D4 (15 minutes for a `refusal_id`, 10 requests a day per
   mission): right order of magnitude?
