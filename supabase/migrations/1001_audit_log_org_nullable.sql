-- =====================================================================
-- 1001_audit_log_org_nullable.sql
--
-- Allow org-less rows in `public.audit_log` so that user-scoped events
-- (e.g. `user.crypto-key.created` / `rotated-password` / `replaced-identity`,
-- spec §4.1 / §4.6 / §4.7) can be persisted without being attached to a
-- specific organisation. User crypto identity is global to the user, not
-- to one org.
--
-- Changes:
--   1. `audit_log.organization_id` becomes nullable.
--   2. New RLS policies:
--        - `audit_log_select_self` : the actor can read their org-less rows.
--        - `audit_log_insert_self` : the authenticated user can insert
--          their own org-less audit row (subject to actor_user_id =
--          auth.uid() AND organization_id IS NULL).
--      The existing `audit_log_select_member` keeps reading org-scoped
--      rows for any member of that org.
-- =====================================================================

alter table public.audit_log
  alter column organization_id drop not null;

-- Self-read for org-less rows. Org-scoped rows remain visible via the
-- existing `audit_log_select_member` policy.
create policy audit_log_select_self
  on public.audit_log for select
  to authenticated
  using (
    organization_id is null
    and actor_user_id = auth.uid()
  );

-- Self-insert for org-less rows. Audit-log writes from inside an org
-- still require service-role; this policy only authorises the narrow
-- case of "user logging their own crypto-key lifecycle".
create policy audit_log_insert_self
  on public.audit_log for insert
  to authenticated
  with check (
    organization_id is null
    and actor_user_id = auth.uid()
  );
