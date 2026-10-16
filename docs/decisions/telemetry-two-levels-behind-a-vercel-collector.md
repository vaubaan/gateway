---
title: Telemetry in two levels, received by a Vercel function in front of the dedicated Supabase
status: accepted
date: 2026-10-16
extends:
  - telemetry-collector-shape
  - pivot-v4-to-v5-on-prem-mission-tokens
---

# Telemetry in two levels, received by a Vercel function in front of the dedicated Supabase

> Amends [[telemetry-collector-shape]] (D1, D7, D8, D9) and widens the report
> of spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §9. The receiving side
> is specified in [website](../spec/website.md) §3. Accepted by the
> product owner on 2026-10-16.

## Context

The collector of [[telemetry-collector-shape]] was never published. Two
things held it back, and the product owner has now decided both:

- **Addresses.** A hosted Supabase project logs the caller's address for 1
  to 90 days and cannot be told not to. D9 required an address-stripping
  proxy "operated by the project", which did not exist.
- **Content.** Six fields per executed call answer "does this plugin work",
  and nothing else. The product owner wants, in the short term, "as much
  usage data as possible without compromising secrets or identifiers, no
  payload at all", and later to let each operator choose between plugin
  health alone and plugin health plus usage statistics.

The project's public site moves to Vercel at the same time
([[website-nextjs-on-vercel]]), so the proxy can be a function of that
project rather than a machine to operate. The dedicated Supabase project
stays the store "for now" (product owner, 2026-10-16); an aggregate-only
store (counters in Upstash) was considered and set aside for the time being,
because it loses the raw rows.

Vercel keeps the client address of each request (`proxy.clientIp`) in its
runtime logs for the plan's window (1 hour on Hobby, 1 day on Pro, 30 days
with Observability Plus) and in any Log Drain configured on the project.
This cannot be switched off.

## Decision

### D1 — Two levels, three settings

`telemetry.level`: `off` (default), `plugin-health`, `usage-stats` (which
includes plugin health). The legacy `telemetry.enabled: true` means
`usage-stats` in the short term, as decided; `false` means `off`. The first
interface may show only off / on; the levels exist on the wire from the
start (D3).

### D2 — What each level adds, and the rule every field obeys

Spec §9 lists the fields. The rule that admits a field: **it is a value of
a closed vocabulary, a shape bounded by the plugin's own declaration, or a
bucket.** No string ever comes from an argument, a result, an error, a
provider, a person or a configuration value the company chose. Hence:

- risks are sent **without their environment qualifier**
  (`supabase.row-write`, never `supabase[prod].row-write`): the label is the
  company's;
- counts in the instance profile are buckets (`0`, `1`, `2-5`, `6-20`,
  `21-100`, `>100`), never exact;
- the duration of a call is a bucket;
- no report carries a time; the collector stamps the arrival hour.

The **day identifier** of the instance profile is 128 random bits drawn at
the first profile of each UTC day, kept in memory, never written to the
store, never attached to a plugin-health or decision report. It is what
spec §9 calls the number of reporting instances, which
[[telemetry-collector-shape]] could not compute. A restart within a day
draws a new one: the count is an upper bound.

`createPluginReport` stays the only constructor of a plugin-health report;
`createDecisionReport` and `createInstanceProfile` join it in
`@vaubaan/telemetry`, with the same contract (frozen object or `null`), and
`serializeReports` rebuilds every report through its constructor.

### D3 — The wire: our endpoint, reports grouped by kind

`POST https://telemetry.vaubaan.com/v1/reports` (the existing default URL),
body `{ "plugin_health": [...], "decisions": [...], "instance_profiles": [...] }`
— each array optional, 1 to 50 reports in all, at most two profiles. The level
is not on the wire: an instance at `plugin-health` simply never sends the two
other kinds. One module of `@vaubaan/telemetry` (`wire.ts`) serializes on the
instance and parses on the collector. No key, no cookie, no referrer,
redirects refused, the constant user agent. The validation status is read at
`GET https://telemetry.vaubaan.com/v1/plugin_stats`, which accepts the query
the gateway's client already builds for the view (`select`, `tool=is.null`,
`plugin=in.(…)`) and nothing else. Batching, backoff and the three gates of
[[telemetry-collector-shape]] D4 and D6 are unchanged. The PostgREST insert
and the `apikey` query parameter of D7 are retired.

### D4 — The collector is a Vercel function that forwards to Supabase

A route handler of the site's Vercel project, served on the host
`telemetry.vaubaan.com`:

1. answers only on the host `telemetry.vaubaan.com` (404 elsewhere);
2. reads the body, at most 64 KiB, refuses anything but JSON, and rebuilds
   every report through `parseBatch` of `@vaubaan/telemetry` (the same code
   the instance runs): one report with an extra key or a refused value
   refuses the whole request (400);
3. inserts the rows into the dedicated Supabase project through its REST
   endpoint with the **publishable key**, as `anon`: the database's RLS
   (insert only) and `CHECK` constraints stay the final word, and the
   function holds no secret;
4. sends no forwarding header (`x-forwarded-for`, `x-real-ip`, `forwarded`,
   `cf-connecting-ip`) to Supabase, which therefore sees the address of
   Vercel's egress only;
5. never logs the request, its headers or its body; logs only a count and a
   result;
6. answers 202 when every table took its rows, 429 when the store limits
   ingestion, 503 when the store is down or refuses a row the shared
   constructors accepted (the schema out of step: retried later).

The statistics endpoint reads `plugin_stats` with the same key and is cached
for an hour at the edge.

### D5 — Address retention, stated rather than zero

The instance's address reaches Vercel and stays in its runtime logs for the
plan's window. On the collector's project: **no Log Drain, no Observability
Plus**, so the window is the plan's base one (1 day on Pro). The address is
never written to the store. The trust center states it in those words.
This replaces D9 of [[telemetry-collector-shape]] ("access log off").

### D6 — The schema grows by two tables, keeps one view

`deploy/collector/schema.sql`: `plugin_reports` gains `duration_bucket`;
`decision_reports`, `instance_profiles` and `instance_profile_plugins` (one
row per plugin of a profile, joined by the day identifier) are added, each
with the same insert-only RLS, column privileges and `CHECK` constraints;
`received_on` (day) becomes `received_hour`, truncated by the database.
`plugin_stats` is unchanged in meaning; `reporting_instances` publishes the
count of day identifiers per day; two views of the unexposed schema
`collector_private` aggregate usage for the maintainers. The ingestion
trigger counts rows across the four tables.

### D7 — Implemented in two steps

The collector (endpoint, store, shared constructors and wire) and the
`plugin-health` level with its duration bucket ship first. The instance's
`usage-stats` emitters (decision reports, the daily profile) and the
three-way setting of D1 follow in a second change; until then an enabled
instance sends `plugin_health` only.

## Consequences

Positive:

- The collector exists without a machine to operate, and the store never
  sees an instance's address.
- Validation stays in one place, the shared package, run on both ends; the
  database repeats it as a last line.
- Reporting instances can be counted, per day, without a stable
  identifier.
- The operator's later choice of level needs no new wire format.

Negative:

- **The address is kept up to a day by Vercel.** Weaker than D9's "never",
  and a property of a vendor's log retention, not of our code. Turning on a
  Log Drain on the project would silently lengthen it; the trust center and
  the collector's README must say so to maintainers.
- **More data leaves the instance.** Decision reports reveal how an
  organisation uses the gateway (which risks, how often refused). Nothing
  in them names the organisation, but an instance that is the only user of
  a rare plugin is recognisable in aggregates. This is why `usage-stats` is
  a separate level and why its aggregates are not published.
- **The arrival hour** can be joined with Vercel's logs within their window;
  it is coarser than the minute but finer than the day of D8.
- **A function in front of the table** is what [[telemetry-collector-shape]]
  rejected. The reasons are answered (no secret, RLS still final, address
  stripped) except one: the function sees the address. It does not keep it.

## Rejected alternatives

### Counters only, in Upstash Redis

Stores no row at all, the strongest privacy story. Set aside by the product
owner on 2026-10-16: the raw rows are wanted while the user base is small,
to cut the data in ways not yet known.

### Neon Postgres through the Vercel marketplace

One vendor less, the same SQL. It needs a connection string in the function
(a secret), and the Supabase project was already chosen by the pivot ADR.

### A stable random instance identifier

Would give trends per instance (upgrades, churn). It is the "stable instance
identifier" spec §9 forbids; the day identifier answers the count without
it.

### Keeping the environment qualifier on risks

`[prod]` versus `[staging]` usage would be informative, but the label is a
string chosen by the company and may name it.

### A Cloudflare Worker as the proxy

Lets the logs be switched off entirely. Rejected with the hosting choice of
[[website-nextjs-on-vercel]]: one vendor and one stack for the site and its
collector.

## References

- Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §9, §4.3, §10;
  [website](../spec/website.md) §3.
- Amends: [[telemetry-collector-shape]]. Related: [[website-nextjs-on-vercel]].
- Vercel: [log drains schema](https://vercel.com/docs/drains/reference/logs)
  (`proxy.clientIp`), [runtime logs retention](https://vercel.com/docs/logs/runtime).
