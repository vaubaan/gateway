-- Widen provider CHECK constraints to include 'stripe'.
--
-- provider_admins: org-level connection (paste-token for Stripe).
-- provider_bindings: per-project bindings.

ALTER TABLE provider_admins DROP CONSTRAINT IF EXISTS provider_admins_provider_check;
ALTER TABLE provider_admins ADD CONSTRAINT provider_admins_provider_check
  CHECK (provider IN ('github','vercel','supabase','railway','ssh','stripe'));

ALTER TABLE provider_bindings DROP CONSTRAINT IF EXISTS provider_bindings_provider_check;
ALTER TABLE provider_bindings ADD CONSTRAINT provider_bindings_provider_check
  CHECK (provider IN ('github','vercel','supabase','railway','bash','ssh','stripe'));
