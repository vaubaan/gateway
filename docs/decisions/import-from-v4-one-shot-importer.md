---
title: A one-shot importer carries a v4 organization's keys, resources and working tokens into a v5 instance
status: accepted
date: 2026-10-15
amends:
  - pivot-v4-to-v5-on-prem-mission-tokens
extends:
  - plugin-contract-and-credential-spec
  - token-connections-beside-the-integration-app
  - connect-driver-and-resource-curation
  - docker-image-and-config-format
  - railway-deployment-and-privilege-dropping-entrypoint
---

# A one-shot importer carries a v4 organization's keys, resources and working tokens into a v5 instance

> **Amendment of 2026-10-15 (second) — carrying unbudgeted risks, reissuing
> one mission** (brief PO2, after the live run). The live run dropped many v4
> permissions as "no preset gives it a budget" (catalog fallbacks such as
> `github.uncategorized-write`, and entries like
> `supabase[prod].auth-config-write`), and the owner wants them back on a
> mission already issued. Two opt-in flags, both explained in D6 and D9:
>
> - `--carry-unbudgeted <quota>` keeps such a risk instead of dropping it,
>   with that quota per period, a rate limit that adds nothing to the quota
>   (`<quota or the catalog ceiling, the lower> per minute`: a budget always
>   has a rate limit, spec §3.2) and the **`approval` gate, always** — every
>   use waits for the owner's grant, so the quota is a ceiling on what the
>   owner may be asked, not an amount the agent spends alone. Only the
>   `no-preset-budget` reason is lifted; every other drop stays a drop, the
>   owner's authority still bounds the line, and the policy stays an explicit
>   enumeration of risk ids.
> - `--reissue <v4 token id>` (repeatable) issues that token's mission again
>   although an import issued one: a risk cannot be added to an issued
>   mission (spec §3.2, "Changing the limits"), so the way to widen it is a
>   new mission. Same name; its `mission-issued` entry carries the same
>   `v4_source`, and a later run recognises the **newest** issuance. The
>   importer **never revokes** the earlier mission: its key is installed
>   somewhere and still working; the report names it ("previous import <id>
>   still active: revoke it once the new key is installed"). An id that is not
>   a working token of the bundle stops the command (64) before anything is
>   written. The dry run shows what would be issued.

> **Amendment of 2026-10-15 — after the adversarial review**
> (`.vaubaan/reports/import-v4/review.md`). v4 **denials** are carried and
> honoured (D6); a Stripe project keeps the **one mode** v4 used for it (D7);
> the exporter refuses a terminal or a file as stdout, the importer refuses a
> bundle older than an hour without `--allow-stale`, checks the instance before
> reading stdin, and prints one fixed line for any unexpected failure (D11);
> an imported mission is recognised by **provenance**, never by name (D9);
> names and refs are printed on one line, refs match ignoring case only for
> GitHub. Not taken: `PGSSLMODE=verify-full` (see Consequences).

> Product owner's decision of 2026-10-15 (brief PO): the v4 SaaS holds many
> connections, resources and project setups for the organizations moving to
> their own instance (Dalae, Fiabilis AI). Re-creating them by hand, as D7 of
> [pivot-v4-to-v5-on-prem-mission-tokens](pivot-v4-to-v5-on-prem-mission-tokens.md)
> planned, is replaced by an importer. That ADR carries the dated amendment;
> this one is the importer's design. Handbook:
> [import-from-v4](../handbook/import-from-v4.md). Spec patch: delivered beside
> this ADR (§1, the list of what v5 is not; §11: "no data migration" becomes
> "a one-shot import, no coexistence").

## Context

The v4 SaaS (Supabase Postgres, schema of the `v4-final` tag) keeps, per
organization: one account per provider (`provider_admins`, the token sealed
with a per-organization key derived from `ENCRYPTION_MASTER_KEY`), the
resources of each project (`provider_bindings`, with duplicated rows and an
`environment` that is sometimes a real label and sometimes junk), Stripe keys
(`stripe_bindings`, sealed the same way), SSH hosts (`ssh_bindings`, the
private key stored **as plain text** — the v4 routes write
`encodeByteaHex(privateKeyPem)`, never `encryptProviderSecret`), and the
project tokens whose `accepted_risks` are the working setups. Two v5
instances run on Railway and must receive what two v4 organizations hold.

The tool moves secrets from one system to another; it is reviewed
adversarially. Three constraints frame it: the v4 master key and database
password must not enter an instance; the instance's own rules (credential
check, discovery, sealing, authority, explicit policy, audit) must apply to
what is imported exactly as to what a person creates; and a second run must
complete the first, never duplicate it.

## Decision

### D1 — Two halves joined by a pipe; the importer ships in the image

- **Exporter**, `scripts/export-v4.mjs`, on the operator's machine, from the
  repository: one read-only `psql` session (`default_transaction_read_only`;
  the password in `PGPASSWORD`, never in argv; no `pg` dependency), the v4
  decryption with the exact v4 scheme (`scripts/export-v4-lib.mjs`), the
  bundle on **stdout only**. Its settings come from the repository's `.env`
  (`SUPABASE_CORE_PROJECT_REF`, `VAUBAAN_CORE_DB_PASSWORD`,
  `SUPABASE_CORE_POOLER_HOST`, `ENCRYPTION_MASTER_KEY`); the first one missing
  stops it by name. The pooler host, hard-coded in v4's `scripts/lib/env.ts`,
  becomes a key.
- **Importer**, `apps/gateway/src/server/import-v4/`, bundled by
  `scripts/build-import-v4.mjs` (esbuild, already in the lockfile) into
  `.next/standalone/apps/gateway/import-v4.mjs` after `next build`. The image
  copies the standalone tree whole, so it lands at
  `/app/apps/gateway/import-v4.mjs` with no Dockerfile change. The native
  addons stay external (already traced for the server); every module keeps
  its own `import.meta.url` (rewritten to its repository path, which the
  standalone tree mirrors), so the plugins find their catalogs and the store
  its migrations.
- The importer reads the bundle **from stdin only**, uses the instance's own
  configuration, master key and store (the composition root, `buildRoot`),
  refuses to run without a configuration (78), without the store file (78 —
  it never creates a database), and **as root** (77): on a platform that
  starts the container as root, the command is prefixed with
  `vaubaan-entrypoint`, which drops to the image user
  ([railway-deployment-and-privilege-dropping-entrypoint](railway-deployment-and-privilege-dropping-entrypoint.md)).
- Usage: `node scripts/export-v4.mjs --org fidi --ssh-host vps-fidi --ssh-host-key vps-fidi=SHA256:… | railway ssh … -- vaubaan-entrypoint node apps/gateway/import-v4.mjs --owner <email> [--apply]`,
  or `… | docker compose exec -T gateway node apps/gateway/import-v4.mjs …`.
  The default is a dry run; `--apply` writes.

### D2 — The bundle: versioned JSON, checked whole and strictly

`{ format: 'vaubaan-v4-export', version: 1, organization, projects, accounts,
bindings, stripe_accounts, ssh_hosts, missions, skipped }` (schema:
`import-v4/bundle.ts`). The importer validates all of it with zod before the
first write; an unknown key anywhere refuses it. A secret is accepted only
where the importer uses one: an account carries `access_token` only for the
providers of D3, and the exporter does not even select the ciphertext of the
others. The problems the importer prints name a path and a rule, never a
value; a JSON syntax error is reported without the parser's message (V8
quotes the input around the error).

`missions` holds the v4 tokens that are working setups: root tokens
(`parent_id is null`), `active`, not single-use, not consumed, not expired.
Delegated child tokens are counted in `skipped` (v5 has no sub-mission), as
are the `project_env_vars` (no v5 counterpart) and the `bash_bindings`.
The importer leaves `skipped` as a report line.

SSH: v4 pinned no host key, and the v5 plugin refuses a host without one
(never trust on first use). The operator gives each fingerprint to the
exporter (`--ssh-host-key <slug>=SHA256:…`, computed on a machine that
already trusts the host); `--ssh-host <slug>` without it is a usage error.
An SSH binding is pulled from any organization by its slug (the two VPS live
in organization `vaubaan`, project `runner`); rows of one slug that disagree
(address, port, user or key) stop the export.

### D3 — What is imported, and what is connected by hand

| v4 account            | Imported as                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| Cloudflare DNS token  | `api-key` `{ api_token }`                                                              |
| Vercel PAT + team id  | `api-key` `{ token, team_id }` — the same shape as v5's form                           |
| Stripe test/live keys | `api-key` `{ test_key, live_key }`, one connection per Stripe account                  |
| SSH host              | `ssh-key`, the v4 private key (D5), host, port, user, fingerprint                      |
| GitHub App install    | **not imported**: the instance registers and installs its own App                      |
| Railway, Supabase     | **not imported**: an OAuth grant whose refresh token one side rotates breaks the other |

The table (`import-v4/credential-mapping.ts`) is a translation table, not a
provider list: a provider is imported only when the registry ships its
plugin, and every account the table does not map is reported "to connect by
hand" (or "already connected" when the owner holds one). The field names are
held to the plugins' credential specs by a unit test.

### D4 — The paths of the interface, under the owner, audited and marked

`--owner <email>` must name an active user of the instance (a user exists
once they signed in); otherwise nothing is written (67). Everything is
created as that user, through the services the interface uses:

- connections through `ConnectionService.importPastedKey` /
  `importSshKey`: the plugin's `verify` when it declares one, then the first
  discovery, **required** — a rejected key or an unreachable service refuses
  the connection, nothing is stored, the report says why — then the seal and
  the `connection-created` entry. The connect rate limit (a web-request
  guard) does not apply to the operator's command;
- environment labels through `ConnectionService.updateResource`;
- missions through `MissionService.preview` (the dry run) and `issue`
  (authority, explicit policy, preset check, `mission-issued` entry).

Every administrative entry the run writes carries `after.marker =
'imported-from-v4'` and `after.v4_org`: the command wraps the store's audit
writer, so the entries written by the services themselves are marked without
the services knowing about the import.

### D5 — SSH: the v4 key is kept, an exception to "the instance generates the pair"

[plugin-contract-and-credential-spec](plugin-contract-and-credential-spec.md)
D2 has the instance generate the ed25519 pair of an `ssh-key` connection.
The importer instead keeps the v4 key, which is already in the host's
`authorized_keys`: the cut-over needs no step on the VPS, and v4 keeps
working until it is switched off. The key is converted
(`importEd25519PrivateKey`): PKCS#8 PEM (what v4 generated) or an unencrypted
OpenSSH container in; the OpenSSH container out, the one format SSH clients
read. Another key type, an encrypted key or a malformed one is refused
without quoting it. The first discovery runs at once (the key is installed):
it connects, verifies the pinned host key and the pair, and a failure
refuses the connection. After v4 is switched off, reconnecting the account
generates a pair of the instance's own (handbook, last step).

### D6 — Policy: v4 ids translated one by one, budgets from the presets

For each v4 id of a service of the mission (`import-v4/risk-translation.ts`):

1. the same explicit id exists in the v5 catalog → kept;
2. an account-scoped v4 id whose v5 entry became env-scoped (Supabase,
   Stripe, Upstash) → written out as the env-qualified ids the mission can
   reach: one per environment of the entry carried by a selected resource,
   every one when the plugin derives the environment from the call. v4
   accepted it on every environment: this is the same permission, spelled
   out, as `expandPreset` spells out a preset line;
3. an env-qualified v4 id without an exact v5 counterpart, an unknown id, a
   deprecated entry, an id outside the owner's authority → **dropped and
   reported, never replaced by a wider id**. No wildcard is ever written.

**v4 denials trump acceptance.** v4's risk runtime refuses a risk in
`denied_risks` even when it is in `accepted_risks`, and nothing in v4 keeps
the two apart. The bundle carries both lists; an accepted v4 id that is itself
denied, and every translated target whose id or base id a denial names (v4
denials may be env-qualified), are dropped and reported `denied-in-v4`.

Each kept id takes quota, rate limit and gate from a preset line: the
plugin's developer-like presets first (`developer`, `*-developer`), then its
other presets in catalog order — the interface's own rule for a hand-ticked
risk (`defaultEntryFor`). The catalogs declare no per-risk default budget;
an id no preset carries (every catalog's fallback among them) has no budget
to take and is dropped and reported: a quota is never invented — unless the
operator gives one with `--carry-unbudgeted <quota>` (second amendment of
2026-10-15): the id is then kept with that quota, a rate limit of
`min(quota, catalog ceiling)` per minute (only the quota binds) and the
`approval` gate, and reported `carried under approval`. The period
is the interface's default (quotas reload daily); the expiry is the v4
token's (`null` stays `null`, as D7 of the pivot asked).

One mission per working v4 token, named after the v4 project (on one line,
cut to the interface's 120 characters), or `<project> — <token name>` when the
project has several, or `<project> — <slug>/<token>` when two projects share a
name. Its connections are
the owner's connections that hold the project's resources (D7), one per
service, each with exactly those resources selected.

### D7 — Resources and their environment labels

A binding is matched to a discovered, non-stale resource of the owner's
connections of that service: by ref, exactly — ignoring case only for
services whose refs are case-insensitive (GitHub `owner/repo`) and for SSH
host names; a Stripe account by `metadata.account_id` **and the project's
mode**; an SSH host by its address.

**Stripe: the mode is per project.** In v4 a project's Stripe row gave it ONE
key, `live ?? test` (the v4 gateway's build step). The bundle records, per
project, that mode; the importer keeps one connection per Stripe account
(the v5 model, holding the account's keys) and selects for each mission only
the resource of its project's mode: a project that acted in test mode never
reaches live money, and a project that held both keys stays live only. Rows
of one account holding two different keys of the same mode stop the export. Duplicated v4
rows are merged first. A v4 label is carried only when it is a v5 label
(`prod`, `staging`, `preview`, `dev`), only onto an unlabelled resource the
owner owns; a label the plugin set or the owner chose is never overwritten,
and two projects giving one resource different labels leave it unlabelled.
Every other case is reported. A binding found on no account is listed with
the advice to connect the account or refresh its discovery.

### D8 — A service without a connection defers the mission

A mission's accepted risks are fixed once it is issued (spec §3.2,
"Changing the limits": a risk added is a new mission, which would also change
the key installed on the VPS), and a service's risks come with its
connection. A mission created without one of its services could
not be completed by a rerun. So a mission waits — reported as **deferred**,
with what to do — while one of its services has no connection of the owner
holding the project's resources; it is issued by the run after that. In a
dry run, a mission whose services wait only for connections the same run
creates is reported "issued at --apply".

### D9 — Idempotency

- An imported connection keeps `metadata.imported_from = { system:
'vaubaan-v4', org, source }` (`provider_admins/<id>`,
  `stripe_bindings/<account>`, `ssh_bindings/<org>/<slug>`); a run finds it
  by that marker. A connection the owner made by hand is recognised by its
  non-secret values (the Vercel team id; SSH host, user, fingerprint) and
  kept: nothing is created next to it. A provider whose form holds only a
  secret (Cloudflare, Stripe) is recognised by the marker only.
- A mission is recognised by **provenance**: while it issues a mission, the
  importer's audit wrapper adds `v4_source = tokens/<v4 token id>` to the
  `mission-issued` entry; a later run reads the owner's `mission-issued`
  entries marked for this organization and finds the mission by that source.
  A renamed import is still recognised; a mission the owner made by hand
  with the same name is not taken for it. A mission the owner revoked is
  reported, not issued again. No schema change: the audit is the
  append-only record of where a mission came from. Its retention (90 days by
  default, `retention_days`) bounds how long a rerun recognises a mission;
  an import is completed within days, and a rerun after the entry is purged
  would issue the mission again (and say so, with a new key).
- `--reissue <v4 token id>` sets the recognition aside for that token: a
  new mission is issued beside the one found, which stays active and is
  named in the report. The provenance entries are read oldest first and a
  later one overwrites, so the newest issuance of a source is the one a
  later run recognises.
- A label is written only on an unlabelled resource.

A rerun creates what is missing and nothing else; the third run of a
complete import writes nothing and prints no key.

### D10 — One write per object, through the services; no global transaction

The checks of D4 are calls to the services' APIs. Holding the store's single
writer across them would stall the running instance on the same file. Each
object is written by its service as the interface writes it; a run stopped
half-way leaves whole objects, and D9 lets the next run finish. The bundle is
validated whole before the first write, the owner looked up before it.

### D11 — Where things are printed

The report goes to **stderr**; **stdout** carries only the mission keys of an
`--apply`, one JSON object per line `{ project, mission_id, token_name, key }`,
printed once. Keys are never in the report, a log line or the audit (the
entry holds the token prefix, as for any issuance). The gateway's own log
lines are reduced to errors and pass through a redactor holding every secret
of the bundle and of the configuration. An unknown argument is refused
without being echoed (it may be a secret pasted in the wrong place). Exit
codes: 0 done, 1 something was refused, 64 usage, 65 bundle refused, 67 owner
unknown, 77 root, 78 instance not configured.

The **exporter refuses a terminal or a regular file as stdout** (64): the
scrollback is a disk. The **importer reads the instance's configuration and
store before it reads stdin**, so a misconfigured container never ingests the
secrets; it **refuses a bundle older than an hour** (or claiming to come from
the future) unless `--allow-stale` — v4 may have revoked a key or a token
since, and an old bundle is a bundle someone kept. **Any unexpected failure**
prints one fixed line, never its message or a stack (`main.ts` and
`runImportCli` both catch). Names and refs from v4 are printed with control
characters blanked, so a crafted name cannot forge a report line; a
"secret" shorter than eight characters is refused (the redactor blanks every
secret everywhere).

## Consequences

- An organization moves in two commands (a dry run, then `--apply`), plus
  the accounts that must be connected by hand and a second run once they are.
- The tool is the only path by which a secret enters an instance outside the
  interface. Its surface is a pipe: no endpoint, no file, no argument. The
  plaintext exists in the operator's process memory, the pipe and the
  instance's process memory, then sealed.
- The importer is maintained against the v4 schema of `v4-final`, which no
  longer changes; it can be deleted once the last v4 organization has moved.
  The bundle is versioned so that a later exporter cannot be misread.
- Two lists of importable providers exist, on purpose: the exporter's, which
  decides what leaves the v4 database, and the importer's mapping, which
  refuses anything else. A test holds the exporter's SQL to its list; the
  schema holds the bundle to the importer's.
- SSH connections imported this way carry a key the v4 operator also held
  until v4 is switched off; the handbook asks for a reconnection afterwards.
- `npm run build` of the gateway also bundles the importer (a few seconds);
  the standalone smoke test runs it, the container smoke test checks it ships,
  refuses root and runs through the entrypoint.

Accepted after the review, not changed:

- `PGSSLMODE=require` encrypts but does not verify the pooler's certificate.
  `verify-full` needs the Supabase CA on the operator's machine, which is
  not trivial to ship and check from here; the exporter keeps `require`
  (what v4's own scripts used). A follow-up may read `PGSSLMODE` and
  `PGSSLROOTCERT` from `.env`.
- The budget line is the developer-like preset's, not the most restrictive
  across presets: v4 had no gates, so this widens nothing against v4; a later
  catalog edit can change what a new import gives.
- Connections owned by a group the owner belongs to count as the owner's
  (the v5 authority model): a group's Vercel account with the same team id is
  reused rather than duplicated.
- Provider error text in the report is redacted for the bundle's exact
  secrets only.

## Rejected alternatives

- **Re-create by hand (D7 as written).** The PO's reason for this ADR: too
  many connections, resources and setups across two organizations; errors in
  hand-copied policies would be silent.
- **An upload page or an API endpoint in the instance.** Secrets would cross
  a browser and an HTTP surface that stays in the product after the
  migration; a CLI in the container exists only where the operator already
  has a shell.
- **The instance reads the v4 database itself.** It would need the v4 master
  key and database password: the two secrets the importer must never see.
- **Importing GitHub, Railway and Supabase grants too.** The GitHub App is
  another company's (the instance creates its own); a refresh-token rotation
  by v5 would break v4 during the overlap, and the reverse.
- **Generating a new SSH pair.** Cleaner, but it needs a step on every VPS
  before the switch and breaks the "v4 keeps working until extinction"
  overlap; kept as the after-extinction step instead.
- **Issuing a mission without the services not yet connected.** It could not
  be completed later (D8): the owner would end with a second mission and a
  second key per project.
- **A conservative default budget for risks no preset carries.** It would
  invent quotas the catalog's authors never wrote; dropping and reporting
  keeps every number in the persisted policy traceable to a preset line.
- **Carrying unbudgeted risks with the `auto` gate, or by default** (second
  amendment). The operator's quota is a number no catalog author wrote; under
  `approval` each use is still the owner's decision, so the number only caps
  how often the owner is asked. Off by default: a run without the flag keeps
  the rule above.
- **No rate limit at all on a carried line** (the brief's wording). A budget
  without a rate limit cannot be persisted or enforced (spec §3.2,
  `budgetIssues`); a per-minute rate equal to the quota is the closest
  expressible form, and per minute keeps it editable and readable on the
  mission's page, which shows and edits rates per minute.
- **`--reissue` revoking the earlier mission.** Its key is installed in a
  project or on a VPS; revoking it before the new key is in place would cut
  the agent off. The owner revokes it from its page once the new key works.
- **`--reissue` recognising the previous mission by name.** Provenance only,
  as D9: a renamed import is still found, a hand-made namesake never is.
- **One transaction for the whole import.** See D10.
- **Shipping the importer as TypeScript run by `tsx`, or tracing it with
  Next.** The image carries neither the sources nor the dev dependencies, and
  Turbopack bundles packages into server chunks that a separate entry point
  cannot resolve. A `vaubaan-admin` command with sub-commands was not built:
  there is one command to ship.
- **A `pg` dependency in the exporter.** `psql` is on any operator's machine;
  a dependency would enter the supply chain for a one-shot tool.
