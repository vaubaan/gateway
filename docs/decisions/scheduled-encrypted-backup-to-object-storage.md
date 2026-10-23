---
title: The instance backs itself up on a schedule to S3-compatible storage, encrypted under its master key and checked before upload
status: accepted
date: 2026-10-21
extends:
  - restore-verifies-before-it-replaces-and-runs-at-first-boot
  - backup-carries-the-sign-in-configuration
  - master-key-rotation-reseals-every-blob
  - docker-image-and-config-format
  - dependency-audit-gate
---

# The instance backs itself up on a schedule to S3-compatible storage, encrypted under its master key and checked before upload

> Amended 2026-10-23: the copy is compressed with Brotli before it is encrypted,
> file format `vaubaan-backup` v2 (see
> [the amendment](#amendment-2026-10-23--the-copy-is-compressed-before-it-is-encrypted-format-v2)).

## Context

The image ships `backup` (a consistent `VACUUM INTO` copy beside the store)
and `restore` (verify, then replace; at first boot from a presigned URL with
its SHA-256). Nothing makes a copy unless someone runs the command, and the
copy it makes lies on the same volume as the store and the master key file.
A volume snapshot of the hosting platform has the same weakness: same place,
same region, the key inside.

The managed offer asked for it (request 6 of `managed-instances.md` §10.2,
§3.6: its Fly instances have only same-region volume snapshots), and so does
any self-hoster: an off-host copy, made without a shell, that whoever holds
the bucket cannot read, and that is known to restore before it is relied on.
The gateway stays unaware of the managed offer: this is a feature of the open
source instance, configured like every other one.

## Decision

1. **Configuration** (keys of the instance configuration, YAML and
   `VAUBAAN_*` variables, in the one key table):

   | Key                           | Variable                              | Note                                                          |
   | ----------------------------- | ------------------------------------- | ------------------------------------------------------------- |
   | `backup.s3.endpoint`          | `VAUBAAN_BACKUP_S3_ENDPOINT`          | https URL; http only for a loopback host (tests, local MinIO) |
   | `backup.s3.region`            | `VAUBAAN_BACKUP_S3_REGION`            | `auto` for Tigris and R2                                      |
   | `backup.s3.bucket`            | `VAUBAAN_BACKUP_S3_BUCKET`            | setting it turns the backup on                                |
   | `backup.s3.prefix`            | `VAUBAAN_BACKUP_S3_PREFIX`            | literal key prefix; end it with `/` for a folder              |
   | `backup.s3.path_style`        | `VAUBAAN_BACKUP_S3_PATH_STYLE`        | `false`: `<bucket>.<host>`; `true`: `<host>/<bucket>`         |
   | `backup.s3.access_key_id`     | `VAUBAAN_BACKUP_S3_ACCESS_KEY_ID`     |                                                               |
   | `backup.s3.secret_access_key` | `VAUBAAN_BACKUP_S3_SECRET_ACCESS_KEY` | secret: `_FILE`, scrubbed, redacted                           |
   | `backup.every`                | `VAUBAAN_BACKUP_EVERY`                | `24h` default; 1h to 24h, dividing a day                      |
   | `backup.at`                   | `VAUBAAN_BACKUP_AT`                   | `HH:MM` UTC, default `03:00`: the first run of the day        |
   | `backup.keep`                 | `VAUBAAN_BACKUP_KEEP`                 | backups kept; `0` (default) keeps all                         |

   The `backup.s3.*` block is all or nothing: one key set asks for endpoint,
   region, bucket, access key id and secret, by name. With no `backup.s3.*`
   key the instance backs nothing up and says so (`/healthz`, Settings).

2. **Schedule.** Runs fall at `at + k × every` (UTC) every day: `24h` from
   `03:00` is one run a day at 03:00; `6h` from `03:00` is 03:00, 09:00,
   15:00, 21:00. A period that does not divide a day is refused at boot
   (a weekly backup is not offered: retention covers the need more simply).
   The timer lives in the server (one process, one store), is `unref`-ed, and
   a run never overlaps another: a slot that comes while one runs is skipped
   and logged. **A missed run is made up once, not per slot**: at start, when
   the store records no attempt within the last `every`, one run starts one
   minute after the boot; then the schedule resumes. A crash-looping instance
   therefore never runs it, and an instance down for a week makes one backup,
   not 28.

3. **The copy is the `backup` command's copy.** `VACUUM INTO` a temporary file
   of the store's directory (the running handle: one connection, consistent,
   no WAL to pair), then the same writes into the copy as the command
   (`writeStoreCopy`, shared by both): the sign-in providers of the
   configuration carried as store-held ones (ADR
   backup-carries-the-sign-in-configuration), and the instance's own backup
   record (`backup.status`) removed, so that a restored instance does not
   report the source's backups as its own. `integrity_check` must be `ok`.

4. **Encryption — file format `vaubaan-backup` v1** (since 2026-10-23 the
   writer writes v2, the copy compressed first: see the amendment; v1 is
   still read). The copy is encrypted whole, in streamed chunks, before
   anything else reads it:

   - file key = `HKDF-SHA-256(ikm = master key of version K, salt = 32 random
bytes of this file, info = "vaubaan/backup-file/v1", 32 bytes)`, K the
     current key version. A fresh salt per file gives a fresh key per file.
   - header = `"VAUBAAN-BACKUP"` (14 bytes) ‖ format `0x01` ‖ K (u32 BE) ‖
     salt (32) ‖ chunk size (u32 BE, 1 MiB) ‖ n (u8) ‖ n × u32 BE: the key
     versions the copy's sealed secrets are under.
   - body = chunks of AES-256-GCM, each `ciphertext ‖ tag(16)`, nonce = chunk
     index (u64 BE) ‖ final flag (u32 BE, 1 on the last chunk only),
     associated data = the whole header. This is the STREAM construction:
     a chunk moved, dropped, appended or cut off, or a header edited, fails
     its tag. The last chunk of the file is the one with the final flag (full
     when the plain size is a multiple of the chunk size, empty — a tag alone —
     when the plain file is empty).
   - A backup **names the key versions it needs**: K to open the file, and
     the versions of its sealed secrets to open those. Without them it is
     ciphertext — to the bucket's owner, to whoever finds it, and to the
     hosting provider of a managed instance.

   AES-256-GCM through `node:crypto` (and HKDF through it) rather than the
   libsodium XChaCha20 of the sealed columns: the streaming cipher and the
   KDF come from the runtime, no extra code reads a backup, and a backup can
   be opened by any tool that speaks AES-GCM and HKDF given the format above.

5. **Self-check before upload: the restore's own dry run, on the encrypted
   file.** `restoreStore({ dryRun: true })` reads the very bytes that will be
   uploaded, with their SHA-256: it decrypts them into a temporary file, runs
   `integrity_check`, compares the migrations with the image's, and opens
   every sealed blob with the instance's keys. A backup that fails is not
   uploaded; the failure is recorded (stage `self-check`), logged and
   audited. Nothing of it stays on the volume.

6. **Upload — a small S3 client of our own, SigV4 over `fetch`.**
   `server/backup/s3/`: AWS Signature Version 4 with `node:crypto` (held to
   the documented S3 examples by its tests), virtual-hosted or path-style
   addressing, `PutObject` up to 64 MiB, multipart above (16 MiB parts,
   aborted on any failure), `ListObjectsV2` and `DeleteObject` for the
   retention. The payload is signed (`x-amz-content-sha256` of the body, no
   `UNSIGNED-PAYLOAD`), and the object carries `x-amz-meta-sha256` so a
   checker can compare without downloading. Errors name the HTTP status and
   the S3 error code, never a URL or a header.

7. **Retention.** With `keep = N > 0`, after a successful upload the objects
   under the prefix whose name is a backup of this format
   (`vaubaan-backup-<UTC stamp>.vbk`) are sorted by name (the stamp) and all
   but the N newest deleted. Nothing else in the bucket is touched. A failed
   deletion does not fail the backup: it is recorded and retried at the next
   run.

8. **Report.** The latest attempt and the latest success live in the store
   (`instance_config`, key `backup.status`, JSON), so a restart keeps them and
   the catch-up rule of D2 reads them. They are shown:

   - to administrators, on Settings → Encryption, "Scheduled backup";
   - to an external checker, in `GET /healthz` as a `backup` object —
     `configured`, `schedule`, `next_run_at`, `running`, `last_attempt_at`,
     `last_outcome`, `last_error`, `prune_error`, and `latest` (`at`,
     `object_key`, `bytes`, `sha256`, `key_version`, `sealed_key_versions`,
     `schema_version`, `self_check`) — with no endpoint, bucket,
     credential or URL. `/ops/stats` (request 9 of the managed offer) does
     not exist yet; when it does, the same object moves there and `/healthz`
     keeps a summary;
   - in the activity: `backup-made` and `backup-failed`, object
     `instance-config` / `backup`, actor `schedule` ("The backup schedule"),
     the same fields as the report, never a secret.

9. **Restore of an encrypted backup.** `restoreStore` (the command and the
   first boot) recognises the header after the download and its SHA-256
   check (the hash is the uploaded object's), opens the file with the
   instance's key of version K — current or `previous_keys` — into a second
   temporary file, then verifies and installs that file as before. A
   missing key version is refused naming it; a wrong key or a tampered file
   fails the first chunk's tag. At first boot of a new machine the setup
   receives the key file first (setup mode), then the same restore runs.

10. **Rotation.** The procedure of ADR
    master-key-rotation-reseals-every-blob gains one rule: keep the previous
    key in `previous_keys` (or with the backups) as long as a backup still
    kept was made under it — with `keep = N` and one run a day, N days after
    the rotation.

## Consequences

- An instance with five variables set has a daily off-host backup that its
  storage provider cannot read and that has been restored once already, in a
  temporary file, before it was uploaded.
- The volume needs room for the store, its plain copy and the encrypted copy
  during a run (three times the store, briefly). `VACUUM INTO` holds the
  event loop for the length of the copy; stores are megabytes today, and a
  large store would want an online backup API instead.
- `/healthz` grows: it is public, so the object holds no endpoint, bucket or
  credential; the object key and sizes are visible to anyone who reaches the
  instance's health endpoint.
- A self-hoster with no object storage loses nothing: the block is off, the
  `backup` command is unchanged and still writes a plain copy.
- Real S3-compatible stores (Tigris, R2, MinIO, AWS) are reached only through
  the documented SigV4 rules; the tests use the AWS examples and an
  in-process fake. The first real run on each is still a manual check.

## Rejected alternatives

- **The AWS SDK (`@aws-sdk/client-s3`).** Dozens of packages in the
  production tree for four calls, all under the audit gate (ADR
  dependency-audit-gate). SigV4 is a page of code with published test
  vectors.
- **A small S3 library** (`aws4fetch`, `minio`). `aws4fetch` signs but leaves
  multipart, listing and errors to us anyway; `minio` brings its own
  dependency tree. Neither is needed for four calls.
- **An external tool (restic, rclone, a cron container).** Another program
  to ship and configure, and it cannot run the restore's self-check nor
  reuse the master key without holding it in its own configuration.
- **Server-side encryption of the bucket (SSE-S3, SSE-KMS).** The storage
  provider holds the key: the bucket's owner can read the store.
- **Sealing with the connection encryptor (XChaCha20-Poly1305 of libsodium,
  whole file).** It holds the whole store in memory twice and its key
  derivation is the connection one; a dedicated HKDF info and a streamed
  format keep the backup key separate and the memory flat.
- **Cron expressions.** A parser to depend on or write, and schedules
  (weekly, monthly) the retention makes unnecessary; `every` + `at` says
  everything an hourly-to-daily backup needs.
- **Make up every missed slot.** A week down would make dozens of identical
  backups that the retention deletes at once.
- **Upload first, check after.** A copy that does not restore would replace,
  through the retention, one that does.

## Amendment 2026-10-23 — the copy is compressed before it is encrypted (format v2)

Refines D4 (the file format), D8 (the report) and D9 (the restore); changes
none of the other decisions.

### Context

The scheduled backup runs live since 2026-10-23 against Cloudflare R2: the
dogfood instance uploads 15.3 MB per copy. Copies are full, and encrypted, so
the storage cannot compress them; managed plans keep 7, 30 or 90 of them. A
store is mostly activity rows — JSON with repeated keys, tool names, user
identifiers — which compress well. The product owner approved compressing
(2026-10-23). Compression must happen before encryption (ciphertext does not
compress), within the rules of the crypto module (ciphers and key derivation
only under `server/crypto/`), and without a new dependency.

**Measurement** (2026-10-23, Node 22, one core of the development machine): a
store built with the store's own writers — 40 000 activity rows (UUIDs, SHA-256
fingerprints, timestamps: more entropy than real rows, so the ratio is a floor),
50 sealed secrets — `VACUUM INTO` copy of 22.9 MB:

| Codec (`node:zlib`)  |    Ratio | Compressed |        Compress |      Decompress |
| -------------------- | -------: | ---------: | --------------: | --------------: |
| gzip level 1         |     3.55 |     6.4 MB |          0.17 s |          0.06 s |
| gzip level 6         |     3.83 |     6.0 MB |          0.32 s |          0.06 s |
| gzip level 9         |     3.99 |     5.7 MB |          1.03 s |          0.04 s |
| Brotli quality 3     |     4.05 |     5.6 MB |          0.19 s |          0.06 s |
| **Brotli quality 4** | **4.24** | **5.4 MB** | **0.27–0.32 s** | **0.04–0.06 s** |
| Brotli quality 5     |     4.28 |     5.3 MB |          0.70 s |          0.08 s |
| Brotli quality 9     |     4.38 |     5.2 MB |          2.08 s |          0.07 s |
| Brotli quality 11    |     5.16 |     4.4 MB |          41.0 s |          0.08 s |
| zstd level 3         |     3.94 |     5.8 MB |          0.10 s |          0.03 s |
| zstd level 9         |     4.10 |     5.6 MB |          0.37 s |          0.04 s |

On that ratio the dogfood's 15.3 MB copy would be about 3.6 MB.

### Decision

1. **Codec: Brotli, quality 4** (`BACKUP_BROTLI_QUALITY`), from `node:zlib`, no
   new dependency. At the time of gzip level 6 it is 10 % smaller; quality 5
   and above cost two to a hundred and fifty times the time for files 1 to
   18 % smaller. Brotli is RFC 7932, and its `brotli` command-line decoder is
   packaged widely, so a v2 file still opens with standard tools (AES-GCM,
   HKDF, Brotli) given this format. The size hint is the store's size.
2. **Format `vaubaan-backup` v2.** Header = `"VAUBAAN-BACKUP"` ‖ format
   **`0x02`** ‖ K (u32 BE) ‖ salt (32) ‖ chunk size (u32 BE) ‖ **store size
   (u64 BE: the copy before compression)** ‖ n (u8) ‖ n × u32 BE. The body is
   the Brotli stream of the copy, sealed exactly as v1: 1 MiB chunks of
   AES-256-GCM, STREAM nonces, the whole header as associated data, the last
   chunk of the file marked final. File key = `HKDF-SHA-256(master key of
version K, salt, "vaubaan/backup-file/v2", 32)`: a **distinct info**. The
   version byte is in the associated data, so a v2 file presented as v1 (or
   the reverse) already fails a tag; the distinct info adds that the two
   formats never share a key, whatever the parsing of the header, at no cost.
   The format byte names the codec: another codec would be another version.
3. **Streaming.** The writer reads the copy through the Brotli compressor and
   seals its output chunk by chunk (one chunk held, sealed once more data
   follows so that the last one carries the final flag); the store is never
   held in memory, once or twice. The reader opens each chunk — its tag
   checked — before the decompressor sees it, and writes what comes out.
4. **Decompression bounds.** The store size is in the header, so it is
   authenticated with every chunk. The reader refuses a declared size above
   its cap before reading any chunk (`maxStoreBytes`; the restore passes
   `restore.max_mb`, so that cap keeps its meaning: the largest store a
   restore writes, whether it arrives plain, as v1 or as v2). While
   decompressing it counts the output and stops as soon as it passes the
   declared size — a bomb writes at most the declared size —, and refuses a
   content that ends short of it or is not Brotli. Since only chunks that
   opened are decompressed, only a holder of the key can craft such a file;
   the bound is there for that holder's mistakes and for the disk.
5. **Self-check, unchanged:** the restore's dry run reads the very bytes that
   will be uploaded, now decompressing them. `x-amz-meta-sha256` stays the
   SHA-256 of the uploaded (compressed, encrypted) object, and so does the
   hash a restore is given.
6. **Restore reads v1 and v2** (the command and the first boot, through
   `restoreStore`); the writer writes v2 only (v1 stays writable for the
   compatibility tests). The report's `encryption` gains the format and the
   declared store size.
7. **Report.** The backup record gains `storeBytes` (the copy before
   compression) beside `bytes` (the object); `/healthz` `latest` gains
   `store_bytes` (`null` for a record written before v2); Settings →
   Encryption shows both. Still no endpoint, bucket or credential.

### Consequences

- Stored and transferred bytes drop about four-fold on a store of activity
  rows (more on real rows), for each of the 7 to 90 copies a plan keeps; the
  upload is shorter, and a store up to about four times 64 MiB still goes in
  one PUT.
- A run costs a fraction of a second more of CPU per 20 MB (Brotli 4 runs
  off the event loop, in the zlib thread pool), and the self-check about
  60 ms of decompression.
- A v2 backup does not restore on 2.0.0-alpha.4 or earlier: they refuse
  format 2 by its number. Restoring needs an image at least as new as the one
  that made the backup — already the rule for the schema.
- Bucket-side tools that inspected sizes see smaller objects; the store size
  is in the report instead.

### Rejected alternatives

- **zstd (`node:zlib`).** Faster at a similar ratio, but in Node 22 (the
  image pins 22.23.4) its API is documented as Stability 1 — Experimental
  (added in 22.15.0): a backup format must not rest on an API that may change.
  Worth revisiting when the image moves to a Node where it is stable — as v3.
- **gzip / deflate.** Universal, but 10 % larger at the same time at level 6,
  and still larger at level 9 for three times the time.
- **Brotli at quality 11 (or 9 and above).** 18 % smaller than quality 4 at
  quality 11, for forty seconds on 23 MB, during which the run holds the
  copy on the volume; quality 9 gains 3 % for seven times the time.
- **Compressing each chunk separately.** Every chunk would restart the
  dictionary (worse ratio), and the chunks would no longer be of a fixed
  plaintext size; one stream then fixed-size sealing keeps the v1 sealing
  untouched.
- **Keeping v1's HKDF info.** Safe (the version byte is authenticated), but
  a distinct info costs nothing and keeps the two formats' keys apart.
- **No declared size, a ratio cap instead** (refuse more than N × the
  file). A legitimate store's ratio is not bounded (empty pages, repeated
  rows), and a cap on a ratio cannot be checked before decompressing; an
  authenticated declared size is exact.
- **Leaving compression to the storage.** It sees ciphertext.
