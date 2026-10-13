---
title: Scope caps are not enforced in v5.0; catalogs may only declare what the door enforces
status: accepted
date: 2026-10-13
extends:
  - scope-caps-amplification-axis
  - pivot-v4-to-v5-on-prem-mission-tokens
---

# Scope caps are not enforced in v5.0; catalogs may only declare what the door enforces

> Settles a debt handed over by the execution-door feature: catalogs declared
> scope caps that no code on the call path read. Decided during the Phase 1
> cycle-end pass.

## Context

The v4 ADR [[scope-caps-amplification-axis]] introduced two optional blocks on
a catalog entry: `caps` (soft defaults a mission may tighten) and
`infra_limits` (hard ceilings nobody may loosen), each with five possible keys:
`temporal_window_days`, `items_per_call_max`, `bytes_per_call_max` (stateless:
enforced by rewriting the call's arguments through the plugin hook
`normalizeForCaps`), `calls_per_minute_max` and `calls_per_session_max`
(stateful: counted by the gateway).

The v5 execution door shipped without that stage. At the end of Phase 1:

- `ProviderPlugin.normalizeForCaps` and `normalizeArgs` are declared by the
  SDK, called by no host code and implemented by no plugin.
- Three catalogs declared caps on six entries (`stripe.refund-create`,
  `stripe.payout-create`, `gmail.read-from-zone-unknown`, `gmail.bulk-read`,
  `resend.send-batch`, `resend.broadcast-send`).
- The only value read anywhere was `infra_limits.calls_per_minute_max`: the
  mission preview refuses a rate limit above it, and the door then enforces the
  mission's rate limit.
- Three shipped preset entries allowed more than the `caps` of their own risk.

So an operator reading a catalog saw limits ("at most 1 item per call", "7 days
back") that the gateway did not apply. A declared control that is not enforced
is worse than no control: it is believed.

Wiring the stage is not a small change. It needs: arguments rewritten by a
stage to reach the upstream call (a contract change in the call pipeline);
a decision on which arguments the audit hash and the approval fingerprint
cover (raw or normalised); a refusal for a capped risk whose plugin cannot
enforce the cap, which is not one of the eight refusal codes of the v5 spec;
a hook signature that receives the tool name (the SDK's does not, the v4 ADR's
does); and an implementation in each plugin that declares a stateless cap.
The first three are specification decisions.

## Decision

1. **v5.0 does not enforce scope caps at call time.** The door has no cap
   stage. The amplitude of a mission is bounded by what v5 does enforce: the
   per-risk **quota** and **rate limit** of the mission policy (spec §3.2),
   the **gate**, and the resource selection.
2. **A catalog may only declare a limit the gateway enforces.** Today that is
   exactly one key: `infra_limits.calls_per_minute_max`, the ceiling on the
   rate limit a mission may be issued with. The list lives in one place,
   `ENFORCED_INFRA_LIMIT_KEYS` in
   `apps/gateway/src/server/execution/scope-caps.ts`; no `caps` key is in it.
3. **A structural test fails the build otherwise.**
   `apps/gateway/tests/unit/structural/catalog-caps-enforced.test.ts` loads
   every shipped plugin and fails when a catalog entry declares a `caps` block
   or an `infra_limits` key outside the enforced list. Enforcing a new key
   means adding it to the list in the same change that adds the enforcement
   and its test.
4. **The unenforced declarations are removed from the shipped catalogs**, and
   recorded here so the modelling work is not lost:

   | Risk                           | Removed `caps`                                                                    | Removed `infra_limits`                                    |
   | ------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
   | `stripe.refund-create`         | `items_per_call_max: 1`, `calls_per_minute_max: 3`, `calls_per_session_max: 20`   | — (`calls_per_minute_max: 30` kept)                       |
   | `stripe.payout-create`         | `items_per_call_max: 1`, `calls_per_minute_max: 2`, `calls_per_session_max: 5`    | — (`calls_per_minute_max: 30` kept)                       |
   | `gmail.read-from-zone-unknown` | `items_per_call_max: 10`, `calls_per_minute_max: 20`, `temporal_window_days: 7`   | `bytes_per_call_max: 1048576`                             |
   | `gmail.bulk-read`              | `items_per_call_max: 50`, `calls_per_minute_max: 5`, `temporal_window_days: 90`   | `items_per_call_max: 500`, `bytes_per_call_max: 10485760` |
   | `resend.send-batch`            | `items_per_call_max: 100`, `calls_per_minute_max: 5`, `calls_per_session_max: 50` | `items_per_call_max: 100`                                 |
   | `resend.broadcast-send`        | `calls_per_minute_max: 1`, `calls_per_session_max: 5`                             | — (`calls_per_minute_max: 10` kept)                       |

   The stateful values have a v5 equivalent an issuer already controls: the
   preset's (or the mission's) rate limit and quota for that risk. Limits a
   provider imposes itself (Resend refuses a batch above 100 emails; the
   Resend classifier refuses it first) need no declaration.

5. **The SDK surface stays.** `RiskEntry.caps`, `RiskEntry.infra_limits`,
   `ScopeCaps`, `InfraLimits`, `ProviderPlugin.normalizeForCaps` and
   `normalizeArgs` keep their shape so that enforcing caps later is not a
   contract change for plugin authors; their documentation says the v5.0 host
   does not call the hooks and refuses shipped catalogs that declare
   unenforced keys.

## Consequences

- What a catalog shows is what the gateway applies. The mission creation
  screen keeps showing the rate ceiling, the only limit it ever used.
- A mission that accepts `gmail.bulk-read` or `stripe.refund-create` is
  bounded by its quota and rate limit only; nothing caps the size of one call
  or how far back a read goes. This was already the behaviour; it is now
  stated in the execution-door handbook and the provider handbooks instead of
  being contradicted by the catalog. Gmail is `experimental` and exposes no
  tool, so the largest gap is latent.
- A third-party plugin loaded outside the shipped registry is not covered by
  the structural test. The SDK loader still accepts `caps` (stable contract);
  the plugin author guide says they are not enforced.
- Enforcing stateless caps remains a planned feature. It starts with the
  specification decisions listed in the context (pipeline contract, hash,
  refusal code, hook signature), then the door stage, then each plugin.

## Rejected alternatives

- **Wire `normalizeForCaps` into the door now.** It is the right end state,
  but it needs three specification decisions and a hook implementation in
  three plugins; done at the end of a phase, without those decisions, it would
  either refuse every mutating call on a capped risk or enforce something the
  spec does not describe.
- **Leave the declarations and document that they are advisory.** A reader of
  the YAML does not read the handbook; the catalog would keep stating limits
  that do not exist. The brief for this pass ruled it out: no
  declared-but-unenforced cap.
- **Remove `caps` from the SDK types and the loader.** Smaller surface, but a
  contract change now and another one when enforcement lands; the fields are
  optional and cost nothing while the structural test guards the shipped set.
- **Make the loader itself reject `caps`.** The loader belongs to the SDK and
  does not know what a given host enforces; the rule is a property of this
  host's door, so the check lives with the door.
- **Turn the stateful caps into mandatory preset values.** Presets are
  suggestions the issuer may change within the catalog ceiling; forcing a
  value there would be a hidden second mechanism for the rate limit and quota.
