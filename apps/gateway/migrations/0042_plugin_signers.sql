-- The signers an instance trusts for its private plugins (ADR
-- plugin-signature-sets-the-trust-level; spec §4.2 Administration › Plugins): a company's
-- ed25519 public key, named, added by an administrator. An archive signed by one of them is
-- shown "signed by <name>", never "Vaubaan"; the catalog's own signature needs no row.
CREATE TABLE plugin_signers (
  key_id TEXT PRIMARY KEY CHECK (key_id LIKE 'sha256:%' AND length(key_id) = 71),
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  public_key_pem TEXT NOT NULL,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL
) STRICT;
