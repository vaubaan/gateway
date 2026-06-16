-- =============================================================================
-- 0037_per_org_encryption.sql — per-org AEAD encryption for provider secrets
--
-- ADR : docs/decisions/per-org-encryption-pgsodium.md
--
-- Every organization gets its own pgsodium AEAD-det key. Provider tokens are
-- encrypted/decrypted transparently via SQL helper functions. The app never
-- touches key material. DB dump without root key is useless. Per-org key
-- rotation and crypto-shred on org deletion are possible.
--
-- Objects created :
--   - extension pgsodium
--   - organizations.encryption_key_id   (NOT NULL uuid)
--   - trigger trg_org_create_encryption_key  (auto-create key on org INSERT)
--   - function encrypt_provider_secret(org_id, plaintext) → bytea
--   - function decrypt_provider_secret(org_id, ciphertext) → text
--   - view provider_admins_decrypted     (transparent decryption for reads)
--   - function upsert_provider_admin_encrypted(...)  (write path)
--   - function update_provider_admin_tokens(...)     (refresh path)
--   - data migration : re-encrypt existing plaintext bytea with org keys
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Enable pgsodium
-- ─────────────────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgsodium;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Add encryption_key_id to organizations
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE organizations ADD COLUMN encryption_key_id uuid;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Trigger: auto-create a pgsodium key when a new org is inserted
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION create_org_encryption_key()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pgsodium, public AS $$
DECLARE
  new_key_id uuid;
BEGIN
  SELECT id INTO new_key_id
  FROM pgsodium.create_key(
    name := 'org:' || NEW.id::text,
    key_type := 'aead-det'
  );
  NEW.encryption_key_id := new_key_id;
  RETURN NEW;
END;
$$;

ALTER FUNCTION create_org_encryption_key() OWNER TO supabase_admin;

CREATE TRIGGER trg_org_create_encryption_key
  BEFORE INSERT ON organizations
  FOR EACH ROW
  WHEN (NEW.encryption_key_id IS NULL)
  EXECUTE FUNCTION create_org_encryption_key();

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Backfill: create keys for existing orgs that don't have one
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  org_row RECORD;
  new_key_id uuid;
BEGIN
  FOR org_row IN SELECT id FROM organizations WHERE encryption_key_id IS NULL
  LOOP
    SELECT id INTO new_key_id
    FROM pgsodium.create_key(
      name := 'org:' || org_row.id::text,
      key_type := 'aead-det'
    );
    UPDATE organizations SET encryption_key_id = new_key_id WHERE id = org_row.id;
  END LOOP;
END;
$$;

-- Now make it NOT NULL
ALTER TABLE organizations ALTER COLUMN encryption_key_id SET NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Encrypt / decrypt helper functions
--
-- On Supabase hosted, the `postgres` role (used by the pooler) does not have
-- `pgsodium_keyholder`, which is required for crypto_aead_det_encrypt/decrypt.
-- The `supabase_admin` role DOES have it. We create the functions as postgres
-- (the migration runner) then ALTER OWNER to supabase_admin so the SECURITY
-- DEFINER context runs with the right privileges.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION encrypt_provider_secret(p_org_id uuid, p_plaintext text)
RETURNS bytea LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pgsodium, public AS $$
  SELECT pgsodium.crypto_aead_det_encrypt(
    convert_to(p_plaintext, 'utf8'),
    convert_to(p_org_id::text, 'utf8'),
    (SELECT encryption_key_id FROM organizations WHERE id = p_org_id)
  );
$$;

CREATE OR REPLACE FUNCTION decrypt_provider_secret(p_org_id uuid, p_ciphertext bytea)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pgsodium, public AS $$
  SELECT convert_from(
    pgsodium.crypto_aead_det_decrypt(
      p_ciphertext,
      convert_to(p_org_id::text, 'utf8'),
      (SELECT encryption_key_id FROM organizations WHERE id = p_org_id)
    ),
    'utf8'
  );
$$;

ALTER FUNCTION encrypt_provider_secret(uuid, text) OWNER TO supabase_admin;
ALTER FUNCTION decrypt_provider_secret(uuid, bytea) OWNER TO supabase_admin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Decrypted view for reads
-- ─────────────────────────────────────────────────────────────────────────────
-- The view uses our SECURITY DEFINER wrapper functions (not direct pgsodium
-- calls) so that any caller (including the service_role / postgres pooler
-- user that lacks pgsodium_keyholder) can read decrypted values.
CREATE VIEW provider_admins_decrypted
WITH (security_invoker = true)
AS
SELECT
  pa.id, pa.organization_id, pa.provider, pa.status,
  pa.installation_id, pa.team_id,
  CASE WHEN pa.access_token_encrypted IS NOT NULL
    THEN convert_to(
      decrypt_provider_secret(pa.organization_id, pa.access_token_encrypted),
      'utf8'
    )
  END AS access_token_encrypted,
  CASE WHEN pa.refresh_token_encrypted IS NOT NULL
    THEN convert_to(
      decrypt_provider_secret(pa.organization_id, pa.refresh_token_encrypted),
      'utf8'
    )
  END AS refresh_token_encrypted,
  pa.expires_at,
  pa.connected_by_user_id,
  pa.connected_at
FROM provider_admins pa;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Write RPC: upsert with encryption (used by OAuth callbacks)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION upsert_provider_admin_encrypted(
  p_org_id uuid,
  p_provider text,
  p_status text DEFAULT 'connected',
  p_installation_id text DEFAULT NULL,
  p_team_id text DEFAULT NULL,
  p_access_token text DEFAULT NULL,
  p_refresh_token text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL,
  p_connected_by uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  result_id uuid;
BEGIN
  INSERT INTO provider_admins (
    organization_id, provider, status, installation_id, team_id,
    access_token_encrypted, refresh_token_encrypted,
    expires_at, connected_by_user_id, connected_at
  ) VALUES (
    p_org_id, p_provider, p_status, p_installation_id, p_team_id,
    CASE WHEN p_access_token IS NOT NULL THEN encrypt_provider_secret(p_org_id, p_access_token) END,
    CASE WHEN p_refresh_token IS NOT NULL THEN encrypt_provider_secret(p_org_id, p_refresh_token) END,
    p_expires_at, p_connected_by, now()
  )
  ON CONFLICT (organization_id, provider) DO UPDATE SET
    status = EXCLUDED.status,
    installation_id = COALESCE(EXCLUDED.installation_id, provider_admins.installation_id),
    team_id = COALESCE(EXCLUDED.team_id, provider_admins.team_id),
    access_token_encrypted = EXCLUDED.access_token_encrypted,
    refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
    expires_at = EXCLUDED.expires_at,
    connected_by_user_id = EXCLUDED.connected_by_user_id,
    connected_at = EXCLUDED.connected_at
  RETURNING id INTO result_id;
  RETURN result_id;
END;
$$;

ALTER FUNCTION upsert_provider_admin_encrypted(uuid, text, text, text, text, text, text, timestamptz, uuid) OWNER TO supabase_admin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Write RPC: update tokens only (used by refresh flows)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_provider_admin_tokens(
  p_admin_id uuid,
  p_access_token text,
  p_refresh_token text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org_id uuid;
BEGIN
  SELECT organization_id INTO v_org_id FROM provider_admins WHERE id = p_admin_id;
  IF v_org_id IS NULL THEN RAISE EXCEPTION 'provider_admin not found: %', p_admin_id; END IF;

  UPDATE provider_admins SET
    access_token_encrypted = encrypt_provider_secret(v_org_id, p_access_token),
    refresh_token_encrypted = CASE
      WHEN p_refresh_token IS NOT NULL THEN encrypt_provider_secret(v_org_id, p_refresh_token)
      ELSE refresh_token_encrypted
    END,
    expires_at = COALESCE(p_expires_at, expires_at)
  WHERE id = p_admin_id;
END;
$$;

ALTER FUNCTION update_provider_admin_tokens(uuid, text, text, timestamptz) OWNER TO supabase_admin;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Data migration: re-encrypt existing plaintext bytea data
--
-- Uses our SECURITY DEFINER wrapper (owned by supabase_admin) to avoid the
-- pgsodium_keyholder permission issue on the pooler postgres role.
-- Existing bytea holds raw UTF-8 of the plaintext token — convert_from
-- extracts the text, then encrypt_provider_secret encrypts it.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE provider_admins pa SET
  access_token_encrypted = CASE
    WHEN pa.access_token_encrypted IS NOT NULL THEN
      encrypt_provider_secret(
        pa.organization_id,
        convert_from(pa.access_token_encrypted, 'utf8')
      )
  END,
  refresh_token_encrypted = CASE
    WHEN pa.refresh_token_encrypted IS NOT NULL THEN
      encrypt_provider_secret(
        pa.organization_id,
        convert_from(pa.refresh_token_encrypted, 'utf8')
      )
  END
WHERE pa.access_token_encrypted IS NOT NULL
   OR pa.refresh_token_encrypted IS NOT NULL;
