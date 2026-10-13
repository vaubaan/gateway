---
title: Execution door — arguments must be JSON values; a repeated `approval` ends an opening; the shared verification window is accepted
status: accepted
date: 2026-10-13
extends:
  - unified-gates-drop-confirm
  - api-key-format-vbn-live-argon2id
amended-by:
  - mission-token-sha256-digest
---

> **Amended 2026-10-13** by
> [mission-token-sha256-digest](./mission-token-sha256-digest.md): mission
> tokens are stored as a SHA-256 digest, so the verification throttle and the
> shared window accepted here concern only tokens an earlier build stored as
> argon2id, until their first use. The verified-token cache is removed.

# Execution door — arguments must be JSON values; a repeated `approval` ends an opening; the shared verification window is accepted

> Three decisions of P3.4 from the defence-in-depth notes of the Phase 1 and
> Phase 2 security reviews. Handbooks:
> [execution-door](../handbook/execution-door.md),
> [gateway-core](../handbook/gateway-core.md),
> [missions](../handbook/missions.md).

## Context

1. **Fingerprint collision.** An approval is bound to the SHA-256 of the
   canonical JSON of the arguments. Canonical JSON writes `null` for a number
   JSON has no text for, and `JSON.parse('{"n":1e999}')` yields `Infinity`. So
   `{"n": 1e999}` and `{"n": null}` shared a fingerprint, the sealed copy the
   approver reads showed `null`, and the call that ran carried `Infinity` —
   which a plugin may treat differently (`args.n ?? 10`).
2. **Silent no-op on the gate.** `POST /api/missions/:id/gate
{gate: "approval"}` on a risk already gated, whose gate the creator had
   opened for the period, answered 200 and changed nothing: the opening
   stayed. The page only offers a toggle, so no user reached it, but the
   answer said "approval" while calls kept passing.
3. **Shared verification window.** A cache miss on a mission token costs one
   argon2id verification, throttled per token prefix **and client address**
   so that whoever knows a prefix (it is in logs and pages) cannot lock the
   real agent out. With `trusted_proxies` empty no address is believed and
   all callers share one window per prefix: a flood of wrong secrets on a
   known prefix then holds an agent whose token is not verified yet (first
   call, restart, 15 idle minutes) at 429 for as long as it lasts.

## Decision

1. **A call whose arguments are not JSON values is rejected before any
   stage.** `unfaithfulArgument` (gateway-core) finds the first non-finite
   number (or BigInt) and the pipeline answers a structural rejection naming
   its path — audited like an unknown tool, with no refusal code, no budget
   spent, no request opened. What is fingerprinted, sealed for the approver
   and handed to the plugin is therefore always what JSON carries as is.
2. **Asking `approval` on a gated risk that is open for the period ends the
   opening.** The service finds the opening with the budget's own derivation
   and tells the store, which records the `gate-changed` event that closes
   it; the audit entry carries `open_for_period: true → false`. The answer
   gains `opening_closed`. Asking again writes nothing.
3. **The shared window is accepted**, and said: with `trusted_proxies` empty
   the instance logs one warning at boot naming the key, what it costs and the
   remedy. The reference deployment sets it.

Two more, from the last security review of the same pass:

4. **Every slice of a call must be covered by the catalog.** The risk
   decision collected the risks of all the slices and refused only when the
   union was empty: a slice matching nothing (or a slice of another
   provider) was carried by the slices next to it. `evaluateCall` now denies
   as soon as one slice is uncovered. No shipped plugin emitted such a call;
   the rule was only asserted on samples by the plugin test kit.
5. **The audit copy of a structural reason holds no argument value.** A
   plugin's denial may quote the value it refuses. The caller still reads it
   whole; the audit entry (`refusal_reason`) has every argument value found
   in the text replaced by `[argument]`, and is bounded.

## Consequences

- A client that sends `1e999`, `-1e999` or anything parsing to a non-finite
  number gets `-32602` with the argument's path. No provider API takes such a
  value as JSON; none of the shipped tools declares one.
- `-0` and `0` still share a fingerprint. JSON carries both as `0` to the
  provider, and a plugin cannot tell them apart short of `Object.is`:
  accepted.
- The audit entry of a rejected call keeps the canonical hash of its
  arguments (the value reads `null` there), so it joins the other entries of
  the same arguments.
- An instance behind a proxy that is not declared runs with one shared
  window per prefix and one shared per-IP window on the request page. Nothing
  is bypassed — a forged `X-Forwarded-For` is ignored — and an agent already
  verified is never affected (its proof is renewed by its own calls). The
  threat-model handbook lists the risk; a test states the behaviour.

## Rejected alternatives

- **Give non-finite numbers their own token in the canonical form.** The
  fingerprints would differ, but the approver would still read `null` (the
  sealed copy is JSON) and approve a call that runs with `Infinity`.
- **Normalise the arguments (replace by `null`).** The gateway would execute
  something the agent did not send.
- **Reject `-0` too.** It breaks a legitimate, if unusual, client for a
  difference no provider sees.
- **Store a fast digest of the mission token** (SHA-256 at issuance, checked
  before argon2, so a wrong secret costs nothing and needs no throttle). It
  removes the lock-out entirely and is sound for 190-bit tokens, but it
  changes what the store holds of a mission token and makes argon2id
  vestigial: that is a revision of
  [[api-key-format-vbn-live-argon2id]], not a hardening fix, for a denial of
  service that needs network access to the door and that one configuration
  key removes. Left as a question for the owner.
- **Refuse to boot without `trusted_proxies`.** A single-host trial with no
  proxy would not start, for a limit that still holds as a global one.
- **Make the repeated `approval` an error.** The caller asked for the state
  the mission should be in; reaching it is the useful answer.
