-- Installed plugins (ADR plugins-activated-by-an-administrator-on-trial; spec §4.2
-- Administration › Plugins; handbook plugin-loading). One row per archive an
-- administrator uploaded or installed, by the sha256 of its bytes, whose files sit in
-- `<data dir>/plugins/<digest>/`. At most one version of a plugin is `active` and at most
-- one starts on `trial`; the start records what a trial became.
--
--   pending   uploaded, inert: nothing of it runs until an administrator activates it
--   trial     activated: the next start loads it on trial
--   active    the version the instance runs
--   previous  was active, kept to go back to
--   failed    did not load (its trial, or a later start); `failure` says why
--   refused   an administrator refused it while pending
--   removed   no longer kept; its folder is deleted
CREATE TABLE plugin_versions (
  digest TEXT PRIMARY KEY CHECK (length(digest) = 64),
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  package_name TEXT NOT NULL,
  sdk_range TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('unsigned', 'vaubaan', 'signer')),
  signer TEXT,
  risk_ids_json TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'trial', 'active', 'previous', 'failed', 'refused', 'removed')),
  failure TEXT,
  uploaded_at TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  via_mission_id TEXT,
  changed_at TEXT NOT NULL,
  changed_by TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX plugin_versions_one_active ON plugin_versions (plugin_id) WHERE state = 'active';
CREATE UNIQUE INDEX plugin_versions_one_trial ON plugin_versions (plugin_id) WHERE state = 'trial';
CREATE INDEX plugin_versions_by_plugin ON plugin_versions (plugin_id, changed_at);
