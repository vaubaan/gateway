-- =============================================================================
-- 0022_bash_rls_alignment.sql
--
-- Align the RLS posture of the bash provider tables with the rest of the
-- schema. Migrations 0019 → 0021 introduced `runner_services` (later
-- dropped) and `bash_bindings` with a `FOR SELECT` policy only ; every
-- other per-project table in the schema (vps_ssh_bindings, provider_bindings,
-- access_tokens, …) uses `FOR ALL` so org members can read AND write
-- through the user-scoped Supabase client.
--
-- Practical effect today : the REST routes use `getSupabaseServiceClient`
-- which bypasses RLS, so this gap is dormant. But the next read/write path
-- using the user-scoped client (e.g. a server-component direct insert) will
-- hit a permission error that's hard to diagnose. Closing the gap now keeps
-- the convention consistent.
--
-- Scope :
--   - `bash_bindings`   : replace the existing SELECT-only policy with a
--                         FOR ALL policy mirroring the vps_ssh_bindings
--                         pattern (0011_add_vps_ssh.sql).
--   - `ssh_bindings`    : already has a FOR ALL policy from 0011 — no-op,
--                         documented here for completeness.
--   - `runner_services` : dropped in 0020 — no-op.
-- =============================================================================

drop policy if exists "org members read their project's bash_bindings"
  on bash_bindings;

create policy "org members can manage their project's bash_bindings"
  on bash_bindings
  for all
  using (
    project_id in (
      select p.id
      from projects p
      join org_members om on om.organization_id = p.organization_id
      where om.user_id = auth.uid()
    )
  );
