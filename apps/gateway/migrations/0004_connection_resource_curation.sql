-- Migration 0004 — owner curation of connection resources (spec §0 "Resource", §4.2
-- "Connections": "their resources with environment labels (edit, refresh discovery)").
--
-- A resource row now keeps apart what the provider says (refreshed by every
-- discovery) and what the owner decided (never touched by discovery, P1.4):
--
--   metadata_json        provider facts the plugin returned at the last discovery
--   owner_metadata_json  owner edits over those facts (Resend recipient zones…);
--                        the effective metadata is the provider facts overlaid by these
--   env_source           'plugin' when the plugin itself set `env` at discovery
--                        (Stripe test|live): the label is then read-only for the owner
--   display_name_edited  1 once the owner renamed the resource: discovery keeps the name
--   hidden               1 when the owner hid the resource from mission issuance
--   stale_since          set when a discovery no longer returns the ref; the row is
--                        kept (missions may select it) and cleared when the ref returns
--
-- Portable SQL: plain `ADD COLUMN` with constant defaults and CHECKs.

ALTER TABLE connection_resources ADD COLUMN metadata_json TEXT;
ALTER TABLE connection_resources ADD COLUMN owner_metadata_json TEXT;
ALTER TABLE connection_resources ADD COLUMN env_source TEXT NOT NULL DEFAULT 'owner'
  CHECK (env_source IN ('owner', 'plugin'));
ALTER TABLE connection_resources ADD COLUMN display_name_edited INTEGER NOT NULL DEFAULT 0
  CHECK (display_name_edited IN (0, 1));
ALTER TABLE connection_resources ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0
  CHECK (hidden IN (0, 1));
ALTER TABLE connection_resources ADD COLUMN stale_since TEXT;
