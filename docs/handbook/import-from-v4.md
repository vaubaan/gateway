---
title: Import from v4
tracks:
  - scripts/export-v4.mjs
  - scripts/export-v4-lib.mjs
  - scripts/build-commands.mjs
  - apps/gateway/src/server/import-v4/
  - apps/gateway/src/server/connections/service.ts
last_reviewed: 2026-10-27
---

# Import from v4 — handbook

Carries one organization of the v4 SaaS into a v5 instance: pasted keys, the
resources of its projects with their labels, one mission per working v4
token. A temporary tool: delete it once the last v4 organization has moved.
The rest of the cut-over: [cutover-from-v4](cutover-from-v4.md).

## Start here

- [`scripts/export-v4.mjs`](../../scripts/export-v4.mjs) — the exporter, run on the operator's machine.
- [`import-v4/cli.ts`](../../apps/gateway/src/server/import-v4/cli.ts) — the importer command, in the container.
- [`import-v4/importer.ts`](../../apps/gateway/src/server/import-v4/importer.ts) — connections, resources, missions.
- [`import-v4/risk-translation.ts`](../../apps/gateway/src/server/import-v4/risk-translation.ts) — v4 risk ids to v5.

## Invariants

- Secrets enter only by a pipe, exporter stdout → importer stdin: no
  endpoint, no file. The exporter refuses a terminal or regular file on
  stdout; the importer loads its configuration and store before reading stdin.
- Imports go through the services (key verified, discovery, sealing, audit);
  every admin entry carries `marker: imported-from-v4`.
- v4 risk ids are translated one by one: dropped, never widened; a v4 denial
  trumps acceptance. Each kept id is its macro-action's line at Confiant
  (`IMPORT_TRUST_LEVEL`: base budget ×3, gate from its tier), the fallback in
  "Anything else" included; a quota is never invented for an id in no
  macro-action (`--carry-unbudgeted` keeps it under `approval` only).
- Idempotent by provenance: `after.v4_source` on `mission-issued` is how a
  later run recognises a mission; `--reissue` issues a new one and never
  revokes the old.

## Traps

- The esbuild bundle (`build-commands.mjs`) rewrites each module's
  `import.meta.url` to its repository path, so plugins find their catalogs
  and the store its migrations.
- v4 pinned no SSH host key: `--ssh-host` needs `--ssh-host-key`.
- A bundle older than an hour is refused: export and import in one pipe.
- A dry run assumes the labels the same run would apply (`withAssumedEnvs`,
  never written), so it previews what `--apply` does.

## Procedures

1. The future owner has signed in once; on your machine: `npm ci`, `psql`,
   the four v4 variables in `.env`; each SSH host's fingerprint
   (`ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -`).
2. Dry run, one pipe:
   `node scripts/export-v4.mjs --org <slug> [--ssh-host <s> --ssh-host-key <s>=SHA256:…] | <into the container> node apps/gateway/import-v4.mjs --owner <email>`.
   Compose: `docker compose exec -T gateway …` (`-T` keeps the pipe). Railway:
   `railway ssh --service <service> -- vaubaan-entrypoint node …` (runs as
   root; pin `ssh.railway.com` once).
3. The same pipe with `--apply`, `2>report.txt`. stdout prints each mission
   key once and nowhere else: install it at once, never keep stdout in a file.
4. Connect by hand the accounts listed "TO CONNECT", run `--apply` again until
   nothing is deferred.
5. Once v4 is off: reconnect each SSH account (new key pair) and rotate at the
   services the Cloudflare, Vercel and Stripe keys v4 also held.

- **Bring back dropped permissions**: dry run with
  `--reissue <v4 token id> --carry-unbudgeted 5`, apply, install the new key,
  then revoke the old mission yourself from its page.
