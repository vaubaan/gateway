---
title: Telemetry collector shape — insert-only Supabase table, six-field report, client silent until a real collector exists
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
---

# Telemetry collector shape — insert-only Supabase table, six-field report, client silent until a real collector exists

> Fixes what the pivot ADR [[pivot-v4-to-v5-on-prem-mission-tokens]] (D5: opt-in
> telemetry towards "a dedicated Supabase project, anonymous append-only insertion by
> RLS, a public `plugin_stats` view, a default URL in the code") left open. Implemented
> by feature P2.5 of the v5 plan. Handbook: [telemetry](../handbook/telemetry.md).
> Collector: [`deploy/collector/`](../../deploy/collector/README.md).

## Context

Spec §9: plugins cannot be tested against real providers by the project, so trust comes
from usage. An instance that opts in reports, per call a plugin executed, "plugin
identifier, plugin version, gateway version, tool name, outcome, normalized error class.
Nothing else", and **never** "arguments, argument hashes, resource refs, mission
identifiers, user identifiers, stable instance identifier, network address". A plugin is
deemed validated above a published success threshold and a minimum number of reports; the
interface shows that status on each connection. The collector's shape "is an
infrastructure decision, not part of this spec". Spec §10 asks for a structural test of
the report's shape. Spec §4.3 lists "the telemetry opt-in and the collector URL (default
supplied, overridable, disableable)" among the instance configuration, and the plan allows
exactly one default URL in the code.

The pivot ADR chose the vendor (a Supabase project with no other role). The plan (§5.6)
leaves to this ADR: the DDL and RLS, the public view and the thresholds, batching and
retry on the client, rate limiting on the collector, the default URL and how an instance
overrides or disables it, and the audit of what is not sent — including the collector's
own logs.

Three facts shaped the answers:

- **The collector does not exist yet.** The default URL in the code
  (`telemetry-default.ts`) is a placeholder host. A client that trusted it would post
  reports to whoever ends up behind that name.
- **Providers echo input in their errors.** A plugin error message routinely contains a
  SQL fragment, a path, an object id. Anything derived from an error's text, or from a
  field a plugin controls (`name`, `code`), can carry what §9 forbids.
- **A hosted Supabase project logs the caller's address** (`cf-connecting-ip`,
  `x-real-ip`) in its API gateway logs, for 1 to 90 days depending on the plan, and offers
  no project setting to turn that off.

## Decision

### D1 — The report is six fields from closed vocabularies; one constructor; text never travels

`@vaubaan/telemetry` owns the frozen type `PluginReport`: `plugin`, `plugin_version`,
`gateway_version`, `tool`, `outcome`, `error_class`. `createPluginReport` is the only
constructor: it checks each value against a narrow shape or a closed list and returns
`null` otherwise; `serializeReports` rebuilds every report through it, so a value that
reached the queue by a cast still leaves with six vetted keys or not at all.

`plugin`, `plugin_version` and `tool` come from the plugin's own declaration; a tool name
the plugin does not declare yields no report, so a name chosen by an agent never travels.
`gateway_version` is the build stamp. No timestamp is sent.

### D2 — Four outcomes, decided from the shape of what `plugin.execute` ended with

- `success` — the plugin returned a result that is not an error. `error_class` is null.
- `classification-error` — the plugin returned `isError: true`. Class: `executor_refused`.
- `upstream-error` — a thrown value carrying an HTTP status (`http_<100–599>`), a
  transport failure (`network`, `timeout`), a credential refused for good
  (`credential_rejected`), or a plain `Error` (`unspecified`).
- `execution-error` — a JavaScript programming error (`type_error`, `range_error`,
  `reference_error`, `syntax_error`) or a thrown value that is not an `Error`
  (`non_error_throw`).

The reduction (`server/telemetry/outcome.ts`) reads only: whether a result has
`isError === true`; the JavaScript class of a thrown value by `instanceof`; a numeric
HTTP status in range; and an error `code` / `name` **compared for equality** with fixed
lists (Node network codes, `AbortError`) and then discarded. It never copies a string out
of a result or an error.

`classification-error` means: the plugin's executor declined a call its own classifier
had let through (unknown tool, a target or argument the executor rejects, a tool not
implemented). That is the classification defect an instance can observe at this stage
without reading text.

### D3 — One hook, at the upstream stage, once per call

The upstream stage takes an injected `TelemetrySink` (no-op by default) and hands it the
final outcome of each call that reached `plugin.execute`, after the retry ladder: an
expired OAuth token that is refreshed and succeeds is one `success`, not an error followed
by a success. A call the gateway refused before the plugin ran is not a plugin outcome and
is not reported. The event carries the plugin, the tool and the outcome — no mission, no
connection, no resource, no argument: the stage does not hand over what a report may never
contain. The sink is synchronous and never fails a call.

### D4 — The client is off, and silent while the collector URL is the placeholder

Three gates, checked when a report is recorded and again before a batch is sent:
telemetry disabled → nothing queued; collector URL equal to the placeholder default →
nothing queued, one warning per process; otherwise queue and send. Switching telemetry off
empties the queue. The placeholder stays in `telemetry-default.ts` as the single default
URL of the code base; publishing the real collector is a one-line change there in a
release. Until then an operator who wants to contribute sets `telemetry.collector_url`.

The validation status is read from the collector under the same gates: an instance that
does not contribute makes no request at all to the collector.

### D5 — Who decides: the configuration when it speaks, otherwise the operator's toggle

`telemetry.enabled` set in the mounted file or the environment — to `true` **or**
`false` — wins and makes the Admin toggle read-only. When the configuration is silent, the
toggle of Admin → Telemetry decides; it is stored as `telemetry.enabled` in
`instance_config` and audited as `config-changed` on `instance-config:telemetry`. Default:
off. This is the precedence every other setting shared by the file and the Admin page
follows (IdP, provider apps).

### D6 — Batching and retry

An in-process queue of at most 1 000 reports (oldest dropped first), flushed in batches of
50 every 60 seconds or at once when a batch is full. One request in flight at a time. A
network failure, a timeout, HTTP 408, 429 or 5xx keeps the batch and retries with
exponential backoff (30 s doubling to 1 h, shortened by up to 20 % of jitter); any other
status drops the batch — a payload the collector refuses is never sent twice. Nothing is
persisted: a restart loses the queue.

### D7 — The wire: PostgREST bulk insert, public key in headers, nothing else

`POST <collector URL>` with a JSON array, `Prefer: return=minimal` (no read-back
privilege exists). The collector URL is one configuration value: the REST endpoint of the
table, optionally with the project's publishable key as an `apikey` query parameter, which
the client moves to the `apikey` and `Authorization` headers and removes from the URL. The
statistics endpoint is the same URL with its last path segment replaced by `plugin_stats`.
No cookie, no referrer, redirects refused, a constant user agent, no version or instance
header.

### D8 — The collector: one insert-only table, one public view, thresholds in SQL

`deploy/collector/schema.sql` (idempotent, applied by hand to a dedicated project):

- `public.plugin_reports`: the six columns, an identity, and `received_on` — the **UTC
  day** of arrival, set by the database. `CHECK` constraints repeat the vocabularies and
  shapes of D1/D2, so the database refuses free text even from a hostile client.
- RLS enabled with a single policy, `for insert to anon`. No select, update or delete
  policy. Privileges say it again: `anon` holds `INSERT` on the six columns only.
- `public.plugin_stats`: per `(plugin, plugin_version, tool)`, plus one row per
  `(plugin, plugin_version)` with `tool` null; `reports`, `successes`, `success_rate`,
  `validated`. It runs with its owner's rights so `anon` reads aggregates and no row.
- `public.plugin_validation_thresholds()`: **200 reports, 90 % success, over 90 days**.
  One place; the README publishes the same numbers and a test compares them.
- Ingestion limit in a statement-level trigger: 200 rows per request, 6 000 rows per
  minute for the whole table, refused with HTTP 429 (`SQLSTATE PT429`).

### D9 — No address retention is a property of how the collector is run

The table stores no address. The platform's request logs do, so the collector is run
behind an address-stripping reverse proxy operated by the project (the host name of the
default URL), with its access log off and the forwarding headers removed; or on a
self-hosted stack whose log pipeline drops the address fields. Calling the hosted project
directly bounds retention to the plan's log window and does not meet §9; the collector is
not published as the default while it runs that way. Details:
[`deploy/collector/README.md`](../../deploy/collector/README.md).

## Consequences

Positive:

- Nothing forbidden by §9 can be sent by construction: the event the pipeline hands over
  contains none of it, the reduction copies no string, the constructor accepts only closed
  values, and the collector's constraints refuse anything else. The structural test drives
  1 200 random outcomes through the real pipeline and searches the wire for every argument,
  hash, ref and identifier it planted.
- An instance installed today sends nothing even if its operator enables telemetry, until
  a collector exists and its URL is configured or released.
- The collector needs no code, no function and no secret: a SQL file and a public key.
- The gateway has no dependency on the collector: a dead collector costs a queue of 1 000
  small objects and an absent badge.

Negative:

- **Coarse error classes.** `unspecified` covers every provider failure a plugin throws
  as a plain `Error`; `executor_refused` also covers the two plugins (Vercel, Upstash
  Redis) that fold a provider error into an `isError` result. A precise split needs typed
  errors in the plugin SDK.
- **The success rate counts agent mistakes** (a 404 on a wrong id is not a success). The
  90 % threshold is set with that in mind and may need tuning once real data exists.
- **No count of reporting instances.** Spec §9 lists it among the public aggregates; it
  cannot be computed without an instance identifier or an address, both forbidden by the
  same section. The view publishes report counts only. This is a spec gap to settle.
- **Statistics can be skewed.** Anyone holding the public key can insert. The limits and
  thresholds raise the cost; the validated badge is a community signal, not a guarantee.
- **The limit is global**, since nothing identifies a source: a flood from one party
  delays everyone's reports (they are retried, then dropped after the queue fills).
- **Day-granular arrival dates** make the 90-day window approximate by up to a day.
- **The proxy of D9 is one more thing to operate**, and it does not exist yet.

## Rejected alternatives

### An edge function in front of the table

A function could validate, rate limit per address and insert with the service role. It
would see the caller's address on every request, add code and a secret to a collector
meant to have neither, and make "anonymous, insert-only by RLS" (pivot ADR D5) a property
of code review rather than of the database. Constraints and a trigger do the validation
and the limit without any of that.

### Deriving `error_class` from the error's class name or code

`upstream_error` in the audit already uses the error's class name
(`upstreamErrorClassName`), bounded to an identifier. An identifier of 64 characters is
enough to carry a table name or a provider error code chosen by the plugin, and the audit
stays inside the instance while a report leaves it. Reports use fixed keywords only.

### Reporting each attempt of the retry ladder

Simpler hook (inside `forward`), but a refreshed token would count as a failure of the
plugin on every expiry, and one call would produce up to three reports.

### Reporting classification failures from the risk stage

A classifier that denies or throws is observable at the risk stage. It would mean a second
hook and reports for calls no plugin executed, where the tool name comes from the agent.
The brief fixes one hook at the upstream stage; the executor's refusal is the
classification signal available there.

### A random per-instance identifier, or a salted hash of the address, to count instances

Either is a stable instance identifier in the sense of §9, whatever the salt. Rejected;
the missing aggregate is reported as a spec gap instead.

### Sending the precise time of each report

Useful for trends, but a timestamp to the second can be joined with the gateway's own
access logs or the collector's. The collector stamps the arrival day.

### A second configuration key for the statistics URL, or for the public key

Two or three values to keep consistent, and each would need a default — the code is
allowed exactly one default URL. One URL carries the endpoint and the key; the statistics
endpoint is derived.

### Fetching the validation status even when telemetry is disabled

It would show the badge to every instance, at the price of a request to the collector
from instances whose operator declined any contact with it. "Disabled" means zero calls.

### Persisting the queue in the embedded store

Durable delivery for data that is statistical by nature, paid with writes on the store's
single writer at every call. Losing at most 1 000 reports on a restart is acceptable.

## References

- Spec: [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §9, §10, §4.3, §8.
- Handbook: [telemetry](../handbook/telemetry.md); collector:
  [`deploy/collector/README.md`](../../deploy/collector/README.md),
  [`deploy/collector/schema.sql`](../../deploy/collector/schema.sql).
- Related: [[docker-image-and-config-format]] (configuration sources and precedence),
  [[plugin-contract-and-credential-spec]] (what `execute` returns and throws).
