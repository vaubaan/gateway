---
title: Per-org encryption at rest via pgsodium
status: superseded
date: 2026-06-16
supersedes: trust-model-clear-at-rest-idp-style.md (the "clear-at-rest" aspect only — the IdP trust model itself stays)
superseded-by: per-org-encryption-app-level.md
---

# Per-org encryption at rest via pgsodium

## Contexte

v0 stored provider OAuth tokens in `provider_admins.access_token_encrypted`
and `refresh_token_encrypted` as **plaintext UTF-8 in bytea columns** -- no
actual encryption existed despite the column names. A DB dump or backup
compromise would expose every customer's cloud provider tokens in cleartext.

The ADR `trust-model-clear-at-rest-idp-style.md` acknowledged this gap and
planned Supabase Vault (pgsodium) encryption. Code comments said
"v0 doesn't actually encrypt yet (no Vault wired)".

We need encryption at rest that:

1. Isolates blast radius per organization (one key compromise should not
   expose all orgs).
2. Enables crypto-shredding on org deletion (delete the key, ciphertext
   becomes irrecoverable).
3. Keeps key material outside app memory (the app never sees the raw
   symmetric key).

## Décision

**Per-org encryption via pgsodium AEAD deterministic mode.** Each
organization gets its own pgsodium key, created automatically at INSERT via a
BEFORE INSERT trigger. Encryption and decryption happen exclusively in SQL
via `SECURITY DEFINER` functions.

Implementation details (migration `0037_per_org_encryption.sql`):

- **Key lifecycle**: `organizations.encryption_key_id` (NOT NULL uuid) points
  to a `pgsodium.key` row. The BEFORE INSERT trigger
  `trg_org_create_encryption_key` calls `pgsodium.create_key(name :=
'org:<uuid>', key_type := 'aead-det')`. Existing orgs are backfilled in the
  migration.

- **Encrypt/decrypt helpers**: `encrypt_provider_secret(org_id, plaintext)`
  and `decrypt_provider_secret(org_id, ciphertext)`. Both are `SECURITY
DEFINER` with `SET search_path = pgsodium, public`. The `additional_data`
  parameter is the org UUID as UTF-8, which prevents cross-org ciphertext
  reuse.

- **Read path**: A `provider_admins_decrypted` view (`security_invoker =
true`) JOINs `provider_admins` with `organizations` and calls
  `crypto_aead_det_decrypt` inline. Only queries that need token values
  select from this view; metadata-only queries (`status`, `installation_id`,
  etc.) stay on `provider_admins` to avoid unnecessary decryption.

- **Write path**: Two RPC functions replace direct `.upsert()` / `.update()`
  from the app:
  - `upsert_provider_admin_encrypted(...)` -- used by OAuth callbacks.
  - `update_provider_admin_tokens(...)` -- used by refresh flows.

  The app sends plaintext tokens as function parameters over the TLS
  connection to Supabase; encryption happens in the SQL function before the
  UPDATE/INSERT touches disk.

- **Data migration**: Existing plaintext bytea rows are re-encrypted in-place
  by the migration's final UPDATE statement.

## Conséquences

**Positive:**

- **DB dump without root key is useless.** The pgsodium root key is managed
  by Supabase and is not present in the DB dump; ciphertext in
  `provider_admins` is opaque.
- **Per-org blast radius.** Compromise of one org's key exposes only that
  org's secrets. The root key wraps all org keys, so root compromise is still
  total -- but org-level isolation covers the more common "single org
  breach" scenario.
- **Crypto-shred on org deletion.** Delete the org's pgsodium key and all
  its provider secrets become irrecoverable, even if the ciphertext
  persists in backups.
- **Key material never in app memory.** The app sends and receives plaintext
  over TLS to Supabase; the symmetric key only exists inside Postgres
  process memory during the encrypt/decrypt call.
- **Per-org key rotation possible.** Re-encrypt an org's secrets with a new
  key by creating a new key, decrypting with the old, encrypting with the
  new, and updating `encryption_key_id`.
- **Minimal app code change.** Read paths swap `provider_admins` for
  `provider_admins_decrypted`; write paths swap `.upsert()` for `.rpc()`.
  No type changes needed.

**Negative / costs assumed:**

- **Decryption cost on every read.** The `provider_admins_decrypted` view
  runs `crypto_aead_det_decrypt` per row. Acceptable given the low
  cardinality (max 5 providers per org) and infrequent access pattern.
- **pgsodium extension dependency.** Must be enabled on the Supabase
  project. Already available on all Supabase plans but adds an extension to
  the migration chain.
- **Root key compromise is still total.** pgsodium's root key wraps all
  derived keys. This is a known limitation of the Supabase Vault model --
  for higher assurance, an external KMS would be needed (deferred to v2+).

## Alternatives rejetées

- **Single global key.** Simpler but no blast radius isolation -- one key
  compromise exposes all orgs. No crypto-shred per org. Rejected.

- **Application-level encryption (e.g. libsodium in Node).** Key material
  would live in app memory and in env vars, defeating the purpose of
  at-rest encryption. If the app runtime is compromised the attacker has the
  key. With SQL-level encryption the key never leaves Postgres. Rejected.

- **External KMS (AWS KMS, GCP Cloud KMS, HashiCorp Vault).** Same trust
  boundary as pgsodium since compute and storage both run on Supabase's
  infrastructure. Adds operational complexity (another service to manage) with
  no meaningful security improvement for the current deployment model.
  Reconsidered for v2+ if we move to self-hosted Postgres. Rejected for MVP.

- **Full Zero-Knowledge model.** Incompatible with the proxy architecture:
  the gateway must decrypt tokens to proxy upstream calls. This was already
  decided in `trust-model-clear-at-rest-idp-style.md`. Rejected.
