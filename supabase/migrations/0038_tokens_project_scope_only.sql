-- =============================================================================
-- 0038_tokens_project_scope_only.sql
--
-- Amendement ADR unified-tokens-delegation-chain-and-escalation-channel.md
-- §2026-06-19 — all tokens are project-scoped. The `scope = 'org'` branch
-- is dropped from the enum, the orphan rows (root org-scoped tokens that
-- replaced the legacy `org_management_keys` via 0033) are deleted, and the
-- CHECK constraint is tightened.
--
-- The column itself is KEPT (not DROP COLUMN) for reversibility — if we
-- ever re-introduce an org-scoped admin token, we relax the CHECK.
--
-- Pre-conditions :
--   - Migration 0035 already dropped `org_management_keys`.
--   - 0033 migrated rows from `org_management_keys` into `tokens` with
--     `scope='org', parent_id IS NULL, project_id IS NULL`. These rows
--     have no project_id, so they cannot be salvaged into the new model.
-- =============================================================================

-- ─── Delete the orphan org-scoped roots. The auto-provisioning Runner flow
--     they served is abandoned ; humans now mint project-scoped roots
--     directly via the dashboard Project page.
delete from tokens where scope = 'org';

-- ─── Tighten the scope check + the scope/project_id coherence constraint.
alter table tokens drop constraint if exists tokens_scope_check;
alter table tokens drop constraint if exists tokens_scope_project_coherence;

alter table tokens
  add constraint tokens_scope_check
  check (scope = 'project');

-- Now that scope = 'project' is the only allowed value, project_id is
-- always required. Backfill any null (defensive — there shouldn't be any
-- after the delete above) and tighten the column.
alter table tokens
  alter column project_id set not null;

alter table tokens
  add constraint tokens_scope_project_coherence
  check (scope = 'project' and project_id is not null);
