-- Stripe is per-project (not org-level). Each project can store a test key
-- and a live key, both encrypted at rest. The account_id lets the UI build
-- the correct Stripe Dashboard URL for the operator.
--
-- provider_admins: stripe is NOT added here (no org-level connection).
-- provider_bindings: stripe added so catalog/risk resolution can find it.

ALTER TABLE provider_bindings DROP CONSTRAINT IF EXISTS provider_bindings_provider_check;
ALTER TABLE provider_bindings ADD CONSTRAINT provider_bindings_provider_check
  CHECK (provider IN ('github','vercel','supabase','railway','bash','ssh','stripe'));

CREATE TABLE stripe_bindings (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  account_id           text        NOT NULL,
  test_key_encrypted   bytea,
  live_key_encrypted   bytea,
  created_by_user_id   uuid        REFERENCES auth.users(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, account_id)
);

ALTER TABLE stripe_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org members can manage stripe bindings"
  ON stripe_bindings FOR ALL
  USING (
    project_id IN (
      SELECT p.id FROM projects p
      JOIN org_members om ON om.organization_id = p.organization_id
      WHERE om.user_id = auth.uid()
    )
  );
