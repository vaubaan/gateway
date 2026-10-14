---
title: Mission tokens — format `vbn_live_<prefix>_<secret>`, stored as a SHA-256 digest; argon2id rows are read and moved on first use
status: accepted
date: 2026-10-13
supersedes:
  - api-key-format-vbn-live-argon2id
---

# Mission tokens — format `vbn_live_<prefix>_<secret>`, stored as a SHA-256 digest; argon2id rows are read and moved on first use

> Product owner's decision of 2026-10-13 (question 3 of the final pass).
> Supersedes
> [api-key-format-vbn-live-argon2id](./api-key-format-vbn-live-argon2id.md):
> the format is kept, the hash is replaced. Amends the throttle of
> [execution-door-json-faithful-arguments-and-shared-throttle](./execution-door-json-faithful-arguments-and-shared-throttle.md).
> Spec: [vaubaan-gateway §6](../spec/vaubaan-gateway.md). Handbooks:
> [execution-door, "Token verification"](../handbook/execution-door.md#token-verification-token-verifierts),
> [missions](../handbook/missions.md), [threat-model](../handbook/threat-model.md).

## Context

A mission token is `vbn_live_<8-character prefix>_<32-character secret>`, both
parts base62, drawn by the instance from the system's random source. The
prefix is stored in clear and is the lookup key; the secret is about 190 bits.

The token was stored as an argon2id hash (19 MiB, 2 iterations), a choice made
for the hosted product by analogy with passwords. A slow hash protects a
secret a human chose, because an attacker who steals the table can try the
likely values. Nobody can try 2^190 values, slow hash or not: for a long
random secret argon2id buys nothing. It did cost three things:

- tens of milliseconds of CPU for every cold verification, which made a flood
  of wrong secrets on a known prefix a way to burn the instance's CPU;
- hence a **throttle** before the hash, keyed on prefix and client address,
  and with it an accepted risk: without a trusted proxy, such a flood held a
  not-yet-verified agent at 429;
- hence a **verified-token cache** (a proof per bearer, sliding TTL, a
  single-flight map), state held in one process, and a second code path — "what
  is a cached proof worth now" — that had to be kept exactly as strict as the
  first.

## Decision

### D1. Format: unchanged

`vbn_live_<8>_<32>`, base62, revealed once to its holder, masked as
`vbn_live_<prefix>_…` afterwards. `vbn_test_` stays for fixtures.

### D2. At rest: the SHA-256 digest of the whole token

`mission_tokens.hash` holds the lowercase hexadecimal SHA-256 of the Bearer and
`hash_alg` says `sha256`. Verification is a lookup by prefix and a constant-time
comparison (`timingSafeEqual`). A stored value that is not sixty-four lowercase
hexadecimal characters matches nothing.

No schema migration: the two columns exist since `0001`, and `hash_alg` was
there for this.

### D3. Tokens already issued keep working

A row written by an earlier build has `hash_alg = 'argon2id'`. Each row is
checked with the algorithm it names, so such a token authenticates as before,
with the same Bearer. **The first call that matches replaces the stored hash by
the digest of that same Bearer** (`MissionsRepo.rehashToken`, written only
while the row still holds the hash that was read). Nothing else of the row
moves. If the write fails the call goes on and the next one tries again.

A row naming any other algorithm matches nothing: there is no default.

### D4. The cache goes; the throttle stays for legacy rows only

- The verified-token cache, its TTL and its single-flight map are removed.
  Every call reads the row, its mission and its holder from the store, which a
  cache hit already did.
- `MissionService.provenToken` is removed with it: one path decides what a
  token is worth.
- The throttle is not removed yet, because it still has its original purpose
  for one population: a token stored as argon2id and not used since the
  upgrade. The verifier passes its limiter to `verifyToken` as a gate, asked
  only when the row found is a legacy one, before anything is computed. A token
  stored as a digest never meets it: wrong secrets on its prefix are answered
  401 each, and its agent is never held.

### D5. When argon2 can leave

When no active row has `hash_alg = 'argon2id'`. Then the legacy check, the
gate, the throttle and the `argon2` dependency (a native addon the image has to
carry) go together. Not decided here: a row that is never used again never
moves, so the removal needs either a cut-off after which unused legacy tokens
are declared retired, or patience.

**Settled on 2026-10-14** (product owner, [owner-decisions-second-round](owner-decisions-second-round.md)):
the argon2id path stays until the next major version of the gateway. No v5
release removes it, so a token stored by an earlier build keeps working, and is
moved to its digest on its first use, for as long as v5 lasts. The next major
version may drop it, with the cut-off stated in its release notes.

## Consequences

- Issuing a token no longer takes tens of milliseconds.
- A stolen copy of the store still gives no token: the digest of a 190-bit
  secret cannot be inverted or searched.
- Accepted risk A2 (threat model) shrinks to legacy tokens that have never
  been used since the upgrade; one successful call ends it for that token.
- One less piece of single-process state (the proofs and the in-flight map).
- `verifyToken` now has one write, on the legacy path. It is not an
  administrative act and writes no audit entry: same secret, same row, same
  holder, same status. It is logged with the mission and the token prefix.
- The image still ships `argon2` until D5.

## Rejected alternatives

- **Keep argon2id.** It protects nothing here and is the only reason for the
  throttle, the cache and an accepted risk.
- **Invalidate existing tokens.** Simple, and it breaks every agent of every
  running instance on upgrade for no gain. The product owner asked that issued
  tokens keep working.
- **A migration that rewrites every row.** Impossible: the digest is computed
  from the secret, which the instance does not have. The only moment it has it
  is when the holder presents it.
- **HMAC-SHA-256 keyed with the master key.** It would make a stolen table
  useless even for a short secret; the secret is not short, and it would tie
  token verification to key rotation.
- **Remove the throttle now.** A legacy prefix would again let anyone make the
  instance compute argon2id at will.
- **Keep the cache for legacy rows.** A legacy row is slow exactly once: the
  call that matches moves it.
