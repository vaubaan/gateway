---
title: A restore verifies a store copy before it replaces anything, and runs at first boot from the configuration
status: accepted
date: 2026-10-16
extends:
  - embedded-store-sqlite-and-migrations
  - master-key-rotation-reseals-every-blob
  - secrets-leave-the-process-environment-after-load
  - railway-deployment-and-privilege-dropping-entrypoint
---

# A restore verifies a store copy before it replaces anything, and runs at first boot from the configuration

## Context

The image ships `backup` (a consistent `VACUUM INTO` copy of the store, ADR
[master-key-rotation-reseals-every-blob](master-key-rotation-reseals-every-blob.md),
amendment) but nothing that puts a copy back. Moving an instance to another
host — from Railway to a new Fly machine, to another server, or back from
a backup — meant
dropping a file on the new volume by hand (`machine exec`, `railway ssh`,
`docker cp`) while the server was stopped, with nothing checking that the file
was the one meant, that it was a sound store, that this image could migrate it,
or that this instance's keys opened what it holds. A wrong file, or a store
whose keys were left behind, is found only once people cannot use their
accounts.

A new machine of a platform such as Fly or Railway starts the server on its
first boot: there is no moment, before the server opens (and so creates) an
empty store, when an operator can place a file without a shell trick.

## Decision

1. **A `restore` command ships in the image** beside `backup` and `reseal`
   (`apps/gateway/restore.mjs`, `server/restore/`, bundled by
   `scripts/build-commands.mjs`). It refuses root (prefix `vaubaan-entrypoint`),
   reads the instance's configuration and writes only in the directory of
   `store.path`.

2. **Two sources**: an absolute file path, or an `https://` URL (a presigned
   object-storage URL, typically). Plain `http` is refused; so is a redirect to
   anything but `https` (at most five redirects, followed one by one). A URL
   needs the expected **SHA-256** of the file; a local file may have one. The
   source is copied or downloaded, streamed, into a temporary file of the store's
   directory (`.<store file>.restore-<random>.tmp`, mode `0600`), hashed on the
   way, and cut at a size cap (`restore.max_mb`, 1024 MiB by default; a
   `Content-Length` above the cap is refused before the body is read). The
   download has a fixed deadline of 30 minutes.

3. **Verification, in this order, on the temporary copy, before anything is
   replaced**: the SHA-256 (when given) — nothing else is read from a file that
   is not the one expected; the file opens as SQLite, read-only;
   `PRAGMA integrity_check` is `ok`; it carries the migrations table and every
   migration it records is one this image ships, with the same checksum (an
   **older** store is accepted: the migrations run at boot; a **newer** one, or
   one written by another program, is refused); **every sealed blob opens** with
   the keys this instance holds (`VAUBAAN_MASTER_KEY` and
   `VAUBAAN_MASTER_KEY_PREVIOUS`). The report names each key version found, its
   blob count, whether a key is configured for it and how many blobs did not
   open; one blob that does not open refuses the restore. `--dry-run` runs every
   step and stops before the replacement.

4. **Atomic replacement, nothing deleted.** The verified temporary file is
   synced and renamed onto `store.path` (same directory, so the rename is
   atomic), then the directory is synced. A store that exists and is not empty
   is replaced only with `--force`; it is then **moved aside**, with its `-wal`
   and `-shm` files, as `<name>.replaced-<UTC timestamp>`, never deleted. A
   `-wal` or `-shm` left beside an absent store is moved aside the same way: SQLite
   would otherwise replay it into the restored file. `--force` refuses a store in
   use: the command opens it, checkpoints its WAL and closes it; when the `-wal`
   file survives the close, another connection — the running gateway — holds it
   (exit 75: stop the gateway first).

5. **Restore at first boot.** When `restore.from` (`VAUBAAN_RESTORE_FROM`) is
   set, `restore.sha256` (`VAUBAAN_RESTORE_SHA256`) is required, and the store
   file does not exist yet (or is empty), the server runs the same restore
   **before it opens the store**, then boots as usual: the migrations run, the
   boot's key probe runs, and the operator can reseal. A restore that fails stops
   the boot (exit 1) without leaving a store, so a restart tries again rather
   than starting empty. When the store exists the variables are ignored with one
   `warn` line per boot: the step is idempotent across restarts.

6. **The source is a secret.** `restore.from` is a `secret` key of the key
   table: it accepts `VAUBAAN_RESTORE_FROM_FILE`, is deleted from the process
   environment after load (ADR
   [secrets-leave-the-process-environment-after-load](secrets-leave-the-process-environment-after-load.md)),
   is fed to the log redactor, and no message names it — not even its host; a
   malformed value is refused without being echoed. The command accepts the URL
   as an argument (it lands in a shell history) but prefers the configured one
   when called without a source.

7. **The restore never re-seals.** It checks that this instance's keys open the
   copy; moving the copy to a new key is the reseal's job (ADR
   master-key-rotation-reseals-every-blob), run afterwards with the old key in
   `VAUBAAN_MASTER_KEY_PREVIOUS` (`deploy/railway.md`, "Moving an instance").

## Consequences

- A new machine starts from another instance's store with two variables and no
  shell: every move of an instance, whatever the hosts, uses the same path,
  in the open-source image.
- What is restored has been proven, before it replaced anything, to be the file
  meant, sound, migratable by this image and readable by this instance's keys.
  A store whose keys were left behind is refused on the new host instead of
  failing account by account.
- A forced restore leaves the replaced store on the volume: the operator deletes
  it once the instance works. The volume needs room for the store, its copy and
  the replaced one.
- The "in use" check is best-effort: it relies on SQLite deleting the `-wal` of
  the last connection that closes a WAL database, which the gateway's store
  always is. The documented procedure stops the gateway first.
- A boot with `VAUBAAN_RESTORE_FROM` set and the store present only warns: an
  operator who wants to restore over an existing store runs the command with
  `--force`, server stopped.
- A first boot that downloads a large file takes longer than the image's
  30-second health start period; the server answers once the download and the
  migrations are done.

## Rejected alternatives

- **Restore from the entrypoint shell script.** It would hold the URL in a shell
  variable, could not reuse the store's verification (SQLite, the encryptor, the
  migrations list), and the secret would reach the server's environment anyway.
  The server already loads the configuration, and it runs as the image user
  once the entrypoint has dropped privileges, so the restored file belongs to
  that user either way.
- **Replace an existing store at boot when the variables are set.** A variable
  left in place would wipe a live instance at its next restart.
- **Trust the transport (TLS) without a hash.** A presigned URL can point at the
  wrong object, a stale one, or one someone replaced; the hash names the copy
  the operator meant.
- **Re-seal during the restore.** It would need the old key on the new host as
  configuration of the restore, mixing two operations the operator should see
  succeed one after the other; the reseal already exists, with its dry run.
- **Delete the replaced store.** Nothing in the operator commands deletes data;
  a mistaken `--force` must remain reversible.
