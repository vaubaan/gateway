-- =====================================================================
-- 1002_resource_access_recipients_stale.sql
--
-- Adds a `recipients_stale` boolean flag on `public.resource_access`
-- (spec §4.5: re-sealing on membership change, §4.7: lost-password
-- identity replacement). The flag is flipped to TRUE by:
--
--   1. The `PATCH /api/crm/v1/me/crypto-key` handler in `replace=true`
--      mode (lost-password / identity replacement, spec §4.7 step 4).
--      Every blob whose recipient list contained the old fingerprint
--      becomes stale.
--   2. Membership changes (Phase 5+) — additions and removals from
--      `org_members` mark every affected blob stale so the next admin
--      session can re-seal.
--
-- The Phase 4 wave C handler implements (1). (2) lands later — the
-- column is the contract surface.
--
-- The column is nullable-free with `default false` so existing rows
-- transparently start as "fresh" without an explicit backfill.
-- =====================================================================

alter table public.resource_access
  add column if not exists recipients_stale boolean not null default false;

-- Partial index : list of blobs that still need re-sealing. Read by the
-- UI banner (spec §11.2 "Stale recipients banner") and by the server-
-- side sweep helper. We use a partial index because the steady-state
-- expectation is `recipients_stale = false` on virtually every row.
create index if not exists resource_access_recipients_stale_idx
  on public.resource_access (resource_id)
  where recipients_stale;
