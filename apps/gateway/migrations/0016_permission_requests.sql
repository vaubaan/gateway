-- Widen request kinds while preserving every request, sealed blob and approval.
-- Children are copied and dropped first; foreign-key enforcement stays enabled.
CREATE TEMP TABLE saved_requests AS SELECT * FROM requests;
CREATE TEMP TABLE saved_approvals AS SELECT * FROM approvals;
DROP TABLE approvals;
DROP TABLE requests;
CREATE TABLE requests (
  id                  TEXT NOT NULL PRIMARY KEY,
  mission_id          TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  session_id          TEXT REFERENCES sessions (id) ON DELETE SET NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('claim', 'approval', 'permission')),
  state               TEXT NOT NULL CHECK (state IN ('open', 'granted', 'refused', 'expired')),
  risk_id             TEXT NOT NULL,
  tool                TEXT,                   -- observed call for approval and permission requests
  fingerprint         TEXT,                   -- sha256 of the canonical arguments
  args_blob           BLOB,                   -- AEAD blob, associated data = request id; erased on decision/expiry
  key_version         INTEGER,
  created_at          TEXT NOT NULL,
  expires_at          TEXT NOT NULL,
  decided_at          TEXT,
  decided_by_user_id  TEXT REFERENCES users (id),
  risk_ids_json       TEXT,
  decision_json       TEXT,                   -- creator's answer (extension amount, gate opened…)
  CHECK (kind = 'claim' OR (tool IS NOT NULL AND fingerprint IS NOT NULL)),
  CHECK (args_blob IS NULL OR key_version IS NOT NULL),
  CHECK (state <> 'open' OR decided_at IS NULL)
) STRICT; -- sqlite: STRICT

CREATE INDEX requests_mission_state ON requests (mission_id, state);
CREATE INDEX requests_open_expiry   ON requests (expires_at) WHERE state = 'open';

CREATE TABLE approvals (
  id           TEXT NOT NULL PRIMARY KEY,
  mission_id   TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
  request_id   TEXT NOT NULL UNIQUE REFERENCES requests (id),
  risk_id      TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  consumed_at  TEXT,
  tool         TEXT NOT NULL DEFAULT '',
  risk_ids_json TEXT
) STRICT; -- sqlite: STRICT

CREATE INDEX approvals_lookup ON approvals (mission_id, tool, fingerprint) WHERE consumed_at IS NULL;


INSERT INTO requests (id, mission_id, session_id, kind, state, risk_id, tool, fingerprint, args_blob, key_version, created_at, expires_at, decided_at, decided_by_user_id, decision_json, risk_ids_json) SELECT id, mission_id, session_id, kind, state, risk_id, tool, fingerprint, args_blob, key_version, created_at, expires_at, decided_at, decided_by_user_id, decision_json, risk_ids_json FROM saved_requests;
INSERT INTO approvals (id, mission_id, request_id, risk_id, fingerprint, created_at, expires_at, consumed_at, tool, risk_ids_json) SELECT id, mission_id, request_id, risk_id, fingerprint, created_at, expires_at, consumed_at, tool, risk_ids_json FROM saved_approvals;
DROP TABLE saved_approvals;
DROP TABLE saved_requests;

CREATE TABLE permission_refusals (
  id TEXT NOT NULL PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES mission_tokens(id),
  holder TEXT NOT NULL,
  tool TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  risk_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  request_id TEXT REFERENCES requests(id)
) STRICT;
CREATE INDEX permission_refusals_expiry ON permission_refusals(expires_at);
CREATE TABLE permission_requests (
  request_id TEXT NOT NULL PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,
  token_id TEXT NOT NULL REFERENCES mission_tokens(id),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 1000),
  risk_set TEXT NOT NULL
) STRICT;
