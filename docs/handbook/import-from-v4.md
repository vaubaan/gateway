---
title: Import from v4 — the exporter, the importer, the operator's procedure
status: current
date: 2026-10-15
last_synced: 2026-10-15
tracks:
  - scripts/export-v4.mjs
  - scripts/export-v4-lib.mjs
  - scripts/build-commands.mjs
  - apps/gateway/src/server/import-v4/
  - apps/gateway/src/server/connections/service.ts
  - apps/gateway/src/server/connections/ssh-keypair.ts
  - apps/gateway/package.json
  - deploy/docker/smoke.sh
---

# Import from v4 — the exporter, the importer, the operator's procedure

How one organization of the v4 SaaS is carried into a v5 instance: its keys
that can be carried as is, the resources of its projects with their
environment labels, and one mission per working v4 token. Decision and
rejected alternatives: ADR
[import-from-v4-one-shot-importer](../decisions/import-from-v4-one-shot-importer.md)
(it amends D7 of
[pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md)).
The rest of the cut-over (what to prepare, the checklist, the live checks)
is [cutover-from-v4](cutover-from-v4.md).

**State on 2026-10-15: built and tested on fixtures only; hardened after an
adversarial review (v4 denials, Stripe modes, provenance, stale bundles).** Nothing below
has been run against the real v4 database or a real instance.

## 1. The two halves

```
operator's machine (repository)              the instance's container
───────────────────────────────              ────────────────────────
node scripts/export-v4.mjs --org fidi …  ──►  node apps/gateway/import-v4.mjs --owner … [--apply]
  .env: v4 DB password, v4 master key  stdin    the instance's config, master key, store
  psql, read-only session              (pipe)   report → stderr, mission keys → stdout
  bundle → stdout only
```

| What                      | Where                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| Exporter (command line)   | `scripts/export-v4.mjs` — `.env`, `psql`, stdout                                           |
| Exporter (logic)          | `scripts/export-v4-lib.mjs` — `exportSql`, `createV4Decryptor`, `buildBundle`, `parseArgs` |
| Bundle schema             | `apps/gateway/src/server/import-v4/bundle.ts` (`parseBundle`, `secretsOf`)                 |
| v4 → v5 forms             | `import-v4/credential-mapping.ts`                                                          |
| v4 risks → v5 policy      | `import-v4/risk-translation.ts` (`translateRisks`)                                         |
| The three phases          | `import-v4/importer.ts` (`Importer.run`)                                                   |
| Report                    | `import-v4/report.ts` (`renderReport`)                                                     |
| Command (args, I/O, exit) | `import-v4/cli.ts` (`runImportCli`, `createImportMarker`); entry `import-v4/main.ts`       |
| Connection creation       | `connections/service.ts` — `importPastedKey`, `importSshKey`                               |
| SSH key conversion        | `connections/ssh-keypair.ts` — `importEd25519PrivateKey`                                   |
| Bundling into the image   | `scripts/build-commands.mjs`, run by the `build` script of `apps/gateway/package.json`     |

### The exporter

`node scripts/export-v4.mjs --org <slug> [--ssh-host <slug> --ssh-host-key <slug>=SHA256:…]…`

1. Reads `SUPABASE_CORE_PROJECT_REF`, `VAUBAAN_CORE_DB_PASSWORD`,
   `SUPABASE_CORE_POOLER_HOST` and `ENCRYPTION_MASTER_KEY` from the
   repository's `.env`; the first one missing stops it by name.
   `SUPABASE_CORE_POOLER_HOST` is new: v4 had it hard-coded in
   `scripts/lib/env.ts` (`git show v4-final:scripts/lib/env.ts`).
2. Runs **one** statement (`exportSql()`) in `psql -X -A -t -v ON_ERROR_STOP=1
-f -`, the SQL on stdin, `:'org'` and `:'hosts'` as psql variables, the
   connection in `PG*` variables (the password in `PGPASSWORD`, never in
   argv), `default_transaction_read_only = on`. It returns one JSON document:
   the organization, its projects, its `provider_admins` rows (ciphertext only
   for `cloudflare-dns` and `vercel`), its `provider_bindings` (bash apart),
   its `stripe_bindings`, the slugs of its own SSH bindings, the SSH bindings
   asked by slug in any organization, its working tokens (root, active,
   reusable, not consumed, not expired) with their `accepted_risks` **and
   `denied_risks`**, and three counts.
3. Decrypts with the exact v4 scheme (`createV4Decryptor`): XChaCha20-Poly1305
   IETF, key `crypto_kdf_derive_from_key(32, sha256(org id)[0..4] & 0x7fffffff,
'vaubaan_', master)`, associated data the org id, nonce first. Postgres'
   wrapped base64 is unwrapped first. A secret that does not open stops the
   export without quoting it.
4. SSH: v4 kept `ssh_private_key` as the PEM's bytes, not sealed; a value
   that is not PEM text is tried as a ciphertext of the organization that holds
   the binding. Every row of an asked slug must agree (address, port, user,
   key). `--ssh-host` needs its `--ssh-host-key`: v4 pinned no host key, the
   v5 plugin requires one.
5. Stripe: one entry per account, the account's keys, and per project the
   **one mode** v4 used for it — its row's live key, else its test key
   (`live ?? test`, as the v4 gateway did). Two rows of one account holding
   different keys of the same mode stop the export.
6. Refuses (64), before reading anything, a stdout that is a terminal or a
   regular file: the bundle holds the decrypted secrets and goes into a pipe.
7. Writes the bundle (JSON, one line) on stdout and three summary lines
   (counts, providers, what is left to connect by hand) on stderr. Exit 0,
   1 refused, 64 usage. Unexpected errors print no detail.

### The importer

`node apps/gateway/import-v4.mjs --owner <email> [--apply]` — in the image,
beside `server.js`. `scripts/build-commands.mjs` bundles
`import-v4/main.ts` with esbuild into
`.next/standalone/apps/gateway/import-v4.mjs` after `next build`: everything
bundled but the native addons (`better-sqlite3`, `argon2`, `ssh2`,
`cpu-features`, already in the standalone `node_modules`), each module's
`import.meta.url` rewritten to its repository path seen from the bundle (so
the plugins read their `risk-catalog.yaml` and the store its migrations from
the standalone tree), a `require` shim for CommonJS dependencies.

`runImportCli` (`cli.ts`), in order:

1. arguments: `--owner <email>` (required), `--apply`, `--allow-stale`,
   `--carry-unbudgeted <quota>` (digits only, at least 1),
   `--reissue <v4 token id>` (a UUID, repeatable, lower-cased), `--help`;
   anything else is a usage error (64) that does not echo the argument;
2. refuses uid 0 (77) and a terminal on stdin (64);
3. loads the instance's configuration (78 with the named keys on failure) and
   refuses when `store.path` is `:memory:` or no file is there (78: it never
   creates a database) — before stdin is read, so a misconfigured container
   never ingests the secrets;
4. reads stdin up to 8 MiB, parses and validates the bundle whole (65 on any
   problem, listed by path, never by value);
5. refuses (65) a bundle exported more than an hour ago unless
   `--allow-stale`, and one that claims to come from the future; refuses (64)
   a `--reissue` id that is not a working token of the bundle
   (`unknownReissueIds`), naming it, before the instance is opened;
6. builds the composition root with the store wrapped by `createImportMarker`
   (every administrative audit entry gets `after.marker = 'imported-from-v4'`
   and `after.v4_org`; the `mission-issued` entry of an imported mission also
   `after.v4_source = tokens/<v4 token id>`; `provenance.issued` reads those
   entries oldest first, so the newest issuance of a source wins) and the
   log reduced to `error`
   lines, redacted with every secret of the bundle and of the configuration,
   on stderr;
7. runs `Importer.run`; prints the bundle's age, `renderReport` on stderr
   (control characters of v4 names blanked) and the mission keys on stdout;
   closes the root. Exit 0, or 1 when a connection or a mission was refused,
   67 when the owner is unknown (nothing written). Any unexpected failure —
   here or escaping to `main.ts` — prints one fixed line, never its message
   or a stack, and exits 1.

`Importer.run` (`importer.ts`):

- **Owner** — `findActiveUserByEmail`; unknown or ambiguous refuses the run.
  The owner's current groups make the `Actor`.
- **Connections** — one source per mappable account (Cloudflare, Vercel),
  per Stripe account, per SSH host. For each: provider not in the registry →
  reported; revoked in v4 → skipped; an owned connection with the
  `imported_from.source` marker → `already-imported`; an owned connection of
  the provider with the same non-secret values (`sameVisibleFields`) →
  `already-connected`; dry run → `to-create`; apply → `importPastedKey` /
  `importSshKey`. A `ConnectError` or `SshKeyImportError` is `failed` with its
  message; nothing was stored.
- **By hand** — every other account: `to-connect` or `connected` (the owner
  holds one of that provider), with the reason (a v4 app installation or OAuth
  grant the importer cannot carry, no plugin, revoked).
- **Resources** — `normalizeBindings` merges the duplicated rows (one per
  project, service and resource, every label kept) and adds the Stripe and SSH
  bindings. Each is matched on the owner's issuance connections
  (`MissionService.issuanceContext`) to resource rows: ref exactly (ignoring
  case only for `CASE_INSENSITIVE_REF_PROVIDERS`, GitHub, and SSH host
  names); Stripe by `metadata.account_id` and the project's mode
  (`acct/test` or `acct/live`, never both); SSH by the host address. Labels
  (`planLabels`): `to-label` when exactly one v5 label (`V5_ENV_LABELS`) is
  asked and the resource is unlabelled, owned, not labelled by the plugin;
  otherwise `already-labelled`, `label-set-by-plugin`, `kept-owner-label`,
  `conflicting-labels`, `not-a-v5-label`, `not-owned`. Apply writes through
  `updateResource`. Bindings matched nowhere are listed.
- **Missions** — per working v4 token, against the instance as the labels
  left it (in a dry run: with the planned labels laid over). Name
  (`missionNamesOf`): the project's on one line, cut to 120 characters, or
  `<project> — <token>` when the project has several, `<project> —
<slug>/<token>` when two projects share a name. A mission the owner issued
  through an earlier import of this organization for this v4 token
  (`provenance.issued`: the marked `mission-issued` entries) → `exists`,
  whatever its name now; a revoked one is reported, not issued again —
  unless the token is named by `--reissue`: the mission is then planned and
  issued anew, and the one found is reported in `previous` (id and status),
  never revoked. A hand-made mission with the same name is not looked at. Per service of
  the project: the connection with the most matched resources (an import of
  the same organization wins a tie). None → `deferred` with what to do, or
  `after-connections` in a dry run when the run itself creates it. Then
  `translateRisks` per connection; a connection whose translation is empty is
  left out; none left → `nothing-to-issue`. The draft: each connection with
  `resources: { scope: 'selected', resource_ids }` and an explicit policy,
  period daily (`IMPORTED_MISSION_PERIOD_SECONDS`), the v4 expiry. Dry run →
  `preview` with `assumedEnvs` — the `to-label` plans by resource id
  (`plannedEnvs`), read as set over the store's issuance context
  (`withAssumedEnvs`), never written — so that a mission whose
  env-qualified risks need a label the same run applies is `would-issue`, as
  apply then issues it, and not `refused`; `would-issue` or `refused` with the
  issues; apply → `issue`
  (`issued`, the key collected) inside `provenance.during(tokens/<id>)`.

### Translating a v4 policy

`translateRisks(v4Ids, connection, selectedResources, v4Denied)`:

| v4 id                                           | Result                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| exact explicit v5 id                            | kept (dropped if deprecated, or env-qualified and unresolvable)                                              |
| account-scoped, v5 entry now env-scoped         | one id per environment a selected resource carries (all when the plugin derives the environment): `expanded` |
| env-qualified without exact v5 counterpart      | dropped, `no-exact-env-counterpart` — never widened                                                          |
| unknown to the v5 catalog                       | dropped, `unknown-in-v5`                                                                                     |
| denied in v4 (the id, or a target's id or base) | dropped, `denied-in-v4` — v4 denials trump acceptance                                                        |
| outside the owner's authority                   | dropped, `outside-authority`                                                                                 |
| no preset line (the fallbacks among them)       | dropped, `no-preset-budget` — a quota is never invented                                                      |
| no preset line, with `--carry-unbudgeted <q>`   | kept: quota `q`, rate `min(q, catalog ceiling)` per minute, gate `approval` always: `carried`                |

The fifth argument of `translateRisks`, `{ quota }` or `null`, is
`--carry-unbudgeted`; it lifts the `no-preset-budget` drop only, after the
denial and authority checks (`unbindingRateLimit` gives the rate). The report
prints a carried id as `~ carried under approval: <v5 id>` (with its v4 id
when they differ).

Budget and gate of a kept id: the first line naming it (exactly, then by its
base id) in the developer-like presets (`developer`, `*-developer`), then in
the others, in catalog order. v4 risks of a service the project has no
resource on are listed as dropped.

## 2. The procedure

Do it once per v4 organization: Dalae (`--org dalae`) into the Dalae
instance, Fiabilis AI (`--org fidi`) into the Fiabilis instance.

### 2.1 Before

- [ ] The instance runs, and the person who will own everything has **signed
      in once** (that creates their user). Use the address their sign-in
      provider gives.
- [ ] On your machine: the repository at a commit that has
      `scripts/export-v4.mjs`, `npm ci` done, `psql` on the PATH, and in the
      repository's `.env`: `SUPABASE_CORE_PROJECT_REF`,
      `VAUBAAN_CORE_DB_PASSWORD`, `ENCRYPTION_MASTER_KEY` (the v4 ones) and
      `SUPABASE_CORE_POOLER_HOST` (the v4 pooler host).
- [ ] For each SSH host to carry (`vps-rp`, `vps-fidi`): its fingerprint,
      computed on a machine that already trusts it:
      `ssh-keyscan -t ed25519 <host> | ssh-keygen -lf -` → `SHA256:…`.
- [ ] The instance can reach the services (the importer checks every key
      at the service before storing it).

### 2.2 Dry run

Docker Compose (on the instance's host):

```
node scripts/export-v4.mjs --org fidi --ssh-host vps-fidi --ssh-host-key vps-fidi=SHA256:… \
  | ssh <host> docker compose -f /path/to/compose.yaml exec -T gateway \
      node apps/gateway/import-v4.mjs --owner rpelissier@fiabilis.be
```

Railway (the container runs as root, `RAILWAY_RUN_UID=0`; `vaubaan-entrypoint`
drops to the image user):

```
node scripts/export-v4.mjs --org fidi --ssh-host vps-fidi --ssh-host-key vps-fidi=SHA256:… \
  | railway ssh --service <service> -- \
      vaubaan-entrypoint node apps/gateway/import-v4.mjs --owner rpelissier@fiabilis.be
```

`-T` (Compose) keeps the pipe a pipe. Read the report: accounts to create,
accounts to connect by hand, labels, missions and, per mission, every v4
permission that does not carry over and why.

What `railway ssh` needs and does (checked live on 2026-10-15):

- an SSH key registered at Railway (personal, or for the workspace with
  `--workspace`), and a pinned host key for `ssh.railway.com`. Railway
  publishes no fingerprint: the first connection trusts the key it is shown
  (TOFU); pin it once, from a network you trust, before the import;
- it forwards stdin whole (a 266 KB payload went through intact) and the
  command runs with the service's variables in its environment;
- the shell runs as root, hence `vaubaan-entrypoint` in front of the command
  (the importer refuses root, exit 77).

Export and import in one pipe: the importer refuses a bundle older than an
hour unless `--allow-stale` (v4 may have revoked a key or a token since), and
the exporter refuses to write into a terminal or a file.

### 2.3 Apply, install the keys

Run the same pipe with `--apply`. stdout then carries one line per issued
mission: `{"project":"…","mission_id":"…","token_name":"…","key":"vbn_live_…"}`.
Each key is printed **once** and stored nowhere else: install each in the
project's `.mcp.json` (or the VPS's environment) right away; a lost key is
rotated from the mission's page. To keep stdout apart from the report:
`… --apply 2>report.txt` (the report holds no secret), never `>keys.txt`
somewhere it stays.

### 2.4 Connect by hand, run again

1. Connect, under the same owner, the accounts the report lists "TO CONNECT"
   (GitHub, Railway, Supabase, each with a token made at the service) —
   handbook [connections](connections.md).
2. Run the same pipe with `--apply` again. Imported accounts are recognised
   ("already imported"), existing missions are left alone ("already
   exists"), and the deferred ones are issued; only their keys are printed.
3. Repeat until no mission is deferred. A run with nothing left to do
   writes nothing and prints no key.

### 2.5 After

- Each imported mission is a plain mission: its limits can be changed from
  its page; a risk that was dropped is added by issuing a new mission —
  §2.6.
- Activity → filter administrative entries: every act of the import is
  there, as the owner, with `marker: imported-from-v4`.
- Once v4 is switched off ([cutover-from-v4](cutover-from-v4.md) §3.C):
  reconnect each imported SSH account (it generates a key pair of the
  instance's own; install the new public key, remove the v4 one), and rotate
  at the services the Cloudflare, Vercel and Stripe keys v4 also held.

### 2.6 Bring back dropped permissions on an imported mission

Risks cannot be added to an issued mission; the importer issues a new one.
Example, the Transpay mission (v4 token `vscode`,
`83e35806-6201-47e5-8f03-c0ae2cd604a4`), whose "no preset gives it a budget"
drops should come back under approval, 5 uses a day each:

1. Dry run with `--reissue 83e35806-6201-47e5-8f03-c0ae2cd604a4
--carry-unbudgeted 5`: the mission line reads `would be issued`, then
   `! previous import [<short id> · <mission id>] still active: …`, then one
   `~ carried under approval: <risk>` per brought-back permission. Other
   drops (denied in v4, outside the owner's authority, unknown,
   environment) are still listed as dropped.
2. The same pipe with `--apply`: one key on stdout, for the new mission.
3. Install the new key where the old one was, check the agent works, then
   revoke the previous mission from its page. The importer never revokes it.
4. A later run without `--reissue` recognises the new mission ("already
   exists"); a run with `--reissue` again would issue a third one.

`--carry-unbudgeted` applies to every mission the run issues (a deferred one
included), not only the reissued ones; missions that already exist are left
alone.

## 3. Tests

- Unit: `import-v4/risk-translation.test.ts` (the table above, with the real
  GitHub, Supabase and Vercel catalogs), `import-v4/bundle.test.ts` (strict
  schema, no value in a problem, the mapping held to the plugins' forms,
  binding merge, arguments, the audit marker),
  `connections/codec-and-keypair.test.ts` (key conversion),
  `scripts/export-v4.test.mjs` (arguments, `.env`, v4 decryption against an
  independent v4 sealing, bundle building, SSH rows, the SQL selects no other
  ciphertext).
- A mission is named in the report by its short id — the last 8 characters,
  as its page shows it (`shortId`) — and its whole id: `issued [33445566 ·
0192f3a4-…-112233445566]`, `previous import [… · …] still active`.
- Integration: `tests/integration/import-v4/import-v4.test.ts` — exporter
  output into the command, real root on `:memory:`, real plugins, fake
  services: dry run, apply, rerun, third run, rejected key, unknown owner,
  root, missing store, invalid bundle; `--carry-unbudgeted` (carried under
  approval, other drops kept); `--reissue` (dry run, apply beside the old
  mission left active, newest recognised later, unknown id refused); a dry
  run whose mission needs a label the run would set (Supabase project
  labelled `prod` from v4) says `would be issued`, writes no label, and apply
  agrees. `missions/assumed-envs.test.ts` covers `withAssumedEnvs`.
- Standalone: `tests/integration/standalone-import-v4.test.ts` runs the
  bundle from `.next/standalone` on a store file (after a build).
- Container: `deploy/docker/smoke.sh` step 10 — the command ships, refuses
  root, runs through the entrypoint.
