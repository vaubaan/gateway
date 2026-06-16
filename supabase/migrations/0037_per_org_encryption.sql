-- =============================================================================
-- 0037_per_org_encryption.sql — cleanup pgsodium artifacts (if any)
--
-- Encryption is now handled app-side via libsodium-wrappers (Node.js).
-- See docs/decisions/per-org-encryption-app-level.md.
--
-- This migration drops any pgsodium objects that may have been created by
-- earlier (failed) attempts at DB-level encryption. It is idempotent.
--
-- Data migration (plaintext bytea → app-encrypted bytea) is handled by
-- scripts/migrate-encrypt-tokens.ts.
-- =============================================================================

DROP VIEW IF EXISTS provider_admins_decrypted CASCADE;
DROP FUNCTION IF EXISTS upsert_provider_admin_encrypted(uuid, text, text, text, text, text, text, timestamptz, uuid) CASCADE;
DROP FUNCTION IF EXISTS update_provider_admin_tokens(uuid, text, text, timestamptz) CASCADE;
DROP FUNCTION IF EXISTS encrypt_provider_secret(uuid, text) CASCADE;
DROP FUNCTION IF EXISTS decrypt_provider_secret(uuid, bytea) CASCADE;
DROP FUNCTION IF EXISTS create_org_encryption_key() CASCADE;
DROP TRIGGER IF EXISTS trg_org_create_encryption_key ON organizations;
ALTER TABLE organizations DROP COLUMN IF EXISTS encryption_key_id;
