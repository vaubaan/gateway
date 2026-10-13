-- Vaubaan Gateway — community telemetry collector (spec §9).
--
-- A dedicated Supabase project with no other role. Apply this file once, in
-- the SQL editor or with `psql`, as the project's `postgres` role. It is
-- idempotent: it can be applied again after an edit (thresholds, limits,
-- constraints).
--
-- What it creates:
--
--   public.plugin_reports                 the reports; the `anon` role may INSERT
--                                         the six report columns and nothing else
--                                         (no SELECT, no UPDATE, no DELETE)
--   public.plugin_validation_thresholds() the published thresholds, in one place
--   public.plugin_stats                   the public aggregation, readable by `anon`
--   collector_private.*                   the ingestion limit (not exposed by the API)
--
-- What it deliberately does NOT store: any identifier of the reporting
-- instance, any network address, the time of a report (only its UTC day).
-- The six report columns are constrained to closed vocabularies and narrow
-- shapes, so free text cannot be stored even by a client that tries.
--
-- The column list, the outcomes, the error classes and the shapes below are
-- the ones of `packages/telemetry/src/report.ts`; a test of the repository
-- compares the two.

begin;

-- ---------------------------------------------------------------------------
-- Reports
-- ---------------------------------------------------------------------------

create table if not exists public.plugin_reports (
  id bigint generated always as identity primary key,
  -- The UTC day the report arrived. No time of day: a precise timestamp would
  -- let reports be correlated with the gateway's access logs.
  received_on date not null default ((now() at time zone 'utc')::date),
  plugin text not null,
  plugin_version text not null,
  gateway_version text not null,
  tool text not null,
  outcome text not null,
  error_class text
);

-- The constraints are dropped and added again on every run, so that applying
-- an edited file changes them (a new outcome, a new error class).
alter table public.plugin_reports
  drop constraint if exists plugin_reports_plugin_shape,
  drop constraint if exists plugin_reports_plugin_version_shape,
  drop constraint if exists plugin_reports_gateway_version_shape,
  drop constraint if exists plugin_reports_tool_shape,
  drop constraint if exists plugin_reports_outcome_known,
  drop constraint if exists plugin_reports_error_class_matches_outcome;

alter table public.plugin_reports
  add constraint plugin_reports_plugin_shape
    check (plugin ~ '^[a-z][a-z0-9-]{0,62}$'),
  add constraint plugin_reports_plugin_version_shape
    check (plugin_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$'),
  add constraint plugin_reports_gateway_version_shape
    check (
      gateway_version = 'dev'
      or gateway_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$'
    ),
  add constraint plugin_reports_tool_shape
    check (tool ~ '^[a-z][a-z0-9_]{0,95}$'),
  add constraint plugin_reports_outcome_known
    check (outcome in ('success', 'upstream-error', 'classification-error', 'execution-error')),
  -- `error_class` is null exactly for a success, and otherwise one of the
  -- classes its outcome allows. Never a message.
  add constraint plugin_reports_error_class_matches_outcome
    check (
      (outcome = 'success' and error_class is null)
      or (
        outcome = 'upstream-error'
        and error_class is not null
        and (
          error_class in ('network', 'timeout', 'credential_rejected', 'unspecified')
          or error_class ~ '^http_[1-5][0-9]{2}$'
        )
      )
      or (
        outcome = 'classification-error'
        and error_class is not null
        and error_class in ('executor_refused')
      )
      or (
        outcome = 'execution-error'
        and error_class is not null
        and error_class in ('type_error', 'range_error', 'reference_error', 'syntax_error', 'non_error_throw')
      )
    );

create index if not exists plugin_reports_aggregation
  on public.plugin_reports (plugin, plugin_version, tool, received_on);

-- Insert-only and anonymous. RLS is on with a single policy: `anon` may
-- insert. There is no SELECT, UPDATE or DELETE policy, and the privileges
-- say the same thing a second time: `anon` holds INSERT on the six report
-- columns only (it cannot choose `id` or `received_on`).
alter table public.plugin_reports enable row level security;

revoke all on table public.plugin_reports from public, anon, authenticated;
grant insert (plugin, plugin_version, gateway_version, tool, outcome, error_class)
  on table public.plugin_reports to anon;

drop policy if exists plugin_reports_anon_insert on public.plugin_reports;
create policy plugin_reports_anon_insert
  on public.plugin_reports
  for insert
  to anon
  with check (true);

-- ---------------------------------------------------------------------------
-- Ingestion limit
-- ---------------------------------------------------------------------------
-- The collector keeps no address, so it cannot limit per source. It limits
-- the whole table instead: at most `max_rows_per_statement` rows per request
-- and `max_rows_per_minute` rows per minute, all sources together. Beyond
-- that the insert is refused with HTTP 429 (PostgREST maps SQLSTATE `PT429`
-- to that status); the gateway's client retries later with backoff.

create schema if not exists collector_private;
revoke all on schema collector_private from public, anon, authenticated;

create table if not exists collector_private.ingest_minutes (
  minute timestamptz primary key,
  row_count integer not null
);

create or replace function collector_private.ingest_limits()
returns table (max_rows_per_statement integer, max_rows_per_minute integer)
language sql
immutable
set search_path = ''
as $$
  select 200, 6000
$$;

create or replace function collector_private.enforce_ingest_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  incoming integer;
  total integer;
  limits record;
begin
  select * into limits from collector_private.ingest_limits();
  select count(*) into incoming from inserted;

  if incoming > limits.max_rows_per_statement then
    raise sqlstate 'PT429' using
      message = 'too many reports in one request',
      hint = 'send smaller batches';
  end if;

  insert into collector_private.ingest_minutes as m (minute, row_count)
  values (date_trunc('minute', now()), incoming)
  on conflict (minute) do update set row_count = m.row_count + excluded.row_count
  returning m.row_count into total;

  if total > limits.max_rows_per_minute then
    raise sqlstate 'PT429' using
      message = 'the collector is receiving too many reports',
      hint = 'retry later';
  end if;

  delete from collector_private.ingest_minutes where minute < now() - interval '1 hour';
  return null;
end;
$$;

revoke all on function collector_private.enforce_ingest_limit() from public, anon, authenticated;

drop trigger if exists plugin_reports_ingest_limit on public.plugin_reports;
create trigger plugin_reports_ingest_limit
  after insert on public.plugin_reports
  referencing new table as inserted
  for each statement
  execute function collector_private.enforce_ingest_limit();

-- ---------------------------------------------------------------------------
-- Published thresholds
-- ---------------------------------------------------------------------------
-- A plugin version is deemed validated when, over the last `window_days`
-- days, it has at least `min_reports` reports and at least
-- `min_success_rate` of them are successes. The same numbers are published
-- in `deploy/collector/README.md`; a test of the repository compares them.

create or replace function public.plugin_validation_thresholds()
returns table (min_reports integer, min_success_rate numeric, window_days integer)
language sql
immutable
set search_path = ''
as $$
  select 200, 0.90::numeric, 90
$$;

grant execute on function public.plugin_validation_thresholds() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public aggregation
-- ---------------------------------------------------------------------------
-- One row per (plugin, plugin_version, tool), and one row per
-- (plugin, plugin_version) whose `tool` is null: the status of the plugin
-- version as a whole, which is what a gateway shows on a connection.
--
-- The view runs with its owner's rights on purpose (`security_invoker =
-- false`): `anon` cannot read `plugin_reports`, only these aggregates.

create or replace view public.plugin_stats
with (security_invoker = false)
as
select
  r.plugin,
  r.plugin_version,
  r.tool,
  count(*)::bigint as reports,
  (count(*) filter (where r.outcome = 'success'))::bigint as successes,
  round((count(*) filter (where r.outcome = 'success'))::numeric / count(*), 4) as success_rate,
  (
    count(*) >= (select t.min_reports from public.plugin_validation_thresholds() t)
    and (count(*) filter (where r.outcome = 'success'))::numeric / count(*)
      >= (select t.min_success_rate from public.plugin_validation_thresholds() t)
  ) as validated
from public.plugin_reports r
where r.received_on
  >= (now() at time zone 'utc')::date
     - (select t.window_days from public.plugin_validation_thresholds() t)
group by grouping sets ((r.plugin, r.plugin_version, r.tool), (r.plugin, r.plugin_version));

revoke all on table public.plugin_stats from public, anon, authenticated;
grant select on table public.plugin_stats to anon, authenticated;

commit;
