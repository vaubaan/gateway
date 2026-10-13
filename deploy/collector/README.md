---
title: Community telemetry collector
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - deploy/collector/schema.sql
  - packages/telemetry/src/report.ts
  - packages/telemetry/src/client.ts
---

# Community telemetry collector

The collector receives the opt-in telemetry reports of Vaubaan Gateway
instances (spec §9) and publishes, per plugin version, whether its users
found it to work. It is a **dedicated Supabase project with no other role**,
owned by the open source project: one table that anyone may insert into and
nobody may read, and one public view of aggregates. Decisions and rationale:
ADR [telemetry-collector-shape](../../docs/decisions/telemetry-collector-shape.md);
the gateway side: handbook [telemetry](../../docs/handbook/telemetry.md).

This directory is the whole collector: `schema.sql` and this page. Nothing
here creates a cloud resource; a maintainer creates the project by hand and
applies the file. **Until a collector exists and its URL is published,
instances send nothing**: the default collector URL in the gateway's code is
a placeholder and the gateway's client refuses to send to it.

You do not need any of this to run a gateway. Telemetry is off by default and
the collector is the only SaaS dependency of the product, and an optional one.

## What an instance sends

A JSON array of reports, at most 50 per request. One report:

```json
{
  "plugin": "github",
  "plugin_version": "1.0.0",
  "gateway_version": "2.0.0",
  "tool": "github__get_file_contents",
  "outcome": "upstream-error",
  "error_class": "http_404"
}
```

Six fields and nothing else. `outcome` is `success`, `upstream-error`,
`classification-error` or `execution-error`; `error_class` is null for a
success and otherwise a fixed keyword (`network`, `timeout`,
`credential_rejected`, `unspecified`, `executor_refused`, `type_error`,
`range_error`, `reference_error`, `syntax_error`, `non_error_throw`) or
`http_<status>`. Never a message.

Never sent, and impossible to store here: the arguments of a call or a hash
of them, resource references, mission identifiers, user identifiers, any
identifier of the instance, a network address. Every column is constrained to
a closed vocabulary or a narrow shape (`CHECK` constraints in `schema.sql`),
so a client that tried to send free text would be refused by the database.

The table also records the **UTC day** a report arrived (`received_on`), set
by the database. It records no time of day.

## Published thresholds

A plugin version is **deemed validated** when, over the last **90 days**:

| Threshold            | Value |
| -------------------- | ----- |
| Minimum reports      | 200   |
| Minimum success rate | 90 %  |

Both numbers and the window live in one SQL function,
`public.plugin_validation_thresholds()`. To change them, edit the function in
`schema.sql` and this table together (a test of the repository compares the
two), then apply the file again.

Every outcome that is not `success` counts against the rate, including a
provider answering 404 to a call the agent got wrong: the rate measures calls
that worked, not the plugin's code alone. The threshold is set with that in
mind.

The spec also mentions the number of reporting instances. The collector
cannot count instances: it keeps no instance identifier and no address, by
design. `reports` is the only volume it publishes.

## The public aggregation: `plugin_stats`

Readable by anyone holding the project's publishable key:

| Column           | Meaning                                                             |
| ---------------- | ------------------------------------------------------------------- |
| `plugin`         | plugin identifier                                                   |
| `plugin_version` | plugin version                                                      |
| `tool`           | tool name, or **null** for the row of the plugin version as a whole |
| `reports`        | reports in the window                                               |
| `successes`      | of which successes                                                  |
| `success_rate`   | `successes / reports`, 0 to 1, four decimals                        |
| `validated`      | both thresholds are met for this row                                |

A gateway reads the rows whose `tool` is null for the plugins it registers
and shows the status of the version it runs on each connection. It does so
only while its own telemetry is enabled, caches the answer for six hours and
shows nothing when the collector does not answer.

## Setting the collector up

1. Create a Supabase project used for nothing else. No authentication
   provider, no storage bucket, no edge function, no log drain.
2. Apply `schema.sql` as the project's `postgres` role (SQL editor, or
   `psql "$COLLECTOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/collector/schema.sql`
   with the connection string in your shell, never in a file of this
   repository). The file is idempotent.
3. In the project's API settings, keep `public` as the only exposed schema
   (`collector_private` must not be exposed).
4. Take the project's **publishable** key (the anonymous, public one — never
   the secret key). It is public by design: row level security and column
   privileges are the control, not the key.
5. The collector URL an instance is given is the REST endpoint of the table
   with the key as a query parameter:

   ```
   https://<project-ref>.supabase.co/rest/v1/plugin_reports?apikey=<publishable key>
   ```

   The gateway moves the key from the URL into the `apikey` and
   `Authorization` headers before sending, and derives the statistics
   endpoint by replacing the last path segment with `plugin_stats`.

6. Check it from a shell, with the two values in variables:

   ```bash
   # insert: 201 with an empty body
   curl -i "$COLLECTOR/plugin_reports" -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
     -H 'Content-Type: application/json' -H 'Prefer: return=minimal' \
     -d '[{"plugin":"github","plugin_version":"1.0.0","gateway_version":"dev","tool":"github__get_file_contents","outcome":"success","error_class":null}]'
   # read back: refused (401 or 403, "permission denied")
   curl -i "$COLLECTOR/plugin_reports" -H "apikey: $KEY"
   # aggregates: 200
   curl -s "$COLLECTOR/plugin_stats?tool=is.null" -H "apikey: $KEY"
   ```

   Delete the test row afterwards from the SQL editor.

Publishing the collector to every instance is a change of the single default
URL in the gateway's code (`apps/gateway/src/server/config/telemetry-default.ts`)
in a release. Until then an operator who wants to contribute sets
`telemetry.collector_url` (or `VAUBAAN_TELEMETRY_COLLECTOR_URL`) to the URL of
step 5.

## What is refused, and how

| Attempt                                         | Answer                                          |
| ----------------------------------------------- | ----------------------------------------------- |
| read, update or delete `plugin_reports`         | permission denied (no privilege, no RLS policy) |
| a value outside a vocabulary or a shape         | 400, check constraint                           |
| an extra column, `id` or `received_on` supplied | 400 / permission denied                         |
| more than 200 reports in one request            | 429                                             |
| more than 6 000 reports in one minute, in total | 429                                             |

The two limits live in `collector_private.ingest_limits()`. The collector
keeps no address, so it cannot limit per source; it limits the whole table.
A gateway that receives 429 keeps its batch and retries with exponential
backoff (30 seconds doubling up to one hour).

Anyone can insert. A determined party can therefore skew the statistics of a
plugin; the thresholds and the global limit raise the cost, they do not
remove it. The validated status is a community signal, not a security
guarantee, and the gateway's interface presents it as such.

## No address retention in the collector's logs

The table stores no address. The **platform's request logs** are a separate
matter and must be dealt with explicitly, because a hosted Supabase project
records, for every API request, the client address (the `cf-connecting-ip`
and `x-real-ip` request headers) and the user agent in its API gateway logs.
Those logs are kept for a period that depends on the plan (1 day on Free,
7 days on Pro, 28 days on Team, 90 days on Enterprise). We found no project
setting that turns this recording off on the hosted platform.

To hold the promise of spec §9 ("never a network address"), the collector
must be run in one of these ways, in order of preference:

1. **An address-stripping proxy in front of the project** (the intended
   setup: the host name of the default collector URL points at it). A small
   reverse proxy operated by the open source project receives the requests
   and forwards them to the Supabase REST endpoint:
   - its own access log is **off** (not merely rotated);
   - it does not forward the client address: `X-Forwarded-For`, `X-Real-IP`,
     `Forwarded` and `CF-Connecting-IP` are removed or overwritten with the
     proxy's own address;
   - it forwards only `POST …/plugin_reports` and `GET …/plugin_stats`.

   Supabase's logs then contain the proxy's address for every request, which
   identifies nobody. With this setup the publishable key can also be added
   by the proxy, and the collector URL given to instances carries no key.

2. **A self-hosted Supabase stack.** API logs flow from the gateway
   container through Vector to the analytics service. Either do not enable
   the analytics/logging stack at all, or drop the address fields in the
   Vector pipeline before they are stored, and disable the access log of
   whatever terminates TLS in front of it.

3. **The hosted project called directly**, as a stopgap only: keep the
   project on the plan with the shortest log retention, configure **no log
   drain**, export no logs, and say publicly that addresses are visible in
   platform logs for that retention period. This does not satisfy "no
   retention"; it bounds it. Do not publish the collector as the default
   while it runs this way.

Whatever the setup, never join request logs with reports, and never add a
column, a trigger or a function that reads request headers
(`request.headers`) into the database.

## Operations

- **Retention of reports.** The view only reads the last 90 days; older rows
  are dead weight. Delete them on a schedule
  (`delete from public.plugin_reports where received_on < current_date - 180`),
  by hand or with the project's scheduler.
- **Database advisors.** Supabase's linter flags `plugin_stats` as a view
  that runs with its owner's rights. That is the design: the view is the
  only way `anon` reaches the aggregates, and it exposes no row.
- **Changing the report shape.** The six fields are frozen by spec §9. A new
  outcome or error class is added in `packages/telemetry/src/report.ts` and
  in the constraints of `schema.sql` in the same change; the repository's
  tests fail until both agree. Apply the new file to the collector **before**
  releasing a gateway that sends the new value, or its batches are refused.
