-- Widen provider CHECK constraints to include cloudflare-dns, upstash-redis, resend, gmail.
-- These providers use paste-token org-level connections (like Vercel PAT) or per-project
-- bindings. The CHECK must allow them in provider_admins, provider_bindings, and roles.

ALTER TABLE provider_admins DROP CONSTRAINT IF EXISTS provider_admins_provider_check;
ALTER TABLE provider_admins ADD CONSTRAINT provider_admins_provider_check
  CHECK (provider IN ('github','vercel','supabase','railway','ssh','cloudflare-dns','upstash-redis','resend','gmail'));

ALTER TABLE provider_bindings DROP CONSTRAINT IF EXISTS provider_bindings_provider_check;
ALTER TABLE provider_bindings ADD CONSTRAINT provider_bindings_provider_check
  CHECK (provider IN ('github','vercel','supabase','railway','bash','ssh','stripe','cloudflare-dns','upstash-redis','resend','gmail'));

ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_provider_check;
ALTER TABLE roles ADD CONSTRAINT roles_provider_check
  CHECK (provider IN ('github','vercel','supabase','railway','ssh','cloudflare-dns','upstash-redis','resend','gmail'));
