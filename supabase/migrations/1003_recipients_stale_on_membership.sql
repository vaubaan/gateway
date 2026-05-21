-- =====================================================================
-- 1003_recipients_stale_on_membership.sql
--
-- Phase 6 wave B (spec §4.5 "re-sealing on membership change", §4.4
-- recipient defaults).
--
-- Adds a trigger that flips `resource_access.recipients_stale = true`
-- whenever a row is INSERTED or DELETED on `org_members`. The set of
-- affected access rows is every blob belonging to a Resource of the
-- mutated org — we don't try to compute the precise pubkey diff in
-- SQL (RLS can't see all user_crypto_keys rows anyway, and the
-- recipient default policy lives in TypeScript, spec §4.4).
--
-- The flag is reset to false by the PUT /access/:key handler when an
-- admin re-seals the blob (Phase 6 wave B fix of the Phase 5 TODO).
--
-- Trigger is `security definer` so it runs with elevated privileges:
-- it must update `resource_access` rows the actor (an admin inserting
-- a member, for instance) already has UPDATE rights on, but the
-- writers of `org_members` may not always have UPDATE on
-- `resource_access` directly via the same statement.
-- =====================================================================

set check_function_bodies = off;

create or replace function public.flip_recipients_stale_on_member_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  -- TG_OP is 'INSERT' (NEW row) or 'DELETE' (OLD row).
  if (tg_op = 'INSERT') then
    v_org_id := new.organization_id;
  elsif (tg_op = 'DELETE') then
    v_org_id := old.organization_id;
  else
    return null;
  end if;

  update public.resource_access ra
     set recipients_stale = true
    from public.resources r
   where ra.resource_id = r.id
     and r.organization_id = v_org_id
     and ra.recipients_stale = false;

  if (tg_op = 'DELETE') then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.flip_recipients_stale_on_member_change() from public;
-- The trigger fires under `security definer`, so we don't grant
-- execute to authenticated. The function is only callable via the
-- trigger context.

drop trigger if exists org_members_recipients_stale on public.org_members;

create trigger org_members_recipients_stale
  after insert or delete on public.org_members
  for each row execute function public.flip_recipients_stale_on_member_change();

-- Ledger row (spec §13 migration discipline).
insert into public.audit_log (organization_id, actor_user_id, action, scope, subject)
values (
  null,
  null,
  'migration.applied',
  '{"file":"supabase/migrations/1003_recipients_stale_on_membership.sql"}'::jsonb,
  '{"version":"1003","phase":"6","wave":"B"}'::jsonb
);
