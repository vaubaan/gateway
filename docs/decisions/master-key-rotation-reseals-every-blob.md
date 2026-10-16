---
title: A master-key rotation seals every stored blob again, with a command shipped in the image
status: accepted
date: 2026-10-13
extends:
  - trust-model-clear-at-rest-idp-style
  - docker-image-and-config-format
  - import-from-v4-one-shot-importer
  - railway-deployment-and-privilege-dropping-entrypoint
---

# A master-key rotation seals every stored blob again, with a command shipped in the image

> **Amendment of 2026-10-15 (re-check of fix/v5-sec-2).** Four changes before the
> first production run:
>
> - **Every blob is opened, the current ones too.** A blob already under the
>   current version is opened (never written) and counted `current unreadable`
>   when it does not open; exit 1. A new key set without raising its version
>   otherwise read as "nothing to do".
> - **The dry run states the verdict.** "nothing to reseal: every blob is sealed
>   under version N … VAUBAAN_MASTER_KEY_PREVIOUS can now be removed" is printed
>   by any run — dry or applied — that finds nothing stale, unreadable or changed;
>   "run with --apply" only when something is left to reseal.
> - **A boot check, a warning not a refusal.** At start the instance opens one
>   blob per table and key version (`sealedBlobs.probe()`) and logs at `error`
>   each version that no configured key opens. It does not refuse to start: the
>   operator needs the instance up (health, logs, the reseal and backup
>   commands) to see and fix the variables, what cannot be opened already fails
>   call by call, and a refusal would turn one stale approval argument into an
>   outage. Rejected: refusing to boot.
> - **A backup command ships too** (`apps/gateway/backup.mjs`, read-only
>   `VACUUM INTO` beside the store, never overwrites, integrity-checked, names the
>   key versions its copy needs). The procedure starts with it (step 0).

## Context

Three columns of the store hold AEAD blobs sealed with a key derived from the
master key: `connections.credential_blob`, `instance_config.secret_blob` and
`requests.args_blob`. Each row records the `key_version` that sealed it.
Rotation, until now, meant: set a new `VAUBAAN_MASTER_KEY` with a higher
`VAUBAAN_MASTER_KEY_VERSION`, keep the old key in `VAUBAAN_MASTER_KEY_PREVIOUS`.
New blobs used the new key; every old blob still needed the old key, forever.

The security review of 2026-10-15 (secrets-and-infra H2) showed what that
means after a suspected leak — a key printed into a transcript, a workspace
member who left, a lost laptop: rotating changes nothing for the credentials
already stored, and the leaked key has to stay in the configuration (and so
in the platform's variables and `/proc/1/environ`) or the instance cannot open
its own connections. "A database copy without the master key opens nothing"
was true only of a key that was never exposed.

## Decision

1. **A `reseal` command ships in the image** beside the server, at
   `apps/gateway/reseal.mjs`, bundled like the v4 importer
   (`scripts/build-commands.mjs`, renamed from `build-import-v4.mjs` now that
   it builds two commands). It runs inside the container, with the instance's
   own configuration, refuses root (prefix `vaubaan-entrypoint` on a platform
   that starts as root), and opens the store file of `store.path`.
2. **What it does.** For each sealed column, every blob whose `key_version`
   differs from the current one is opened with the key of its version (current
   or `previous_keys`) and sealed under the current key, with the same
   associated data. The repository that knows the three columns and their
   associated data is `store.sealedBlobs`
   (`store/repositories/sealed-blobs.ts`): one list, used by the command and
   its tests, so a fourth sealed column is added in one place.
3. **Dry run by default.** Without `--apply` every blob is still opened (the
   report proves the configured keys fit) and nothing is written. With
   `--apply`, the blobs of a table are written in one `BEGIN IMMEDIATE`
   transaction.
4. **Safe beside the running gateway.** Opening and sealing happen outside the
   transaction (the encryptor is asynchronous, the driver synchronous); each
   write is a compare-and-swap on the exact blob and version read. A row the
   gateway rewrote meanwhile (a refreshed OAuth token, an erased approval
   argument) is left as the gateway wrote it and counted `changed`; a second
   run picks it up. The command is idempotent: a run with nothing stale writes
   nothing.
5. **The report counts, never shows.** Per table: current, resealed (or to
   reseal), unreadable, changed. It ends with what to do next: remove
   `VAUBAAN_MASTER_KEY_PREVIOUS` once no blob remains under another version,
   or keep it and why. A blob that does not open (no key for its version, or
   the wrong key under that version) is counted and left alone; the exit code
   is then 1. No error message is printed for a blob: it can say nothing
   useful and must quote nothing.
6. **The procedure** (handbook configuration, "Rotating the master key";
   `deploy/railway.md` §8): set the new key and version and move the old key
   to `VAUBAAN_MASTER_KEY_PREVIOUS` → deploy → `reseal` (dry run, then
   `--apply`, then a dry run that shows nothing to reseal) → remove the
   previous key → deploy.
7. **No audit entry.** The command runs from a shell inside the container,
   outside the identity model of the instance (there is no user to name), and
   changes nobody's access. The platform records the shell session; the
   command's report is the record.

## Consequences

- After a rotation and a reseal, the old key opens nothing in the current
  store. It still opens every **backup** taken before the reseal: the
  procedure says to treat such backups as sealed under the old key (keep the
  old key with them, or destroy them).
- A second `reseal` run is the confirmation step; operators read "every blob
  is sealed under version N" before they remove the previous key.
- The running gateway needs both keys during the window between the first
  deploy and the reseal; nothing changes for it otherwise (it already opens
  blobs of any configured version).
- The encryptor port is unchanged; the store gained one repository.

## Rejected alternatives

- **Re-seal at boot.** Every restart would rewrite every stale blob, the
  instance would need a write lock at start-up while serving, and a missing
  key would turn a boot into a partial migration. An explicit command, run
  once, with a dry run, is easier to reason about and to repeat.
- **Lazy re-seal on read** (rewrite a blob whenever it is opened under an old
  version). Blobs that are never read — a connection nobody uses — would stay
  under the old key indefinitely, so the operator could never know when the
  previous key may go.
- **Document "reconnect every account" as the rotation.** Works without code
  but loses every resource curation and grant, and still leaves instance
  secrets (company apps, the IdP secret) and pending approval arguments under
  the old key.
- **One transaction across all three tables.** Holding the write lock across
  tables brings nothing: each row is independent (its own associated data),
  and the compare-and-swap already makes a partial run safe to repeat.
