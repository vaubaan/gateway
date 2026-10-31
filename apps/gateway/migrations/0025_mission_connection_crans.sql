-- Migration 0025 — the trust cran of each macro-action a mission was composed from
-- (risk model §4.7; ADR macro-actions-and-trust-crans-prefill-the-policy).
--
--   mission_connections.crans_json   a JSON object, macro-action id → cran
--                                    (`prudent`, `confiant`, `autonome`), as the
--                                    creation or edit form ticked them; NULL when
--                                    none was recorded (missions issued before, by
--                                    an agent without crans, or by hand line by line).
--
-- Display only: it redraws the form. The policy stays the explicit lines of
-- `mission_policy`; no check reads this column.
--
-- Portable SQL: one nullable `ADD COLUMN`, no default, no backfill.

ALTER TABLE mission_connections ADD COLUMN crans_json TEXT;
