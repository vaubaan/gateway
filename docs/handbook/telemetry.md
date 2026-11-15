---
title: Community telemetry — the report, the queue, the toggle, the validation badge
tracks:
  - packages/telemetry/src/
  - apps/gateway/src/server/telemetry/
  - apps/gateway/src/server/execution/telemetry-sink.ts
  - apps/gateway/src/server/execution/upstream-stage.ts
  - apps/gateway/src/server/config/telemetry-default.ts
  - apps/gateway/tests/unit/structural/telemetry-report-shape.test.ts
  - apps/gateway/tests/unit/structural/telemetry-collector-schema.test.ts
  - deploy/collector/
  - apps/website/src/collector/
last_reviewed: 2026-11-02
---

# Community telemetry — handbook

How an opted-in instance reports whether its plugins' calls worked, and shows the community status back. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §9, §10; receiving side: [website](../spec/website.md) §3, [`deploy/collector/README.md`](../../deploy/collector/README.md); ADR [telemetry-two-levels-behind-a-vercel-collector](../decisions/telemetry-two-levels-behind-a-vercel-collector.md).

## Start here

- [`packages/telemetry/src/report.ts`](../../packages/telemetry/src/report.ts) — the report constructors; `wire.ts` the body, `queue.ts` the batching, `client.ts` the gate.
- [`server/telemetry/outcome.ts`](../../apps/gateway/src/server/telemetry/outcome.ts) — `classifyOutcome`, from a plugin outcome to a closed vocabulary.
- [`server/telemetry/settings.ts`](../../apps/gateway/src/server/telemetry/settings.ts) — who decides on or off.
- [`server/telemetry/instance-id.ts`](../../apps/gateway/src/server/telemetry/instance-id.ts) — the instance identifier of the daily profile; `usage.ts` builds the profile.
- [`execution/telemetry-sink.ts`](../../apps/gateway/src/server/execution/telemetry-sink.ts) — the port the pipeline calls.

## Invariants

- **Nothing unvetted reaches the wire.** `createPluginReport` is the only constructor (frozen, exact keys, `null` if a value does not fit); `serializeBatch` rebuilds every report through it; the collector's `parseBatch` refuses an extra key; the vocabularies are also `CHECK` constraints of the collector's table (`telemetry-collector-schema.test.ts`). `telemetry-report-shape.test.ts` runs the real pipeline and checks nothing planted in arguments, errors or headers reaches the body.
- **`classifyOutcome` never copies a string**: it reads `instanceof`, a numeric status and fixed lists of `code` / `name`; anything free-text is `unspecified`. A tool not in `plugin.tools`, or a non-semver plugin version, is never reported.
- **Off means no request at all**, the statistics read for the badge included. Every `record` and `send` checks the gate, and switching off empties the queue (`discardQueued`), so nothing recorded while on leaves afterwards.
- **One plugin report per call, after the retry ladder** (a 401 then a successful refresh is one `success`); none when the broker failed before the plugin ran, and none for a call its caller abandoned (a disconnect is not a plugin outcome).
- **Both doors report decisions.** `withDecisionTelemetry` wraps the stages' audit writer, so the execution door and the git remote feed `callDecided`; only tool, decision, base risk ids and the gate flag reach the sink.
- **Telemetry never fails a call.** A throwing sink is caught and logged by class name; the module's own sink swallows its errors unlogged (they may carry service text).
- **`validated` is the collector's verdict** (`plugin_validation_thresholds()`), never computed by the gateway. Its success rate leaves out `credential_rejected` and is null when nothing else is left: the badge then shows no rate and is not validated.
- **The instance identifier travels with the profile only** (level `usage-stats`). It lives in `instance_config` under `telemetry.instance_id`, drawn by `InstanceIdentifier.current()` at the first profile and read from the store each time (replicas share it). Admin → Telemetry shows it (`peek()`, never draws) and its "Regenerate identifier" button posts to `/api/admin/telemetry/instance-id`, which writes a `config-changed` entry on `instance-config:telemetry-instance-id` with the old and new values.

## Traps

- **The only default URL of the code base** is `config/telemetry-default.ts` (`https://telemetry.vaubaan.com/v1/reports`).
- **A boolean in the configuration locks the toggle.** `telemetry.enabled: true|false` wins and Settings → Telemetry turns read-only (`TelemetryLockedError`); an empty YAML key is not a decision. Otherwise the stored toggle decides, off when none.
- **Another replica's toggle** is picked up because `enabledNow()` answers from memory and re-reads the store in the background every 30 s.
- **Coarse for rewrapped MCP servers**: a failure without HTTP status (a JSON-RPC error frame) is `unspecified`, and an upstream `isError: true` counts as `executor_refused`. It relies on the plugin contract: service failures are thrown, `isError` only for what the executor declines.
- **A restore from a backup brings back the backup's instance identifier** (it is a row of `instance_config`): two gateways restored from one backup count as one until an administrator regenerates on one of them. Decision counts since the previous profile are in memory and lost on restart.
- **Gateways up to 2.0.0-alpha.12 send `day_id`** in the profile; `parseBatch` reads it as `instance_id` (`LEGACY_PROFILE_ID_KEY`, `wire.ts`). Drop it once no supported release sends it.
- **A collector URL carrying `apikey=`** (an own collector behind PostgREST) has it moved to the `apikey` and `Authorization: Bearer` headers.
- **The queue is in memory and per process**: harmless per replica, since reports carry no identity. A rejected batch (any status but 408, 429, 5xx) is dropped; only the first one of the process is logged at `warn`.
- **The badge never waits**: a cache miss starts a background `refresh()` and answers no badge; a failed read is cached 10 minutes as nothing to show.

## Outside the repo

- **An own collector**: deploy `apps/website` with its three `COLLECTOR_*` variables over a Postgres that has `deploy/collector/schema.sql`, then set `telemetry.collector_url` (https; `plugin_stats` is read beside its last path segment). When the gateway's vocabulary grows, apply the current `schema.sql` there first, or batches are refused with 400.

## Debug

- **On, nothing arrives** → Settings → Telemetry shows "Sending: yes" and the URL (boot log `telemetry`); batches leave at most every 60 s.
- **Queued grows, sent stays 0** → collector unreachable or 408/429/5xx; `debug` `telemetry: the collector could not be reached`; backoff up to 1 h.
- **Dropped grows** → `warn` `telemetry: the collector refused a batch`: 401/403 = key, 400 = collector schema older than the gateway's vocabulary; or queue overflow (1 000).
- **No toggle** → the configuration sets `telemetry.enabled`.
- **No badge** → expected unless sending and the collector has a row for that exact plugin version.
- **Profile batches refused with 400 by an own collector** → its endpoint predates `instance_id`: apply the current `schema.sql`, then deploy the current site.
