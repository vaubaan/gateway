---
title: Upstash Redis provider plugin
tracks:
  - plugins/upstash-redis/src/
  - plugins/upstash-redis/README.md
last_reviewed: 2026-10-27
---

# Upstash Redis provider plugin — handbook

`@vaubaan/plugin-upstash-redis`: Upstash Management API and each database's REST data API under one
plane, the database as resource, its owner label as environment. No upstream MCP server.

## Start here

- [`src/classify.ts`](../../../plugins/upstash-redis/src/classify.ts) — the command table of
  `execute` (six verb sets), `resolveDatabase`, `redisCommandOf`.
- [`src/execute.ts`](../../../plugins/upstash-redis/src/execute.ts) — the pinned REST endpoint,
  redaction, discovery.
- [`tests/unit/command-table.test.ts`](../../../plugins/upstash-redis/tests/unit/command-table.test.ts)
  — one class per command, deletions in disguise.

## Invariants

- **The same Redis command costs the same risk whichever tool carries it**, and a command the
  classifier cannot read is never cheaper than the catch-all (`execute-arbitrary`). Each verb is in
  exactly one set; a verb in two fails the import, so the gateway does not boot.
- **Whatever makes data go away, now or later, is a deletion**: every expiry, relative or absolute
  (a one-second TTL is a deletion in all but name); the moves (`RENAME`, `LMOVE`…); `*STORE` and
  `BITOP` (an empty result deletes the destination). Writes escalated by an argument
  (`ESCALATIONS`): `SET … EX|PX|EXAT|PXAT`, `XADD … MAXLEN`, `SORT … STORE`; an option name where a
  value may sit counts as the option. The `set` tool with `ex` / `px` present, whatever the value.
- Verbs are read as ASCII `[A-Za-z][A-Za-z0-9._-]*`, then case-insensitive: `ſet` or `ınfo` is
  unknown. A command is a flat non-empty array of strings or finite numbers, else unreadable →
  catch-all. Pipelines and MULTI bodies cost the union; the executor refuses them anyway, but the
  classification does not rely on it.
- **The REST endpoint is pinned to Upstash**: the token is posted there, so the Management API
  answer does not choose the destination; `restEndpointOf` rebuilds `https://<label>.upstash.io`
  from one DNS label.
- Management answers lose every credential-like field at any depth (`CREDENTIAL_LIKE_FIELD`); the
  REST token is never returned.
- The database ref is the only identifier in a URL: refused outside `pathIdent`, never escaped
  (`/redis/database/..` would become `/redis/`,
  [ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)). Keys travel in
  the JSON body; a key the slice grammar cannot carry becomes `[*]` (audit precision only).

## Traps

- `write-data` still overwrites: writing or renaming over a key destroys the old value without
  `delete-data`. That is a Redis write.
- `execute-arbitrary` accepts everything in its environment: scripts are not read.
- A cache write with a TTL needs `delete-data` next to `write-data`; on prod under `operator` it
  waits for approval.
- The environment label is `development`, not `dev`: an unlabelled or mislabelled database refuses
  every write.
- Without a `databaseId`, the single database applies to data tools only; a management tool acts on
  the database the call names.

## Outside the repo

- Credential: the account `email` and a Read/Write Developer API key (Upstash console → Account →
  Developer API), with an expiry Upstash does not say back. Checked at paste with `GET /v2/teams`.
  No refresh. Accounts made through Vercel or Fly have no Developer API.

## Procedures

- **A harmless verb lands on `execute-arbitrary`**: add it to exactly one set in `classify.ts`
  (`KNOWN_READS` only if no argument can make it write), add a row to `command-table.test.ts`, bump
  the plugin minor version.
- **A new Upstash REST domain**: change `restEndpointOf` with its tests.

## Debug

- `the Management API named a host that is not an Upstash REST endpoint` → nothing was sent; see the
  procedure above.
- `DEL`, `LPOP`, `EXPIRE k 60`, `SET k v EX 60`, `RENAME` refused for `delete-data` → intended.
- `mockFetch: unexpected POST https://…upstash.io` in a test → the data route must match the pinned
  endpoint.
