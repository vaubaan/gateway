---
title: A plugin declares its secret arguments; the approval view shows a fingerprint instead of the value
status: accepted
date: 2026-10-16
---

# A plugin declares its secret arguments; the approval view shows a fingerprint instead of the value

## Context

An approval request shows its creator the call's arguments in clear. Some calls carry secrets
(`fly__set_secrets`), so approving would put a master key or a client secret on screen and in
browser memory. The approval binds the exact arguments and the replay resends them, so the secret
cannot be removed before sealing. Spec §3.4; handbook [plugin-sdk](../handbook/plugin-sdk.md).

## Decision

`ProviderPlugin.secretArguments` maps a tool to its top-level secret arguments, checked by
`definePlugin` against the input schema. The host masks every string inside them as
`[secret · sha256:<12 hex>]` in the approval view only; sealing, fingerprint, replay and audit use
the clear arguments.

## Consequences

- A plugin author whose tool carries a secret declares it; the default is "shown as is".
- Any new surface that displays sealed arguments applies the same mask.
- The 12-hex prefix can be brute-forced for a low-entropy value; it is shown only to the mission
  creator, and the threat addressed is the screen.

## Rejected alternatives

### Mask in the plugin before sealing

The approval binds the exact arguments and the replay needs the value.

### Mask every argument named like a secret

A heuristic that misses `values` and hides harmless fields; the plugin knows.

### Hide all arguments of the call

The person would decide blind on the rest of the call.
