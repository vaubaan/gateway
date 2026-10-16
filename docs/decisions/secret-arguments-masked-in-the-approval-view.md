---
title: Secret arguments — a plugin declares them, the approval view shows a fingerprint instead of the value
status: accepted
date: 2026-10-16
extends:
  - plugin-contract-and-credential-spec
  - one-approval-request-covers-the-call
---

# Secret arguments — a plugin declares them, the approval view shows a fingerprint instead of the value

> Product owner's decision of 2026-10-16 (Fly research, Q6). Spec patch:
> [vaubaan-gateway](../spec/vaubaan-gateway.md) §3.4 and the "Waiting for
> you" page. Handbooks: [plugin-sdk](../handbook/plugin-sdk.md),
> [requests](../handbook/requests.md), [fly](../handbook/providers/fly.md).

## Context

An approval request shows its creator the call's arguments in clear, so the
person decides on the exact call. The Fly plugin's `fly__set_secrets` carries
secret values in its arguments (a master key, an OIDC client secret), and its
`secret-write` permission asks first in every preset. Approving it would show
the secret to the approver: on screen, in the browser's memory, in a
screenshot of the page. The audit is not affected (it holds a hash only), nor
the replay (the executor sends the call again).

## Decision

1. **A declaration of the plugin.** `ProviderPlugin.secretArguments` maps a
   tool name to the names of its top-level arguments whose values are
   secrets (`{ fly__set_secrets: ['values'] }`). `definePlugin` refuses a
   tool that is not the plugin's or a name its input schema does not declare.
2. **The host masks, in the approval view only.** `approvalView` passes the
   opened arguments through `maskSecretArguments`
   (`apps/gateway/src/server/requests/masked-arguments.ts`): every string
   inside a declared argument — the argument itself, each value of an
   object, each item of a list — becomes `[secret · sha256:<12 hex>]`; keys,
   numbers, booleans and `null` stay. The secret names stay readable; the
   fingerprint tells two values apart and can be compared with what the
   person expects, without revealing the value.
3. **Nothing else changes.** The sealed arguments, the fingerprint that binds
   the approval, the replay and the audit are untouched. Provider pages
   (`provider_pages`) are still computed from the arguments in clear (they
   never read a secret argument).

## Consequences

- An approver of a secret write sees which secrets change and a fingerprint
  per value, never the value. Approving a value one cannot read is the price:
  the approver trusts the agent's source of the value, as they already do
  for a deploy.
- A plugin that hands secrets in its arguments declares them; the default
  stays "shown as it is". The Fly plugin is the first to declare one.
- The 12-hex SHA-256 prefix is not a secret-safe hash for low-entropy values
  (a short password can be guessed from it offline). It is shown to the
  creator of the mission only, who could read the secret at the provider
  anyway; the threat is the screen, not the creator.

## Rejected alternatives

- **Mask in the plugin (rewrite the arguments before sealing).** The
  approval binds the fingerprint of the exact arguments, and the replay must
  carry the value: the sealed copy must stay complete.
- **Mask every string argument named like a secret.** A heuristic that
  misses `values` (Fly) and hides harmless fields elsewhere; the plugin knows
  which argument is secret.
- **Hide the arguments of the call altogether.** The person would decide
  blind on everything else the call carries (the app, the secret names).
