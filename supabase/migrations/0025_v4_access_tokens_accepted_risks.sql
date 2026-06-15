-- =============================================================================
-- 0025_v4_access_tokens_accepted_risks.sql
--
-- Phase 3 of the v4 risk-based pivot — adds the new wire shape to
-- `access_tokens`. The token now carries :
--   - `accepted_risks jsonb`  : array of RiskId strings — what the issuer
--                              accepts as consequence of letting the agent
--                              operate.
--   - `denied_risks jsonb`    : explicit opt-out list (optional ; default []).
--
-- The legacy `capabilities jsonb` column (migration 0015) is KEPT for now to
-- enable a dual-mode boot during Phases 2-3. It will be dropped in a later
-- migration (0032) after the gateway is switched fully to risk-based runtime
-- and all in-flight tokens have been re-minted or expired.
--
-- RiskId format (cf. ADR pivot-to-risk-based-model §D2) :
--   - env-scoped     : '<provider>[<env>].<name>'
--   - non-env-scoped : '<provider>.<name>'
--   - regex : ^[a-z][a-z0-9]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$
--
-- Spec : docs/spec/gateway-risk-model.md §5 (wire format).
-- =============================================================================

alter table access_tokens
  add column accepted_risks jsonb not null default '[]'::jsonb,
  add column denied_risks jsonb not null default '[]'::jsonb;

-- Validation : every element of accepted_risks / denied_risks must match the
-- RiskId regex. Enforced via a function-based CHECK constraint.
create or replace function valid_risk_id_array(arr jsonb) returns boolean
language plpgsql immutable as $$
declare
  re text := '^[a-z][a-z0-9]*(\[[a-z][a-z0-9-]*\])?(\.[a-z][a-z0-9-]+)+$';
  elem jsonb;
begin
  if jsonb_typeof(arr) <> 'array' then
    return false;
  end if;
  for elem in select * from jsonb_array_elements(arr) loop
    if jsonb_typeof(elem) <> 'string' then
      return false;
    end if;
    if (elem #>> '{}') !~ re then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

alter table access_tokens
  add constraint access_tokens_accepted_risks_valid
    check (valid_risk_id_array(accepted_risks));

alter table access_tokens
  add constraint access_tokens_denied_risks_valid
    check (valid_risk_id_array(denied_risks));

-- GIN index for fast `?` / `?|` lookups when filtering tokens by risk.
create index access_tokens_accepted_risks_idx
  on access_tokens using gin (accepted_risks);
