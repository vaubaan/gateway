-- =============================================================================
-- 0010_purge_expired_access_tokens.sql
--
-- Daily pg_cron job that deletes AccessTokens past their `expires_at` plus a
-- 7-day grace period. The hot-path gateway already rejects expired tokens
-- via AuthError('access token has expired.') — this migration adds the
-- housekeeping that prevents the `access_tokens` table from accumulating
-- forever once a token has been programmatically minted with a TTL.
--
-- Long-lived tokens (`expires_at IS NULL`, typically UI-minted) are never
-- touched.
--
-- Spec : docs/spec/vaubaan-gateway.md §8.5 (AccessToken lifecycle)
-- ADR  : docs/decisions/programmatic-access-token-minting.md
-- =============================================================================

create extension if not exists pg_cron;

-- Idempotent re-schedule : if the job already exists from a previous apply,
-- unschedule it first so re-running this migration doesn't pile up duplicates.
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

select cron.schedule(
  'purge-expired-access-tokens',
  '0 3 * * *',  -- daily at 03:00 UTC
  $$
    delete from access_tokens
    where expires_at is not null
      and expires_at < now() - interval '7 days';
  $$
);
