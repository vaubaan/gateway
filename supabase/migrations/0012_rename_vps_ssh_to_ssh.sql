-- 0012_rename_vps_ssh_to_ssh.sql
-- Rename vps-ssh → ssh. No prod data exists in vps_ssh_* tables.
-- Rollback: DROP ssh_bindings, ssh_audit; re-create vps_ssh_* tables; revert CHECK constraints.

DROP TABLE IF EXISTS vps_ssh_audit;
DROP TABLE IF EXISTS vps_ssh_bindings;

ALTER TABLE provider_admins DROP CONSTRAINT IF EXISTS provider_admins_provider_check;
ALTER TABLE provider_admins ADD CONSTRAINT provider_admins_provider_check
  CHECK (provider IN ('github','vercel','supabase','railway','ssh'));

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_provider_check;
ALTER TABLE roles ADD CONSTRAINT roles_provider_check
  CHECK (provider IN ('github','vercel','supabase','railway','ssh'));

DELETE FROM roles WHERE provider = 'vps-ssh';

CREATE TABLE ssh_bindings (
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

ALTER TABLE ssh_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org members can manage ssh bindings"
  ON ssh_bindings FOR ALL
  USING (
    project_id IN (
      SELECT p.id FROM projects p
      JOIN org_members om ON om.organization_id = p.organization_id
      WHERE om.user_id = auth.uid()
    )
  );

CREATE TABLE ssh_audit (
  id           bigserial   PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  project_slug text        NOT NULL,
  session_id   text        NOT NULL,
  host_slug    text        NOT NULL,
  cmd          text        NOT NULL,
  exit_code    integer,
  stdout_bytes integer,
  duration_ms  integer
);
CREATE INDEX idx_ssh_audit_ts      ON ssh_audit (ts DESC);
CREATE INDEX idx_ssh_audit_project ON ssh_audit (project_slug, ts DESC);

-- Re-seed roles with new provider name
INSERT INTO roles (id, organization_id, provider, name, description, is_builtin, permissions)
VALUES
  (gen_random_uuid(), null, 'ssh', 'ssh:read',
   'Read-only SSH: journalctl, cat, ls, tail, head, grep, pgrep, ps, docker ps/inspect/logs, systemctl status, df, free, uptime, who, ss -tlnp, md5sum, stat.',
   true,
   jsonb_build_object('version', 1, 'rules', jsonb_build_array(
     jsonb_build_object('effect', 'allow', 'target', '*', 'tool_matches', jsonb_build_array('ssh__exec'))
   ))),
  (gen_random_uuid(), null, 'ssh', 'ssh:write',
   'Full SSH access: any command on bound hosts.',
   true,
   jsonb_build_object('version', 1, 'rules', jsonb_build_array(
     jsonb_build_object('effect', 'allow', 'target', '*', 'tool_matches', jsonb_build_array('ssh__exec'))
   )));
