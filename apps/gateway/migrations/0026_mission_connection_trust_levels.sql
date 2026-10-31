-- Migration 0026 — the trust levels a mission was composed from, under their English names
-- (risk model §4.6; ADR macro-actions-and-trust-levels-prefill-the-policy, History).
--
--   mission_connections.crans_json   renamed `trust_levels_json`: a JSON object,
--                                    macro-action id → trust level, as the creation
--                                    or edit form ticked them; NULL when none was
--                                    recorded.
--
-- The values are rewritten to the new ids: `prudent` → `careful`, `confiant` →
-- `trusting`, `autonome` → `autonomous`. The column is display only (it redraws the
-- form; the policy stays the explicit lines of `mission_policy`), but a value the
-- gateway no longer knows would be dropped when the form reads it back, so a mission
-- keeps its recorded levels across the upgrade.
--
-- Portable SQL: `RENAME COLUMN` (SQLite ≥ 3.25, Postgres) and one `UPDATE` with
-- `REPLACE` on the quoted values (`JSON.stringify` writes them; no macro-action id
-- of a shipped catalog, the keys, is one of the three).

ALTER TABLE mission_connections RENAME COLUMN crans_json TO trust_levels_json;

UPDATE mission_connections
SET trust_levels_json =
  REPLACE(
    REPLACE(
      REPLACE(trust_levels_json, '"prudent"', '"careful"'),
      '"confiant"', '"trusting"'),
    '"autonome"', '"autonomous"')
WHERE trust_levels_json IS NOT NULL;
