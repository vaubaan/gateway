---
title: Mission members and per-holder mission tokens — every call names who made it
status: accepted
date: 2026-10-13
---

# Mission members and per-holder mission tokens — every call names who made it

## Context

A mission had one token shared by all its agents: the gateway knew the mission behind a call, not
the person, and revoking one person rotated everyone. One budget per mission, requests answered by
the creator alone, and a mission token as the only credential of the execution door had to stay
true.

## Decision

A mission has one or more tokens, each with exactly one holder: a `member` (the creator or a user
the creator added, who alone sees their secret) or a `named` holder with no account (a CI runner).
All tokens share the mission's policy and one budget; a token is an identity, not an allowance.

## Consequences

- What a token is worth is judged at every call from the store (`standingOf`); a stopped token is
  a 401 with a reason (`token-rotated`, `token-revoked`, `holder-removed`, `holder-deactivated`),
  not a new refusal code.
- Who is on a mission is stated once (`membershipOf`) and checked again inside the token insert's
  transaction, so a removal cannot race an issuance; re-adding a member revokes their old token.
- Members work under the creator's authority: only the creator losing it orphans the mission.
- Every audit entry and session event names token and holder from the authenticated context, never
  from the caller; the agent label stays a self-declared refinement.

## Rejected alternatives

### A mandatory self-declared label

Still a claim by the caller: anyone with the shared token signs as anyone.

### OAuth-authenticated executors on the execution door

Puts a browser flow in front of every agent and CI job; the `member` | `named` model could carry it
later.

### Per-member budgets

Contradicts one budget per mission; two groups with distinct budgets are two missions.

### Members must hold the authority themselves

Turns "add a colleague" into "share every connection first".
