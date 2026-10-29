---
title: Community telemetry collector
status: current
date: 2026-10-13
last_synced: 2026-10-16
tracks:
  - deploy/collector/schema.sql
  - packages/telemetry/src/report.ts
  - packages/telemetry/src/usage.ts
  - packages/telemetry/src/wire.ts
  - packages/telemetry/src/client.ts
  - apps/website/src/collector/
---

# Community telemetry collector

The collector receives the opt-in telemetry reports of Vaubaan Gateway
instances (spec [vaubaan-gateway](../../docs/spec/vaubaan-gateway.md) §9) and
publishes, per plugin version, whether its users found it to work. Two parts:

- **The endpoint**, `https://telemetry.vaubaan.com`: route handlers of the
  project's site (`apps/website/src/collector/`), deployed on Vercel. It
  checks every report with the code the instances run (`@vaubaan/telemetry`)
  and forwards the rows to the store. It holds no secret.
- **The store**: a dedicated Supabase project with no other role. Tables that
  anyone may insert into and nobody may read, and public views of aggregates.
  This directory holds its whole definition, `schema.sql`.

Decisions and rationale: ADRs
[telemetry-two-levels-behind-a-vercel-collector](../../docs/decisions/telemetry-two-levels-behind-a-vercel-collector.md)
and
[telemetry-two-levels-behind-a-vercel-collector](../../docs/decisions/telemetry-two-levels-behind-a-vercel-collector.md);
the receiving side is specified in [website](../../docs/spec/website.md) §3;
the gateway side: handbook [telemetry](../../docs/handbook/telemetry.md).

You do not need any of this to run a gateway. Telemetry is off by default, and
**until the collector's URL is published as the default, instances send
nothing**: the gateway's client refuses to send to the placeholder.

## What an instance sends

`POST https://telemetry.vaubaan.com/v1/reports`, `Content-Type:
application/json`, at most 64 KiB, with reports grouped by kind — at most 50
per request, of which at most two instance profiles:

```json
{
  "plugin_health": [
    {
      "plugin": "github",
      "plugin_version": "3.0.0",
      "gateway_version": "2.0.0",
      "tool": "github__get_file_contents",
      "outcome": "upstream-error",
      "error_class": "http_404",
      "duration_bucket": "lt_1s"
    }
  ],
  "decisions": [
    {
      "plugin": "github",
      "tool": "github__create_pull_request",
      "gateway_version": "2.0.0",
      "decision": "allowed",
      "risks": ["github.create-pr"],
      "gate": "none"
    }
  ],
  "instance_profiles": [
    {
      "day_id": "3f0c9a7e5b1d4c2a8e6f0b9d7c5a3e1f",
      "gateway_version": "2.0.0",
      "deployment": "docker",
      "runtime": "node-22",
      "arch": "x64",
      "sign_in_kinds": ["oidc"],
      "users": "6-20",
      "active_missions": "2-5",
      "calls": "101-1000",
      "plugins": [{ "plugin": "github", "plugin_version": "3.0.0", "accounts": "1" }]
    }
  ]
}
```

**Level `plugin-health`** sends `plugin_health` only: one report per call a
plugin executed. `outcome` is `success`, `upstream-error`,
`classification-error` or `execution-error`; `error_class` is null for a
success and otherwise a fixed keyword (`network`, `timeout`,
`credential_rejected`, `unspecified`, `executor_refused`, `type_error`,
`range_error`, `reference_error`, `syntax_error`, `non_error_throw`) or
`http_<status>`. Never a message. `duration_bucket` is `lt_100ms`, `lt_1s`,
`lt_10s` or `gte_10s`.

**Level `usage-stats`** adds:

- `decisions`: one per call the gateway decided. `decision` is `allowed` or
  the refusal code of the execution door; `risks` are the account-scoped
  RiskIds of the plugin the call touched — never with the environment label
  the company chose (`github.git-push`, never `github[prod].git-push`); `gate`
  is `approval` or `none`; `tool` is null when the agent named a tool the
  plugin does not declare.
- `instance_profiles`: one per instance and UTC day. Counts are buckets (`0`,
  `1`, `2-5`, `6-20`, `21-100`, `101-1000`, `>1000`), never exact;
  `deployment` is `docker`, `railway`, `fly` or `other`. `day_id` is
  128 random bits the instance draws again every UTC day and keeps in memory
  only: it counts the instances of a day, it cannot follow one from a day to
  the next, and it is never attached to a plugin-health or decision report.

Never sent, and impossible to store here: the arguments of a call or a hash
of them, payloads, provider answers or error text, resource references,
environment labels, mission, user or connection identifiers, emails, account
names, host names, URLs, a stable identifier of the instance, a network
address. Every column is constrained to a closed vocabulary, a bounded shape
or a bucket (`CHECK` constraints in `schema.sql`), so a client that tried to
send free text would be refused twice: by the endpoint and by the database.

No report carries a time. The database stamps the **UTC hour** a row arrived
(`received_hour`, truncated); it records no minute.

### Answers

| Status | Meaning                                                     | The instance     |
| ------ | ----------------------------------------------------------- | ---------------- |
| 202    | stored                                                      | drops the batch  |
| 400    | a report or the batch does not fit; nothing was stored      | drops the batch  |
| 413    | body larger than 64 KiB                                     | drops the batch  |
| 415    | not `application/json`                                      | drops the batch  |
| 429    | the store's ingestion limit                                 | retries, backoff |
| 503    | the store is unreachable or refused a row the endpoint took | retries, backoff |

A 400 is all-or-nothing: one report with a key its shape does not define, or
a value its constructor refuses, refuses the whole request.

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

## The public aggregates

`GET https://telemetry.vaubaan.com/v1/plugin_stats` serves the view
`public.plugin_stats`, cached for an hour at the edge. It accepts the query a
gateway builds (`select`, `tool=is.null`, `plugin=in.(…)`) and nothing else:

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
and shows the status of the version it runs on the page of each account and
in Reference. It does so only while its own telemetry is enabled, caches the
answer for six hours and shows nothing when the collector does not answer.

`public.reporting_instances` gives, per UTC day, the number of distinct
`day_id`s that sent a profile. Usage statistics stay in two views of the
unexposed schema `collector_private` (`decisions_by_day`, `risks_by_day`),
readable by the maintainers only.

## Setting the collector up

1. Create a Supabase project used for nothing else. No authentication
   provider, no storage bucket, no edge function, no log drain. Keep `public`
   as the only schema exposed by the API.
2. Apply `schema.sql` as the project's `postgres` role: in the SQL editor,
   with `psql "$COLLECTOR_DATABASE_URL" -v ON_ERROR_STOP=1 -f
deploy/collector/schema.sql` (the connection string in your shell, never in
   a file of this repository), or as a migration through a Vaubaan mission on
   that project. The file is idempotent and migrates the earlier one-table
   schema.
3. Take the project's **publishable** key (the anonymous, public one — never
   the secret key, which the endpoint refuses at startup). It is public by
   design: row level security and column privileges are the control.
4. On the site's Vercel project, set `COLLECTOR_HOST=telemetry.vaubaan.com`,
   `COLLECTOR_SUPABASE_URL=https://<project-ref>.supabase.co` and
   `COLLECTOR_SUPABASE_PUBLISHABLE_KEY`, and attach the domain
   `telemetry.vaubaan.com`. On any other host the routes answer 404.
5. Check it from a shell:

   ```bash
   # stored: 202
   curl -i https://telemetry.vaubaan.com/v1/reports -H 'Content-Type: application/json' \
     -d '{"plugin_health":[{"plugin":"collector-selftest","plugin_version":"0.0.1","gateway_version":"dev","tool":"collector_selftest__ping","outcome":"success","error_class":null,"duration_bucket":"lt_100ms"}]}'
   # refused whole: 400
   curl -i https://telemetry.vaubaan.com/v1/reports -H 'Content-Type: application/json' \
     -d '{"plugin_health":[{"plugin":"x","instance":"acme"}]}'
   # aggregates: 200
   curl -s 'https://telemetry.vaubaan.com/v1/plugin_stats?tool=is.null'
   ```

   Then delete the test rows (`delete from public.plugin_reports where plugin
= 'collector-selftest'`).

Publishing the collector to every instance is a change of the single default
URL in the gateway's code (`apps/gateway/src/server/config/telemetry-default.ts`,
already `https://telemetry.vaubaan.com/v1/reports`) and of the placeholder
gate, in a release.

## What is refused, and how

| Attempt                                                 | Answer                                          |
| ------------------------------------------------------- | ----------------------------------------------- |
| read, update or delete a table                          | permission denied (no privilege, no RLS policy) |
| a value outside a vocabulary or a shape                 | 400 at the endpoint; check constraint below it  |
| an extra key, `id` or `received_hour` supplied          | 400 at the endpoint; permission denied below it |
| more than 200 reports in one request                    | 429                                             |
| more than 6 000 rows in one minute, all tables together | 429                                             |

The two limits live in `collector_private.ingest_limits()`. The collector
keeps no address, so it cannot limit per source; it limits all sources
together. A gateway that receives 429 keeps its batch and retries with
exponential backoff (30 seconds doubling up to one hour).

Anyone can send. A determined party can therefore skew the statistics of a
plugin; the thresholds and the global limit raise the cost, they do not
remove it. The validated status is a community signal, not a security
guarantee, and the gateway's interface presents it as such.

## Addresses: what is seen, and how long

- **The store never sees an instance's address.** The endpoint calls Supabase
  itself and forwards no header of the instance's request: Supabase's API
  logs hold the address of Vercel's egress only. Never add a column, a trigger
  or a function that reads request headers (`request.headers`) to the
  database.
- **Vercel sees it.** Vercel records the client address of each request
  (`proxy.clientIp`) in the project's runtime logs and in any Log Drain; this
  cannot be turned off. On the site's project there is **no Log Drain and no
  Observability Plus**, so the address stays in Vercel's logs for the plan's
  base window (one day on Pro, one hour on Hobby) and nowhere else. Adding a
  drain or Observability Plus to the project lengthens it: don't.
- **The endpoint never logs a request.** Its only log line is a count and a
  result (`{"collector":{"event":"batch","reports":3,"result":"stored"}}`).

## Operations

- **Retention of reports.** The views read the last 90 days; older rows are
  dead weight. Delete them on a schedule (`delete from public.plugin_reports
where received_hour < now() - interval '180 days'`, and the same on the
  three other tables), by hand or with the project's scheduler.
- **Database advisors.** Supabase's linter flags `plugin_stats` and
  `reporting_instances` as views that run with their owner's rights. That is
  the design: the views are the only way `anon` reaches the aggregates, and
  they expose no row.
- **Changing a report shape.** The fields are fixed by spec §9. A new value
  (an outcome, an error class, a bucket) is added in `packages/telemetry/src/`
  and in the constraints of `schema.sql` in the same change; the
  repository's tests fail until both agree. Apply the new file to the store
  and deploy the site **before** releasing a gateway that sends the new
  value, or its batches are refused.
