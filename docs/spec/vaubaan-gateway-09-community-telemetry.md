---
title: Vaubaan Gateway spec §9 — Community telemetry
status: draft
---

# Vaubaan Gateway spec — §9 Community telemetry

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §9").

## 9. Community telemetry

Plugins cannot be tested against real services in the automated suite; trust comes from usage.
Mechanics and decisions: [telemetry handbook](../handbook/telemetry.md); receiving side:
[website](./website.md) §3.

- **Opt-in per instance**, off at installation, set by the operator, visible in the interface:
  **off**, **plugin-health**, **plugin-health + usage-stats**.
- **Level `plugin-health`** — one report per call a plugin executed: plugin id and version, gateway
  version, tool name, outcome (`success`, `upstream-error`, `classification-error`,
  `execution-error`), normalized error class, duration bucket (`<100ms`, `<1s`, `<10s`, `>=10s`).
- **Level `usage-stats`** — in addition: one **decision report** per call decided (plugin id, tool
  name if the plugin declares it, gateway version, decision, the `RiskId`s touched without their
  environment qualifier, whether a gate applied); one **instance profile** per UTC day (gateway
  version, deployment kind, runtime version and architecture, enabled plugins and versions, kinds of
  sign-in providers, bucketed counts), carrying the **instance identifier**.
- **Instance identifier** — 128 random bits (32 hex characters) the gateway draws the first time it
  needs one and keeps in its store; an administrator sees it and can regenerate it in
  Administration → Telemetry. It travels in the instance profile only, so only at `usage-stats`,
  never in a plugin-health or decision report: no call is attributable to an instance. It lets the
  community count the gateways running a plugin version over the window.
- **No report carries a time.** The collector stamps arrival, truncated to the UTC hour.
- **Never**, at any level: arguments or their hashes, payloads, service responses, error text,
  resource refs, environment labels, mission or user identifiers, emails, account or host names,
  URLs, a network address, any identifier of the instance on a call. Every field is a
  closed-vocabulary value, a shape bounded by the plugin's declaration, a bucket, or the instance
  identifier of the profile.
- **Public aggregation**: calls and success rate per `(plugin, version, tool)` — the rate leaves out
  calls refused for a rejected credential, which are the user's configuration, not the plugin —;
  gateways per plugin, plugin version and minor over the window (distinct instance identifiers);
  reporting instances per day. A plugin is **deemed validated** above a published success threshold
  and minimum report count; the interface shows the status on each account and in Reference. Other
  usage statistics are for the maintainers ([website](./website.md) §5).
- The collector never stores a network address nor a field a report does not define. Each level's
  content is published word for word on the trust center.
