-- Migration 0034 — who decided a resource is hidden (ADR
-- connect-driver-and-resource-curation, amendment 2026-11-14).
--
--   connection_resources.hidden_edited  1 once the owner hid or showed the resource:
--                                       discovery then never changes `hidden`. While 0,
--                                       `hidden` follows the plugin's hint at every
--                                       discovery (`hiddenByDefault`: a public GitHub
--                                       repository the token most likely cannot act on).
--
-- Before this migration only the owner wrote `hidden`: a hidden row was the owner's
-- choice (edited), a visible one is indistinguishable from untouched and takes the hint
-- at its next discovery.
--
-- Portable SQL: plain `ADD COLUMN` with a constant default and a CHECK, then an UPDATE.

ALTER TABLE connection_resources ADD COLUMN hidden_edited INTEGER NOT NULL DEFAULT 0
  CHECK (hidden_edited IN (0, 1));

UPDATE connection_resources SET hidden_edited = 1 WHERE hidden = 1;
