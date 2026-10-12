---
title: Per-org encryption at rest via app-level libsodium
status: partially-superseded
date: 2026-06-16
supersedes: per-org-encryption-pgsodium.md
partially-superseded-by: pivot-v4-to-v5-on-prem-mission-tokens
superseded-date: 2026-10-12
---

> **Partially superseded on 2026-10-12** by [[pivot-v4-to-v5-on-prem-mission-tokens]], which names the parts that survive. Legacy v4 decision; body unchanged.

# Per-org encryption at rest via app-level libsodium

## Contexte

v0 stored provider OAuth tokens in `provider_admins.access_token_encrypted`
and `refresh_token_encrypted` as **plaintext UTF-8 in bytea columns** -- no
actual encryption existed despite the column names.

The previous ADR (`per-org-encryption-pgsodium.md`) attempted to solve this
with pgsodium AEAD encryption inside Postgres. That approach failed in
production due to **Supabase hosted permission constraints**:

- The session pooler cannot `SET ROLE supabase_admin` or `ALTER FUNCTION
OWNER TO supabase_admin`.
- `supabase_admin` cannot `GRANT pgsodium_keyholder TO postgres` (no ADMIN
  OPTION on that role).
- The direct DB connection (`db.<ref>.supabase.co`) is IPv6-only and
  unreachable from GitHub Actions runners.

These constraints make pgsodium unusable for any deployment that relies on
the Supabase session pooler, which includes all standard CI/CD setups and
the pooler-based connection used by the Next.js runtime.

We still need encryption at rest that:

1. Isolates blast radius per organization.
2. Enables crypto-shredding on org deletion.
3. Is portable -- works on any Postgres, any hosting, no extensions.
4. Is reproducible -- fully automated CI, no manual Dashboard steps.

## Décision

**App-level encryption via `libsodium-wrappers`** (the JS binding for
libsodium -- the same cryptographic library that pgsodium wraps).

Implementation (`packages/web/src/lib/crypto/provider-secrets.ts`):

- **Algorithm**: XChaCha20-Poly1305 AEAD
  (`crypto_aead_xchacha20poly1305_ietf`). 256-bit key, 192-bit nonce,
  built-in authentication tag. The extended nonce makes random nonce
  collision negligible.

- **Master key**: `ENCRYPTION_MASTER_KEY` environment variable, 32 random
  bytes base64-encoded. One key per deployment. Generate with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.

- **Per-org key derivation**: `crypto_kdf_derive_from_key(32, subkeyIndex,
'vaubaan_', masterKey)` where `subkeyIndex = SHA-256(orgId)[0..3]` as
  uint32. Each org gets a deterministically derived but unique symmetric key.

- **AAD (additional authenticated data)**: the org UUID as UTF-8. Prevents
  cross-org ciphertext replay -- decrypting org A's ciphertext with org B's
  key fails even if the derived keys happen to collide (they won't, but the
  AAD is a defense-in-depth layer).

- **Storage format**: `nonce (24 bytes) || ciphertext` stored as bytea in the
  existing `access_token_encrypted` / `refresh_token_encrypted` columns. No
  schema change needed.

- **Write path**: OAuth callbacks and refresh flows encrypt in Node.js before
  `.upsert()` / `.update()` via the standard Supabase JS client. No SQL RPC
  functions needed.

- **Read path**: `loadProviderAdmin` and `loadProviderState` decrypt after
  reading from `provider_admins`. Metadata-only queries
  (`loadAccessTokenContext`) stay on the raw table and never touch token
  columns.

- **Data migration**: `scripts/migrate-encrypt-tokens.ts` -- a one-shot
  Node.js script that reads existing plaintext bytea rows, encrypts them,
  and writes back. Idempotent (attempts decrypt first to skip already-
  migrated rows).

## Conséquences

**Positive:**

- **Portable.** Works on any Postgres, any hosting. No extensions, no special
  roles, no pgsodium dependency. OSS-friendly.
- **CI-friendly.** Migration `0037` is a simple DROP of pgsodium artifacts.
  No `SET ROLE`, no `GRANT`, no manual Dashboard steps.
- **Same crypto as pgsodium.** Both use libsodium under the hood.
  XChaCha20-Poly1305 is the same primitive family. Audit trail is
  continuous.
- **Per-org blast radius.** Each org has its own derived key. Compromise of
  one derived key exposes only that org. Master key compromise is still
  total -- same as pgsodium's root key.
- **DB dump without `ENCRYPTION_MASTER_KEY` is useless.** The env var lives
  on the compute side (Vercel, Docker, etc.), not in the database.

**Negative / costs assumed:**

- **Master key in app memory.** The key is loaded from an env var and lives
  in Node.js process memory. If the runtime is compromised, the attacker
  has the key. With pgsodium the key stayed in Postgres process memory --
  same risk profile, different process boundary. On Supabase hosted both
  Postgres and the app run on Supabase infrastructure, so the trust
  boundary is identical.
- **Crypto-shred less elegant.** With pgsodium, deleting a single org's key
  made its ciphertext irrecoverable. With KDF-derived keys, shredding
  requires rotating the master key and re-encrypting all orgs except the
  target. Functional but heavier.
- **Key rotation requires re-encryption.** Changing `ENCRYPTION_MASTER_KEY`
  means re-encrypting every org's tokens. A migration script handles this,
  but it is an operational step.

## Alternatives rejetées

- **pgsodium in Postgres.** Permission constraints on Supabase hosted make
  this undeployable via CI. The session pooler blocks `SET ROLE`, `ALTER
FUNCTION OWNER`, and `GRANT pgsodium_keyholder`. The direct connection is
  IPv6-only and unreachable from GitHub runners. Rejected for portability
  and operability.

- **Single global key (no per-org derivation).** Simpler but no blast radius
  isolation. One key compromise exposes all orgs. Rejected.

- **External KMS (AWS KMS, GCP Cloud KMS, HashiCorp Vault).** Same trust
  boundary as the app-level approach since compute and storage both run on
  Supabase/Vercel infrastructure. Adds operational complexity with no
  meaningful security improvement for the current deployment model.
  Reconsidered for v2+ if we move to self-hosted infra. Rejected for MVP.

- **Supabase Vault (`vault.create_secret`).** Works from the pooler but uses
  a single internal key -- no per-org isolation, no per-org crypto-shred.
  Rejected.

- **Full Zero-Knowledge model.** Incompatible with the proxy architecture:
  the gateway must decrypt tokens to proxy upstream calls. Already decided
  in `trust-model-clear-at-rest-idp-style.md`. Rejected.
