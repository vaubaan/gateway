-- Vaubaan Gateway — community telemetry collector (spec §9; website spec §3).
--
-- A dedicated Supabase project with no other role. Apply this file in the
-- SQL editor or with `psql`, as the project's `postgres` role. It is
-- idempotent: it can be applied again after an edit (thresholds, limits,
-- constraints). Rows are only ever inserted by the collector function of the
-- project's site (`apps/website`), which calls the REST API with the
-- project's publishable key, as `anon`.
--
-- What it creates:
--
--   public.plugin_reports                 level plugin-health: one row per executed call
--   public.decision_reports               level usage-stats: one row per decided call
--   public.instance_profiles              level usage-stats: one row per instance and UTC day
--   public.instance_profile_plugins       the plugins of a profile, one row each
--   public.plugin_validation_thresholds() the published thresholds, in one place
--   public.plugin_stats                   public aggregation of plugin health, readable by `anon`
--   public.reporting_instances            public count of reporting instances per UTC day
--   collector_private.*                   the ingestion limit and the maintainers' views
--                                         (not exposed by the API)
--
-- On every table `anon` may INSERT the report columns and nothing else: no
-- SELECT, no UPDATE, no DELETE. Every report column is constrained to the
-- closed vocabularies and narrow shapes of `@vaubaan/telemetry`, so free text
-- cannot be stored even by a client that tries.
--
-- What it deliberately does NOT store: any network address, any stable
-- identifier of an instance (the day identifier of a profile is drawn again
-- every UTC day), the time of a report (only the UTC hour it arrived, set by
-- the database).
--
-- The column lists, vocabularies and shapes below are the ones of
-- `packages/telemetry/src/`; a test of the repository compares the two.

begin;

-- ---------------------------------------------------------------------------
-- Level plugin-health
-- ---------------------------------------------------------------------------

create table if not exists public.plugin_reports (
  id bigint generated always as identity primary key,
  -- The UTC hour the report arrived, truncated by the database. No minute: a
  -- precise time could be joined with request logs.
  received_hour timestamptz not null default date_trunc('hour', now()),
  plugin text not null,
  plugin_version text not null,
  gateway_version text not null,
  tool text not null,
  outcome text not null,
  error_class text,
  duration_bucket text not null
);

-- A collector created by the earlier version of this file stored the day;
-- its view reads that column, so it goes first and is recreated below.
drop view if exists public.plugin_stats;
alter table public.plugin_reports
  add column if not exists received_hour timestamptz not null default date_trunc('hour', now()),
  add column if not exists duration_bucket text not null default 'lt_1s';
alter table public.plugin_reports alter column duration_bucket drop default;
alter table public.plugin_reports drop column if exists received_on;

-- The constraints are dropped and added again on every run, so that applying
-- an edited file changes them (a new outcome, a new error class).
alter table public.plugin_reports
  drop constraint if exists plugin_reports_received_hour_truncated,
  drop constraint if exists plugin_reports_plugin_shape,
  drop constraint if exists plugin_reports_plugin_version_shape,
  drop constraint if exists plugin_reports_gateway_version_shape,
  drop constraint if exists plugin_reports_tool_shape,
  drop constraint if exists plugin_reports_outcome_known,
  drop constraint if exists plugin_reports_error_class_matches_outcome,
  drop constraint if exists plugin_reports_duration_bucket_known;

alter table public.plugin_reports
  add constraint plugin_reports_received_hour_truncated
    check (received_hour = date_trunc('hour', received_hour)),
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
    ),
  add constraint plugin_reports_duration_bucket_known
    check (duration_bucket in ('lt_100ms', 'lt_1s', 'lt_10s', 'gte_10s'));

drop index if exists public.plugin_reports_aggregation;
create index if not exists plugin_reports_by_version
  on public.plugin_reports (plugin, plugin_version, tool, received_hour);

-- ---------------------------------------------------------------------------
-- Level usage-stats: decisions
-- ---------------------------------------------------------------------------

create table if not exists public.decision_reports (
  id bigint generated always as identity primary key,
  received_hour timestamptz not null default date_trunc('hour', now()),
  plugin text not null,
  -- Null when the agent named a tool the plugin does not declare.
  tool text,
  gateway_version text not null,
  decision text not null,
  -- Account-scoped RiskIds of the plugin: never an environment label.
  risks text[] not null,
  gate text not null
);

alter table public.decision_reports
  drop constraint if exists decision_reports_received_hour_truncated,
  drop constraint if exists decision_reports_plugin_shape,
  drop constraint if exists decision_reports_tool_shape,
  drop constraint if exists decision_reports_gateway_version_shape,
  drop constraint if exists decision_reports_decision_known,
  drop constraint if exists decision_reports_risks_shape,
  drop constraint if exists decision_reports_gate_known;

alter table public.decision_reports
  add constraint decision_reports_received_hour_truncated
    check (received_hour = date_trunc('hour', received_hour)),
  add constraint decision_reports_plugin_shape
    check (plugin ~ '^[a-z][a-z0-9-]{0,62}$'),
  add constraint decision_reports_tool_shape
    check (tool is null or tool ~ '^[a-z][a-z0-9_]{0,95}$'),
  add constraint decision_reports_gateway_version_shape
    check (
      gateway_version = 'dev'
      or gateway_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$'
    ),
  add constraint decision_reports_decision_known
    check (decision in ('allowed', 'risk-not-accepted', 'budget-exhausted', 'approval-required', 'resource-not-in-mission', 'rate-limited', 'connection-unavailable', 'connection-revoked', 'mission-inactive')),
  -- At most 32 ids, each `<plugin>.<name>` with no `[env]`. The plugin is
  -- already constrained to `[a-z0-9-]`, so it is safe inside the pattern.
  add constraint decision_reports_risks_shape
    check (
      cardinality(risks) <= 32
      and (
        cardinality(risks) = 0
        or array_to_string(risks, ',') ~ (
          '^' || plugin || '(\.[a-z][a-z0-9-]+)+(,' || plugin || '(\.[a-z][a-z0-9-]+)+)*$'
        )
      )
    ),
  add constraint decision_reports_gate_known
    check (gate in ('approval', 'none'));

create index if not exists decision_reports_by_plugin
  on public.decision_reports (plugin, received_hour);

-- ---------------------------------------------------------------------------
-- Level usage-stats: instance profiles
-- ---------------------------------------------------------------------------

create table if not exists public.instance_profiles (
  id bigint generated always as identity primary key,
  received_hour timestamptz not null default date_trunc('hour', now()),
  -- 128 random bits drawn again by the instance every UTC day. Counts the
  -- instances of a day; cannot follow one from a day to the next.
  day_id text not null,
  gateway_version text not null,
  deployment text not null,
  runtime text not null,
  arch text not null,
  sign_in_kinds text[] not null,
  users text not null,
  active_missions text not null,
  calls text not null
);

alter table public.instance_profiles
  drop constraint if exists instance_profiles_received_hour_truncated,
  drop constraint if exists instance_profiles_day_id_shape,
  drop constraint if exists instance_profiles_gateway_version_shape,
  drop constraint if exists instance_profiles_deployment_known,
  drop constraint if exists instance_profiles_runtime_shape,
  drop constraint if exists instance_profiles_arch_known,
  drop constraint if exists instance_profiles_sign_in_kinds_known,
  drop constraint if exists instance_profiles_counts_bucketed;

alter table public.instance_profiles
  add constraint instance_profiles_received_hour_truncated
    check (received_hour = date_trunc('hour', received_hour)),
  add constraint instance_profiles_day_id_shape
    check (day_id ~ '^[0-9a-f]{32}$'),
  add constraint instance_profiles_gateway_version_shape
    check (
      gateway_version = 'dev'
      or gateway_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$'
    ),
  add constraint instance_profiles_deployment_known
    check (deployment in ('docker', 'railway', 'fly', 'other')),
  add constraint instance_profiles_runtime_shape
    check (runtime ~ '^node-[0-9]{1,3}$'),
  add constraint instance_profiles_arch_known
    check (arch in ('x64', 'arm64', 'other')),
  add constraint instance_profiles_sign_in_kinds_known
    check (sign_in_kinds <@ array['oidc', 'github', 'local']::text[]),
  add constraint instance_profiles_counts_bucketed
    check (
      users in ('0', '1', '2-5', '6-20', '21-100', '101-1000', '>1000')
      and active_missions in ('0', '1', '2-5', '6-20', '21-100', '101-1000', '>1000')
      and calls in ('0', '1', '2-5', '6-20', '21-100', '101-1000', '>1000')
    );

create index if not exists instance_profiles_by_hour
  on public.instance_profiles (received_hour);

create table if not exists public.instance_profile_plugins (
  id bigint generated always as identity primary key,
  received_hour timestamptz not null default date_trunc('hour', now()),
  day_id text not null,
  plugin text not null,
  plugin_version text not null,
  accounts text not null
);

alter table public.instance_profile_plugins
  drop constraint if exists instance_profile_plugins_received_hour_truncated,
  drop constraint if exists instance_profile_plugins_day_id_shape,
  drop constraint if exists instance_profile_plugins_plugin_shape,
  drop constraint if exists instance_profile_plugins_plugin_version_shape,
  drop constraint if exists instance_profile_plugins_accounts_bucketed;

alter table public.instance_profile_plugins
  add constraint instance_profile_plugins_received_hour_truncated
    check (received_hour = date_trunc('hour', received_hour)),
  add constraint instance_profile_plugins_day_id_shape
    check (day_id ~ '^[0-9a-f]{32}$'),
  add constraint instance_profile_plugins_plugin_shape
    check (plugin ~ '^[a-z][a-z0-9-]{0,62}$'),
  add constraint instance_profile_plugins_plugin_version_shape
    check (plugin_version ~ '^[0-9]{1,5}\.[0-9]{1,5}\.[0-9]{1,5}(-[0-9A-Za-z.-]{1,32})?(\+[0-9A-Za-z.-]{1,32})?$'),
  add constraint instance_profile_plugins_accounts_bucketed
    check (accounts in ('0', '1', '2-5', '6-20', '21-100', '101-1000', '>1000'));

-- ---------------------------------------------------------------------------
-- Insert-only and anonymous
-- ---------------------------------------------------------------------------
-- RLS is on with a single policy per table: `anon` may insert. There is no
-- SELECT, UPDATE or DELETE policy, and the privileges say the same thing a
-- second time: `anon` holds INSERT on the report columns only (it cannot
-- choose `id` or `received_hour`).

alter table public.plugin_reports enable row level security;
alter table public.decision_reports enable row level security;
alter table public.instance_profiles enable row level security;
alter table public.instance_profile_plugins enable row level security;

revoke all on table public.plugin_reports from public, anon, authenticated;
revoke all on table public.decision_reports from public, anon, authenticated;
revoke all on table public.instance_profiles from public, anon, authenticated;
revoke all on table public.instance_profile_plugins from public, anon, authenticated;

grant insert (plugin, plugin_version, gateway_version, tool, outcome, error_class, duration_bucket)
  on table public.plugin_reports to anon;
grant insert (plugin, tool, gateway_version, decision, risks, gate)
  on table public.decision_reports to anon;
grant insert (day_id, gateway_version, deployment, runtime, arch, sign_in_kinds, users, active_missions, calls)
  on table public.instance_profiles to anon;
grant insert (day_id, plugin, plugin_version, accounts)
  on table public.instance_profile_plugins to anon;

drop policy if exists plugin_reports_anon_insert on public.plugin_reports;
create policy plugin_reports_anon_insert
  on public.plugin_reports
  for insert
  to anon
  with check (true);

drop policy if exists decision_reports_anon_insert on public.decision_reports;
create policy decision_reports_anon_insert
  on public.decision_reports
  for insert
  to anon
  with check (true);

drop policy if exists instance_profiles_anon_insert on public.instance_profiles;
create policy instance_profiles_anon_insert
  on public.instance_profiles
  for insert
  to anon
  with check (true);

drop policy if exists instance_profile_plugins_anon_insert on public.instance_profile_plugins;
create policy instance_profile_plugins_anon_insert
  on public.instance_profile_plugins
  for insert
  to anon
  with check (true);

-- ---------------------------------------------------------------------------
-- Ingestion limit
-- ---------------------------------------------------------------------------
-- The collector keeps no address, so it cannot limit per source. It limits
-- all tables together instead: at most `max_rows_per_statement` rows per
-- request and `max_rows_per_minute` rows per minute, all sources together.
-- Beyond that the insert is refused with HTTP 429 (PostgREST maps SQLSTATE
-- `PT429` to that status); the collector answers 429 and the gateway's
-- client retries later with backoff.

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

drop trigger if exists decision_reports_ingest_limit on public.decision_reports;
create trigger decision_reports_ingest_limit
  after insert on public.decision_reports
  referencing new table as inserted
  for each statement
  execute function collector_private.enforce_ingest_limit();

drop trigger if exists instance_profiles_ingest_limit on public.instance_profiles;
create trigger instance_profiles_ingest_limit
  after insert on public.instance_profiles
  referencing new table as inserted
  for each statement
  execute function collector_private.enforce_ingest_limit();

drop trigger if exists instance_profile_plugins_ingest_limit on public.instance_profile_plugins;
create trigger instance_profile_plugins_ingest_limit
  after insert on public.instance_profile_plugins
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
-- The views run with their owner's rights on purpose (`security_invoker =
-- false`): `anon` cannot read a table, only these aggregates.

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
where r.received_hour
  >= now() - make_interval(days => (select t.window_days from public.plugin_validation_thresholds() t))
group by grouping sets ((r.plugin, r.plugin_version, r.tool), (r.plugin, r.plugin_version));

revoke all on table public.plugin_stats from public, anon, authenticated;
grant select on table public.plugin_stats to anon, authenticated;

-- Instances that sent a profile, per UTC day of arrival, over the window.
create or replace view public.reporting_instances
with (security_invoker = false)
as
select
  (p.received_hour at time zone 'utc')::date as day,
  count(distinct p.day_id)::bigint as instances
from public.instance_profiles p
where p.received_hour
  >= now() - make_interval(days => (select t.window_days from public.plugin_validation_thresholds() t))
group by 1;

revoke all on table public.reporting_instances from public, anon, authenticated;
grant select on table public.reporting_instances to anon, authenticated;

-- ---------------------------------------------------------------------------
-- What the platform added
-- ---------------------------------------------------------------------------
-- A project created with "automatic RLS" carries `public.rls_auto_enable()`,
-- an event-trigger function that the API exposes as an RPC to `anon`. It
-- cannot be called that way, but nothing of this project is meant to be
-- callable: the privilege is removed (the event trigger keeps firing).

do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'rls_auto_enable'
  ) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Maintainers' views (not exposed by the API: the schema is not granted)
-- ---------------------------------------------------------------------------

create or replace view collector_private.decisions_by_day
as
select
  (d.received_hour at time zone 'utc')::date as day,
  d.plugin,
  d.decision,
  d.gate,
  count(*)::bigint as calls
from public.decision_reports d
group by 1, 2, 3, 4;

create or replace view collector_private.risks_by_day
as
select
  (d.received_hour at time zone 'utc')::date as day,
  risk,
  count(*)::bigint as calls,
  (count(*) filter (where d.decision = 'allowed'))::bigint as allowed
from public.decision_reports d, unnest(d.risks) as risk
group by 1, 2;

commit;
