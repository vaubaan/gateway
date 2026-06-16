-- =============================================================================
-- 0035_drop_legacy_token_tables.sql
--
-- Drops `access_tokens` and `org_management_keys` after the data migration
-- (0033) has copied their rows into the unified `tokens` table and re-pointed
-- the FKs (`approval_requests.access_token_id`, `audit_log.access_token_id`)
-- to `tokens(id)`.
--
-- PRE-REQS verified by 0033 :
--   - approval_requests no longer FK-references access_tokens or
--     org_management_keys.
--   - audit_log no longer FK-references access_tokens.
--   - vps_ssh_audit.access_token_id is plain uuid (no FK ; created in 0011).
--
-- Also drops the pg_cron purge job that targeted access_tokens (it would
-- error every night otherwise) ; the equivalent job for `tokens` is scheduled
-- right here so expired token rows are still housekept.
-- =============================================================================

-- ─── Drop the legacy pg_cron purge job for access_tokens.
do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid
  from cron.job
  where jobname = 'purge-expired-access-tokens';

  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end;
$$;

-- ─── Drop the legacy tables.
drop table if exists access_tokens cascade;
drop table if exists org_management_keys cascade;

-- ─── Re-schedule the equivalent purge job for `tokens`.
select cron.schedule(
  'purge-expired-tokens',
  '0 3 * * *',  -- daily at 03:00 UTC
  $$
    delete from tokens
    where expires_at is not null
      and expires_at < now() - interval '7 days';
  $$
);
