-- Migration 0017 — a connection's default environment label for its unlabelled
-- resources (spec §0 "Resource"; ADR connection-default-environment-label).
--
--   connections.default_env   an environment label (`ENV_LABEL_PATTERN`) the owner
--                             chose among the labels of the provider's catalog;
--                             NULL (the default) keeps the earlier behaviour: an
--                             unlabelled resource carries no environment.
--
-- The effective environment of a resource is `connection_resources.env` when set,
-- else this column. It is computed on read by the repository; the column of the
-- resource keeps the resource's own label, never a copy of the default.
--
-- Portable SQL: one nullable `ADD COLUMN`, no default, no backfill.

ALTER TABLE connections ADD COLUMN default_env TEXT;
