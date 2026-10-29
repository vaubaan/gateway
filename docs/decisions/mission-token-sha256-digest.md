---
title: Mission tokens are stored as a SHA-256 digest; argon2id rows are read and moved on first use
status: accepted
date: 2026-10-13
---

# Mission tokens are stored as a SHA-256 digest; argon2id rows are read and moved on first use

## Context

A mission token is `vbn_live_<8-character prefix>_<32-character secret>`: the prefix is a clear
lookup key, the secret about 190 bits from the system's random source. Storing it as argon2id was a
password habit: a slow hash protects a guessable secret, and nobody can search 2^190 values. It
only cost CPU per verification, which required a throttle, an accepted risk and a cache with a
second code path.

## Decision

The store holds the SHA-256 of the whole token, verified by a prefix lookup and a constant-time
compare, with no cache. A legacy argon2id row is still checked and rewritten to the digest on its
first match; that path stays until the next major version.

## Consequences

- A stolen store yields no usable token.
- Every call reads the token row, mission and holder from the store: one path decides what a token
  is worth.
- The throttle guards legacy rows only; a digest row never meets it.
- The image ships `argon2` until the next major release drops the legacy path, with the cut-off in
  its release notes.

## Rejected alternatives

### Keep argon2id

Protects nothing for a long random secret and is the only reason for the throttle and the cache.

### A migration that rewrites every row

Impossible: the digest needs the secret, which the instance sees only when the holder presents it.

### HMAC-SHA-256 keyed with the master key

Useless for a long secret, and ties verification to key rotation.

### Invalidate existing tokens

Breaks every running agent on upgrade for no gain.
