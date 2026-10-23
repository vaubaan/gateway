---
title: Community telemetry — the report, the queue, the toggle, the validation badge
status: current
date: 2026-10-13
last_synced: 2026-10-23
tracks:
  - packages/telemetry/src/
  - apps/gateway/src/server/telemetry/
  - apps/gateway/src/server/execution/telemetry-sink.ts
  - apps/gateway/src/server/execution/upstream-stage.ts
  - apps/gateway/src/server/config/telemetry-default.ts
  - apps/gateway/src/app/admin/(guarded)/telemetry/
  - apps/gateway/src/app/api/admin/telemetry/
  - apps/gateway/src/components/telemetry/
  - apps/gateway/tests/integration/telemetry/
  - apps/gateway/tests/unit/structural/telemetry-report-shape.test.ts
  - apps/gateway/tests/unit/structural/telemetry-collector-schema.test.ts
  - deploy/collector/
  - apps/website/src/collector/
---

# Community telemetry — the report, the queue, the toggle, the validation badge

How an instance that opted in tells the project's collector whether the calls
its plugins executed worked, and how it shows the resulting community status.
Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §9, §10 (structural
test), §4.3 (opt-in and collector URL), §8 (the toggle is audited). Decision:
[telemetry-collector-shape](../decisions/telemetry-collector-shape.md). The
collector itself: [`deploy/collector/README.md`](../../deploy/collector/README.md).

**Off at installation**, and while it is off nothing leaves the instance —
no report and no statistics request. Once an administrator (or the
configuration) turns it on, reports go to `telemetry.collector_url`, which
defaults to the project's published collector,
`https://telemetry.vaubaan.com/v1/reports` (ADR
[telemetry-collector-shape](../decisions/telemetry-collector-shape.md),
amendment of 2026-10-23: the placeholder gate that refused to send to the
default URL is gone).

## Layout

```
packages/telemetry/src/            @vaubaan/telemetry — no I/O but the injected fetch; imports only
                                   the refusal codes and the RiskId grammar of @vaubaan/shared
  report.ts                        PluginReport (frozen, seven keys), vocabularies, createPluginReport,
                                   isPluginReport, durationBucket
  usage.ts                         level usage-stats: DecisionReport, InstanceProfile, their
                                   constructors, countBucket
  wire.ts                          the request body: serializeBatch (instance), parseBatch (collector)
  queue.ts                         ReportQueue: bounded, batched, backoff; ReportBuffer port
  client.ts                        TelemetryClient: the two gates, the POST, the collector headers
apps/gateway/src/server/
  execution/telemetry-sink.ts      TelemetrySink port + NOOP_TELEMETRY_SINK (owned by the pipeline)
  execution/upstream-stage.ts      the one hook: report(call, outcome)
  telemetry/
    index.ts                       createTelemetryModule → root.telemetry (sink, settings, stats,
                                   handlers, overview, flush, stop)
    outcome.ts                     classifyOutcome / reportOf: outcome → closed vocabulary
    usage.ts                       decisionReportOf, InstanceProfiler (day identifier, buckets),
                                   deploymentKindOf
    settings.ts                    TelemetrySettingsService: configuration vs operator toggle
    stats.ts                       PluginStatsReader: validation status from plugin_stats, cached
    handlers.ts                    POST /api/admin/telemetry
  config/telemetry-default.ts      the single default URL of the code base (the project's collector)
apps/gateway/src/app/
  admin/(guarded)/telemetry/page.tsx   Settings → Telemetry (/admin/telemetry)
  api/admin/telemetry/route.ts         one-line adapter over the handler
apps/gateway/src/components/telemetry/ValidationBadge.tsx
deploy/collector/                  schema.sql + README.md: the store
apps/website/src/collector/        the endpoint at telemetry.vaubaan.com (see deploy/collector/README.md)
```

## The report

`PluginReport` (`packages/telemetry/src/report.ts`) has exactly the keys of
`PLUGIN_REPORT_KEYS`:

| Key               | Source                                              | Shape                                              |
| ----------------- | --------------------------------------------------- | -------------------------------------------------- |
| `plugin`          | `plugin.id`                                         | `^[a-z][a-z0-9-]{0,62}$`                           |
| `plugin_version`  | `plugin.version`                                    | semver, bounded                                    |
| `gateway_version` | `root.build.version`                                | semver, or `dev` for an unstamped build            |
| `tool`            | the call's tool, **only if the plugin declares it** | `^[a-z][a-z0-9_]{0,95}$`                           |
| `outcome`         | `classifyOutcome`                                   | one of `REPORT_OUTCOMES`                           |
| `error_class`     | `classifyOutcome`                                   | `null` on success, else a class its outcome allows |
| `duration_bucket` | `durationBucket(execution.durationMs)`              | `lt_100ms`, `lt_1s`, `lt_10s` or `gte_10s`         |

`createPluginReport(input)` is the only constructor: a fresh frozen object
with the seven keys, or `null` when a value does not fit. The client queues
`{ kind: 'plugin-health', report }`; `serializeBatch` (`wire.ts`) rebuilds
every report through its constructor and groups them by kind
(`{"plugin_health": [...]}`), so the request body cannot carry an eighth key
or an unvetted value. The collector parses the same body with `parseBatch`,
which also refuses a report with an extra key. No timestamp, no instance
identifier, no host name is ever part of a report or of the request.

## The `usage-stats` level

`telemetry.level` (`VAUBAAN_TELEMETRY_LEVEL`, default `usage-stats`) says what
an enabled instance sends; `plugin-health` sends the reports above only. At
`usage-stats` (`server/telemetry/usage.ts`, `packages/telemetry/src/usage.ts`):

- **one decision report per audited call** that has a decision word:
  `decisionReportOf` names the plugin by the tool it declares or by its tool
  prefix (`cloudflare_dns__` → `cloudflare-dns`), keeps the tool name only if
  the plugin declares it, takes `allowed` or the refusal code, the risks
  touched through `baseRiskId` (the environment label is the company's and
  never leaves), and `gate: approval` when the call consumed an approval or
  was refused for want of one. A refusal without a code (an unknown tool, a
  plugin's denial, a stage that threw) and `wrong-credential-kind` give no
  report;
- **one instance profile per UTC day**: a timer checks every hour
  (`profileNow()`, also exposed for tests) and queues the day's profile once,
  while the client is sending. `InstanceProfiler` draws the day identifier
  (16 random bytes, hex) at the first use of a UTC day and keeps it in memory
  only; it is put on the profile and on nothing else. Counts come from the
  composition root's `ProfileSource`: active users, missions stored `active`
  and not expired (`missions.countActive`), accounts per provider that are not
  revoked, and the decisions counted since the previous profile (lost on a
  restart). All of them travel as buckets. `deploymentKindOf`: `railway` when
  `RAILWAY_PROJECT_ID` is set, `fly` when `FLY_APP_NAME` is, `docker` when
  `/.dockerenv` exists, else `other`.

The same vocabularies and shapes are `CHECK` constraints of the collector's
table; `telemetry-collector-schema.test.ts` compares the SQL text with the
exported constants.

## From a `plugin.execute` outcome to a report

`server/telemetry/outcome.ts`. `classifyOutcome(outcome)`:

| What `plugin.execute` ended with                                                                                                      | `outcome`              | `error_class`                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| a result, `isError` not `true`                                                                                                        | `success`              | `null`                                                            |
| a result with `isError: true`                                                                                                         | `classification-error` | `executor_refused`                                                |
| `UpstreamRefusalError` (credential refused for good, connection revoked)                                                              | `upstream-error`       | `credential_rejected`                                             |
| `UpstreamAuthError`, `UpstreamHttpError`, or any object with a numeric `status` 100–599                                               | `upstream-error`       | `http_<status>`                                                   |
| `code` / `name` of a timeout (`ETIMEDOUT`, `UND_ERR_*_TIMEOUT`, `AbortError`, `TimeoutError`), also down the `cause` chain (3 levels) | `upstream-error`       | `timeout`                                                         |
| a network `code` (`ECONNREFUSED`, `ENOTFOUND`, …) or `TypeError('fetch failed')`                                                      | `upstream-error`       | `network`                                                         |
| `TypeError` / `RangeError` / `ReferenceError` / `SyntaxError`                                                                         | `execution-error`      | `type_error` / `range_error` / `reference_error` / `syntax_error` |
| a thrown value that is not an `Error` (string, object, `null`)                                                                        | `execution-error`      | `non_error_throw`                                                 |
| any other `Error`                                                                                                                     | `upstream-error`       | `unspecified`                                                     |

Rows are tried in that order. The function reads classes by `instanceof`, a
numeric status, and compares `code` / `name` / the constant message
`fetch failed` for equality with fixed lists. It never copies a string from a
result or an error: an error whose `name`, `code` or `status` is free text
ends as `unspecified`.

`reportOf(execution, gatewayVersion)` returns `null` — no report — when the
tool is not in `plugin.tools`, or when a declared value does not fit the
report's shapes (a plugin whose `version` is not semver is never reported).

The table relies on the plugin contract ([plugin-sdk](plugin-sdk.md),
"Errors of `execute`"): a provider failure is **thrown** (`UpstreamAuthError`
on 401/403, `UpstreamHttpError` on another failed status, a network error as
it comes), and `isError: true` is returned only for what the executor
declines itself. Every shipped plugin follows it, so a provider 5xx is
`upstream-error` / `http_5xx`, never `classification-error`. Still coarse: a
provider failure that carries no status (a JSON-RPC error frame of a
rewrapped MCP server, an unusable answer) is `unspecified`, and a rewrapped
MCP tool whose **upstream** answers `isError: true` is passed through and
counted `executor_refused`.

## The hooks in the pipeline

`execution/telemetry-sink.ts` defines the port:

```ts
interface TelemetrySink {
  pluginExecuted(execution: {
    plugin: Pick<ProviderPlugin, 'id' | 'version' | 'tools'>;
    tool: string;
    outcome: { ok: true; result: unknown } | { ok: false; error: unknown };
    durationMs: number; // first execute → final outcome, retries included
  }): void;
  callDecided(decision: {
    tool: string;
    decision: 'allowed' | RefusalCode | null; // null: refused without a code
    risksTouched: readonly RiskId[];
    gated: boolean;
  }): void;
}
```

`callDecided` is fed by `withDecisionTelemetry(auditWriter, sink, onError)`,
the audit writer of the stages (`execution/index.ts`): after each call entry
is written, the entry is reduced to those four facts. The execution door and
the git remote share the stages, so both report; nothing else of the entry
(mission, token, holder, resource, hash) reaches the sink. A sink that throws
is logged by class name and never fails the write.

`pluginExecuted`:

`createUpstreamStage` takes `telemetry?: TelemetrySink` (default
`NOOP_TELEMETRY_SINK`). `forward()` records, in a `WeakMap` keyed by the
`CallRequest`, the plugin the call reached; `execute()` calls
`report(call, outcome)` once, after `attempt()` settled — success or the
error it is about to wrap. Consequences:

- one report per call, after the retry ladder (a 401 followed by a successful
  refresh is one `success`);
- no report when the credential broker failed before the plugin ran (nothing
  in the `WeakMap`), nor for a call refused at an earlier stage;
- a streamed call (handbook [execution-door](execution-door.md), "Streaming")
  is still one report, made when the stream has ended. After a first part the
  retry ladder is closed, so a 401 met midway is reported `http_401`, and a
  stream the provider breaks is `upstream-error`;
- **no report for a call its caller abandoned**: when the error is
  `CallerGoneError` (a stream stopped because the caller went away), or the
  call's signal is aborted at the moment the plugin fails, `execute()` skips
  `report`. A disconnect is not an outcome of the plugin, the report
  vocabulary has no word for it, and counting it would lower the success
  rate of a plugin that works. The audit entry is unchanged (`<provider>
stream stopped after N parts: the caller was gone`);
- a sink that throws is caught and logged by class name; it cannot fail a call.

The event carries no mission, connection, resource or argument. The module's
sink (`telemetry/index.ts`) returns at once when telemetry is disabled, and
otherwise builds the report and hands it to the client. It swallows its own
errors without logging them (they may carry provider text).

## The client and the queue

`TelemetryClient.record(report)` passes two gates, checked again by `send`
before every batch:

1. `isEnabled()` false → `state: 'disabled'`, nothing queued;
2. otherwise `state: 'sending'`: the report is queued and sent to the
   collector URL in use — the default one included.

A closed gate empties the queue, so a report recorded while telemetry was on
never leaves after it was switched off (`settings.onChange` also calls
`discardQueued()` on the transition).

`ReportQueue` (`QUEUE_DEFAULTS`): 1 000 reports at most, oldest dropped
first; batches of 50; a flush 60 s after the first queued report, or at once
when a batch is full; one request in flight. `send` answers:

| Collector                                    | Result      | Queue                                                                                                                  |
| -------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2xx                                          | `delivered` | batch removed                                                                                                          |
| network error, timeout (10 s), 408, 429, 5xx | `retry`     | batch kept; next attempt after `30 s × 2^(failures−1)`, capped at 1 h, shortened by up to 20 % at random               |
| any other status                             | `rejected`  | batch dropped; a `warn` with the status for the first refused batch of the process, later ones only counted as dropped |

The timer is `unref`'d and stopped by `root.close()`. Nothing is persisted.
The queue is `// single-process only`: each replica of a hosted deployment
would keep its own, which is harmless since reports carry no identity.

The request: `POST` to the configured URL, body `serializeBatch(batch)`;
`Content-Type: application/json`, `Prefer: return=minimal`, `User-Agent:
vaubaan-gateway-telemetry`; `redirect: 'error'`, no credentials, no referrer.
The response body is never read. The project's collector needs no key; a
configured URL that still carries an `apikey` query parameter (a collector of
your own behind PostgREST) has it moved to the `apikey` and `Authorization:
Bearer` headers (`collectorEndpoint`, `collectorHeaders`).

## Who decides: configuration, then the operator

`TelemetrySettingsService` (`settings.ts`):

| `telemetry.enabled` in the file / environment | Stored toggle (`instance_config` key `telemetry.enabled`) | Effective | `source`  | Toggle    |
| --------------------------------------------- | --------------------------------------------------------- | --------- | --------- | --------- |
| `true` or `false`                             | ignored                                                   | that      | `config`  | read-only |
| not set                                       | `true`                                                    | on        | `admin`   | editable  |
| not set                                       | `false`                                                   | off       | `admin`   | editable  |
| not set                                       | none                                                      | off       | `default` | editable  |

The loader exposes the distinction as `config.telemetry.enabledSetByConfig`
(true only for a boolean value; an empty YAML key is not a decision).
`enabledNow()` answers from memory — the client calls it on every report —
and re-reads the store in the background when its view is older than
`REFRESH_MS` (30 s), so a toggle made by another replica is picked up.
`setEnabled()` throws `TelemetryLockedError` when the configuration decides.

`POST /api/admin/telemetry` (`handlers.ts`), form field `enabled=true|false`:
operator only, origin-checked (`guardMutation`). A change writes one
`config-changed` entry on `instance-config:telemetry` with `before` / `after`
`{ enabled, source }`; a toggle that changes neither `enabled` nor `source`
writes none (a first explicit `false` over the default does: `source` goes
from `default` to `admin`). Refusals
redirect to `/admin/telemetry?problem=locked|invalid`.

## Settings → Telemetry

`/admin/telemetry` renders `root.telemetry.overview()`: "on" or "off" beside
the title, then the state and its source, where reports go (without the key;
whether a key is set), whether reports actually leave ("no: telemetry is off" /
"yes"), the counters since start, the button that turns it on or
off (replaced by "set in the mounted configuration" when locked), and **the
exact request body of one report** in a code block
(`data-testid="telemetry-sample"`) — `serializeReports` applied to a report
built from the first tool of the first registered plugin, through
`serializeBatch`, so what the
administrator reads is produced by the code that sends. A note appears only
when a change was refused ("Not changed"). The setup checklist
(`/admin`) carries a line for it, "Review" while it is off.

## The validation badge

`PluginStatsReader.statusFor(pluginId)` (`stats.ts`) backs
`<ValidationBadge>` on the reference (`/reference`, `/reference/<id>`) and in
the details of an account (`/accounts/<id>`, behind "Show details"):

- active only when the client's state is `sending`; otherwise `null` and no
  request — an instance that does not contribute never contacts the collector;
- it never waits for the network: it answers from `CacheClient` (key
  `telemetry:plugin-stats`) and, on a miss, starts `refresh()` in the
  background and answers `null` — the badge appears on a later render;
- `refresh()` issues one `GET <collector>/plugin_stats?select=plugin,plugin_version,reports,success_rate,validated&tool=is.null&plugin=in.(<registered ids>)`
  (5 s timeout, 512 KiB cap), keeps well-formed rows by `plugin@version`,
  caches them 6 h; any failure is cached 10 min as "nothing to show";
- the badge shows the row of the plugin version the instance runs:
  "validated by the community" or "not yet validated by the community", with
  the rate and the count as a tooltip; no row → no badge.

The thresholds are not in the gateway: `validated` is computed by the
collector (`plugin_validation_thresholds()`).

## Pointing an instance at a collector

```yaml
telemetry:
  enabled: true # optional: leave unset to decide from Settings → Telemetry
  collector_url: https://collector.example.net/v1/reports
```

or `VAUBAAN_TELEMETRY_COLLECTOR_URL` / `VAUBAAN_TELEMETRY_ENABLED`. The URL
must be https. The last path segment is the reports resource; `plugin_stats`
is read beside it. The project's collector is `https://telemetry.vaubaan.com/v1/reports`,
which is also the default URL: an instance that turns telemetry on without
setting `collector_url` contributes to it. To run your own, deploy `apps/website` with its three
`COLLECTOR_*` variables in front of a Postgres where `deploy/collector/schema.sql`
is applied — see its README. To never send anything whatever
Settings → Telemetry says, set `telemetry.enabled: false`.

## How to debug

- **On, but nothing arrives** → Settings → Telemetry, "Sending" says "yes"
  and "Reports go to" names the URL in use (the boot log line `telemetry`
  has `collector: "<url without its key>"`). Reports leave in batches at most
  every 60 seconds; check the counters below, then the next two entries.
- **Queued grows, sent stays 0** → the collector is unreachable or answers
  408/429/5xx; `debug` log `telemetry: the collector could not be reached`.
  Retries back off up to one hour.
- **Dropped grows** → the collector refused batches (`warn` `telemetry: the
collector refused a batch; it was dropped` with the status: 401/403 = wrong
  or missing key, 400 = the collector's constraints are older than the
  gateway's vocabulary — apply the current `schema.sql`), or the queue
  overflowed.
- **The button that turns it on or off is missing** → the configuration sets
  `telemetry.enabled`; the page says "Set in the mounted configuration".
- **No validation tag** → expected unless telemetry is sending and the collector has a
  row for that exact plugin version; `debug` log `telemetry: plugin
statistics unavailable` names a failure.
- **A tool is never reported** → it is not in the plugin's `tools`, or the
  plugin's `version` is not semver (`reportOf` returns `null`).

## Tests

- `packages/telemetry/src/report.test.ts`, `usage.test.ts`, `wire.test.ts`,
  `queue.test.ts`, `client.test.ts` — shapes and vocabularies of the three
  report kinds, buckets, the body both ends share; batching, overflow, backoff, single flight;
  disabled → zero calls; enabled → sent to the configured collector without
  a warning; headers.
- `apps/gateway/src/server/telemetry/outcome.test.ts`, `settings.test.ts`,
  `stats.test.ts` — the classification table, precedence, the reader.
- `apps/gateway/tests/unit/structural/telemetry-report-shape.test.ts` — spec
  §10: property-based over the real pipeline (three seeds × 400 calls);
  exactly seven keys, plugin-health only on the wire, every value from a universe fixed before the first call,
  nothing planted in arguments, errors, headers or identifiers found on the
  wire.
- `apps/gateway/tests/unit/structural/telemetry-collector-schema.test.ts` —
  SQL, README and report types agree, table by table.
- `apps/website/tests/unit/collector/` — the endpoint: storage per table,
  nothing of the request added, whole-batch refusal, statuses, the stats
  query it passes on, host gate, configuration.
- `apps/gateway/tests/integration/telemetry/telemetry.test.ts` — silence
  while disabled on a real root (the default URL included), reports sent to
  the default collector URL once enabled by the configuration or by the
  operator, the toggle and its audit entry, what is reported
  (a provider failure thrown with its status is `upstream-error` /
  `http_500`, with `upstream_error` in the audit), the badge.
- `apps/gateway/tests/integration/execution/streaming.test.ts` — no report
  for a call its caller abandoned, one for a stream the provider broke.
- `apps/gateway/tests/integration/audit/admin-mutations.test.ts` —
  `TelemetrySettingsService.setEnabled` classified as a mutation writing
  `config-changed`.

## References

- Spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §9, §10, §4.3.
- ADRs [telemetry-collector-shape](../decisions/telemetry-collector-shape.md),
  [telemetry-two-levels-behind-a-vercel-collector](../decisions/telemetry-two-levels-behind-a-vercel-collector.md).
- Spec [`website.md`](../spec/website.md) §3 (the receiving side).
- Handbooks: [execution-door](execution-door.md) (upstream stage),
  [configuration](configuration.md) (keys, composition root),
  [connections](connections.md) (pages carrying the badge),
  [plugin-sdk](plugin-sdk.md) (`version`, `tools`, what `execute` returns).
