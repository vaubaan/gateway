-- =============================================================================
-- 0018_gate_allow_confirm_deny.sql
--
-- Renames the policy_rules.gate enum from 2-state to 3-state :
--   ai      → allow    (mint immediately, no human in the loop)
--   human   → confirm  (open approval flow ; Telegram ✅/❌ or UI)
--   (new)   → deny     (refuse the mint outright, no override possible)
--
-- Default no-matching-rule → `deny` (per spec — the rule database is an
-- explicit allow-list, anything not granted is refused).
--
-- The seed rules per project remain functionally equivalent (read defaults
-- to autonomous, write defaults to human approval) :
--   *:*:*:read:*  → allow    (was ai)
--   *:*:*:write:* → confirm  (was human)
--
-- The anti-pattern CHECK is renamed accordingly : a blanket `allow` on
-- writes (`action='write' ∧ env_pattern='*' ∧ gate='allow'`) is still
-- forbidden — it would silently authorize prod.
--
-- Spec : docs/spec/gateway-capability-model.draft.md §5, §5.1.
-- =============================================================================

-- 1. Drop the old constraints so we can rewrite the values.
alter table policy_rules
  drop constraint if exists policy_rules_no_blanket_ai_write,
  drop constraint if exists policy_rules_gate_check;

-- 2. Rewrite the values in place.
update policy_rules set gate = 'allow'   where gate = 'ai';
update policy_rules set gate = 'confirm' where gate = 'human';

-- 3. Install the new CHECK + the renamed anti-pattern guard.
alter table policy_rules
  add constraint policy_rules_gate_check
    check (gate in ('allow', 'confirm', 'deny'));

alter table policy_rules
  add constraint policy_rules_no_blanket_allow_write
    check (not (action = 'write' and env_pattern = '*' and gate = 'allow'));

-- 4. Update the AFTER INSERT trigger for new projects.
create or replace function seed_default_policy_rules() returns trigger as $$
begin
  insert into policy_rules
    (project_id, provider, plane, level, action, env_pattern, gate, priority)
  values
    (new.id, '*', '*', '*', 'read',  '*', 'allow',   0),
    (new.id, '*', '*', '*', 'write', '*', 'confirm', 0);
  return new;
end;
$$ language plpgsql;
