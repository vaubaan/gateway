-- =============================================================================
-- 0033_data_migration_to_tokens.sql
--
-- Copies all rows from `org_management_keys` and `access_tokens` into the new
-- unified `tokens` table (cf. ADR unified-tokens-delegation-chain-and-
-- escalation-channel.md). Run between 0032 (which creates `tokens`) and 0035
-- (which drops the legacy tables).
--
-- ID PRESERVATION : we keep the original `id` UUID on each migrated row so
-- that the FK in `approval_requests.access_token_id` (which still references
-- `access_tokens(id)`) can be re-pointed to `tokens(id)` without rewriting
-- the column values.
--
-- PARENT_ID : tous les rows migrés ont `parent_id=NULL` (root). On ne tente
-- pas de reconstruire la hiérarchie depuis approval_requests ; MVP pré-prod,
-- on accepte que la forensique pré-migration soit incomplète (ADR §"casse-
-- tout"). Le `delegation_chain` est donc systématiquement '[]'.
--
-- SUBSET INVARIANT EDGE CASE : un root org-scoped token migré depuis
-- org_management_keys aura `accepted_risks=[]`. Le runtime du mint endpoint
-- traite ce cas particulier (parent.scope='org' AND parent.accepted_risks=[])
-- comme "carte blanche" pour permettre aux mgmt keys migrées de continuer à
-- mint. Behavior tactique, à nettoyer post-prod.
-- =============================================================================

-- ─── 1. Drop the FK from approval_requests → access_tokens BEFORE the copy
--       so 0035's cascade-drop doesn't take approval_requests with it.
alter table approval_requests
  drop constraint if exists approval_requests_access_token_id_fkey;

alter table approval_requests
  drop constraint if exists approval_requests_requested_by_management_key_id_fkey;

-- ─── 2. Same for audit_log → access_tokens.
alter table audit_log
  drop constraint if exists audit_log_access_token_id_fkey;

-- ─── 3. Copy org_management_keys → tokens.
--       scope='org', project_id=NULL, depth=0, delegation_chain='[]'.
insert into tokens (
  id, organization_id, parent_id, scope, project_id, name,
  api_key_prefix, api_key_hash, status,
  accepted_risks, denied_risks, depth, delegation_chain, context,
  expires_at, single_use, consumed_at, last_used_at,
  created_by, created_at
)
select
  id,
  organization_id,
  null::uuid as parent_id,
  'org'::text as scope,
  null::uuid as project_id,
  name,
  api_key_prefix,
  api_key_hash,
  status,
  '[]'::jsonb as accepted_risks,
  '[]'::jsonb as denied_risks,
  0 as depth,
  '[]'::jsonb as delegation_chain,
  null::jsonb as context,
  null::timestamptz as expires_at,
  false as single_use,
  null::timestamptz as consumed_at,
  last_used_at,
  created_by,
  created_at
from org_management_keys
on conflict (api_key_prefix) do nothing;

-- ─── 4. Copy access_tokens → tokens.
--       scope='project', project_id preserved, depth=0, parent_id=NULL.
--       Resolve organization_id via projects join.
insert into tokens (
  id, organization_id, parent_id, scope, project_id, name,
  api_key_prefix, api_key_hash, status,
  accepted_risks, denied_risks, depth, delegation_chain, context,
  expires_at, single_use, consumed_at, last_used_at,
  created_by, created_at
)
select
  at.id,
  p.organization_id,
  null::uuid as parent_id,
  'project'::text as scope,
  at.project_id,
  at.name,
  at.api_key_prefix,
  at.api_key_hash,
  at.status,
  at.accepted_risks,
  at.denied_risks,
  0 as depth,
  '[]'::jsonb as delegation_chain,
  null::jsonb as context,
  at.expires_at,
  at.single_use,
  at.consumed_at,
  at.last_used_at,
  at.created_by,
  at.created_at
from access_tokens at
join projects p on p.id = at.project_id
on conflict (api_key_prefix) do nothing;

-- ─── 5. Re-point approval_requests.access_token_id FK to tokens(id).
--       IDs are preserved by the copy, so existing values are still valid.
alter table approval_requests
  add constraint approval_requests_access_token_id_fkey
    foreign key (access_token_id) references tokens(id) on delete set null;

-- ─── 6. Re-point audit_log.access_token_id FK to tokens(id).
alter table audit_log
  add constraint audit_log_access_token_id_fkey
    foreign key (access_token_id) references tokens(id) on delete set null;

-- ─── 7. requested_by_management_key_id : pas de re-FK. La colonne devient
--       un uuid libre (les rows historiques pointaient vers mgmt keys qui
--       sont maintenant des rows tokens — l'ID est préservé mais on ne
--       force pas la contrainte référentielle pour des raisons de
--       simplicité de migration. La colonne sera renommée en
--       requested_by_parent_token_id dans une migration ultérieure si
--       besoin).
