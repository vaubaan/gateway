-- =============================================================================
-- 0036_drop_confirm_gates_and_approvals.sql
--
-- Drops the entire 3-gate / mint-time approval machinery introduced by
-- migrations 0010 → 0030. The new model is binary :
--   - a risk is in `tokens.accepted_risks` (= allowed)
--   - or it isn't (= denied)
-- Runtime escalation lives outside the gateway via `context.escalation_channel`
-- on the token (unified-tokens ADR D4).
--
-- ADR : docs/decisions/unified-gates-drop-confirm.md (D3, D4).
--
-- Tables dropped (CASCADE is safe — no external FKs expected) :
--   - approval_requests           : mint-time pending approval rows (Telegram /
--                                   Email / Manual long-poll). Superseded by
--                                   runtime escalation via escalation_channel.
--   - project_approval_channels   : per-project channel config (telegram chat
--                                   id, email address, encrypted bot token).
--                                   No equivalent — escalation_channel is a
--                                   per-token field set by the parent at mint.
--   - project_risk_policies       : per-project override of catalog default_gate.
--                                   Dropped because default_gate is dropped too
--                                   (ADR D2). Risk severity is intrinsic to the
--                                   provider catalog ; project tightening = the
--                                   operator doesn't check the risk.
--
-- Cron job unscheduled :
--   - expire-stale-approval-requests : sweeper for approval_requests TTL,
--                                      pointless once the table is gone.
-- =============================================================================

-- ─── Unschedule the approval sweeper cron job (if it exists).
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

-- ─── Drop the helper function used by that cron (no longer reachable).
drop function if exists expire_stale_approval_requests();

-- ─── Drop the legacy tables (CASCADE — any dangling view/policy goes too).
drop table if exists approval_requests cascade;
drop table if exists project_approval_channels cascade;
drop table if exists project_risk_policies cascade;
