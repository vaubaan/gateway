-- =============================================================================
-- 0017_approval_sweeper_cron.sql
--
-- Schedules the nightly sweep of stale approval_requests rows. Mirrors the
-- `purge-expired-access-tokens` job from 0010 but for the approval flow :
--   - flips status='pending' rows past expires_at to 'expired'.
--   - clears any forgotten pending_api_key on rows that were approved but
--     never consumed past expires_at.
--
-- The work is done by `expire_stale_approval_requests()` (defined in 0013).
-- This migration only wires it into pg_cron.
--
-- Spec : docs/spec/gateway-capability-model.draft.md §8 (lifecycle TTL).
-- =============================================================================

-- pg_cron is already enabled by 0010 ; keep this idempotent.
create extension if not exists pg_cron;

-- Idempotent re-schedule.
do $$
declare
  existing_jobid bigint;
begin
  select jobid into existing_jobid
  from cron.job
  where jobname = 'expire-stale-approval-requests';

  if existing_jobid is not null then
    perform cron.unschedule(existing_jobid);
  end if;
end;
$$;

select cron.schedule(
  'expire-stale-approval-requests',
  '*/5 * * * *',  -- every 5 minutes — TTL is 15min so we want a tight loop
  $$ select expire_stale_approval_requests(); $$
);
