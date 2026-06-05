-- =============================================================================
-- 0011_add_vps_ssh.sql
--
-- Add VPS-SSH provider to the gateway.
--   1. Widen provider_admins provider CHECK to include 'vps-ssh'.
--   2. Create vps_ssh_bindings (per-project, per-host SSH bindings).
--   3. Create vps_ssh_audit (execution audit log).
--   4. Seed 2 builtin roles: vps-ssh:read + vps-ssh:write.
--
-- Rollback: restore the old provider_admins constraint (drop + re-add without
-- 'vps-ssh'). The new tables can be dropped with CASCADE.
-- =============================================================================

-- 1. Widen provider_admins CHECK -------------------------------------------
ALTER TABLE provider_admins DROP CONSTRAINT IF EXISTS provider_admins_provider_check;
ALTER TABLE provider_admins ADD CONSTRAINT provider_admins_provider_check
  CHECK (provider IN ('github', 'vercel', 'supabase', 'railway', 'vps-ssh'));

-- Also widen roles provider check
ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_provider_check;
ALTER TABLE roles ADD CONSTRAINT roles_provider_check
  CHECK (provider IN ('github', 'vercel', 'supabase', 'railway', 'vps-ssh'));

-- 2. Per-project SSH bindings ------------------------------------------------
CREATE TABLE vps_ssh_bindings (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  host_slug       text        NOT NULL,
  host_address    text        NOT NULL,
  port            integer     NOT NULL DEFAULT 22,
  ssh_user        text        NOT NULL DEFAULT 'dev',
  ssh_private_key bytea       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, host_slug)
);

ALTER TABLE vps_ssh_bindings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can manage their project ssh bindings"
  ON vps_ssh_bindings FOR ALL
  USING (
    project_id IN (
      SELECT p.id FROM projects p
      JOIN org_members om ON om.organization_id = p.organization_id
      WHERE om.user_id = auth.uid()
    )
  );

-- 3. Execution audit log -----------------------------------------------------
CREATE TABLE vps_ssh_audit (
  id              bigserial   PRIMARY KEY,
  project_id      uuid        REFERENCES projects(id),
  access_token_id uuid,
  host_slug       text        NOT NULL,
  cmd             text        NOT NULL,
  exit_code       integer,
  stdout_len      integer,
  duration_ms     integer,
  executed_at     timestamptz NOT NULL DEFAULT now()
);

-- 4. Builtin roles -----------------------------------------------------------
INSERT INTO roles (id, organization_id, provider, name, description, is_builtin, permissions)
VALUES
  (
    gen_random_uuid(),
    null,
    'vps-ssh',
    'vps-ssh:read',
    'Read-only SSH: journalctl, cat, ls, tail, head, grep, ps, docker ps/inspect/logs, systemctl status, df, free, uptime, etc.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', '*',
          'tool_matches', jsonb_build_array('vps_ssh__exec')
        )
      )
    )
  ),
  (
    gen_random_uuid(),
    null,
    'vps-ssh',
    'vps-ssh:write',
    'Full SSH access: any command on bound hosts.',
    true,
    jsonb_build_object(
      'version', 1,
      'rules', jsonb_build_array(
        jsonb_build_object(
          'effect', 'allow',
          'target', '*',
          'tool_matches', jsonb_build_array('vps_ssh__exec')
        )
      )
    )
  )
ON CONFLICT (organization_id, name) DO NOTHING;
