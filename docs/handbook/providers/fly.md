---
title: Fly.io provider plugin
status: current
date: 2026-10-16
last_synced: 2026-10-16
tracks:
  - plugins/fly/src/
  - plugins/fly/tests/unit/
  - plugins/fly/README.md
  - apps/gateway/src/server/config/self-resources.ts
  - apps/gateway/src/server/requests/masked-arguments.ts
---

# Fly.io provider plugin

`@vaubaan/plugin-fly` 0.1.0, tool prefix `fly__`, provider id `fly`. One
plugin on Fly's **Machines REST API** (`https://api.machines.dev/v1`) and
the logs endpoint `fly logs` uses (`https://api.fly.io/api/v1/apps/{app}/logs`).
Modelled with [`provider-modeler`](../../skills/provider-modeler.md); the
research was validated by the product owner on 2026-10-16 (answers marked
**(PO)**). ADRs: [[plugin-contract-and-credential-spec]],
[`plugin-arguments-closed-surface-and-typed-refusals`](../../decisions/plugin-arguments-closed-surface-and-typed-refusals.md),
[`self-resources-never-reachable-by-a-mission`](../../decisions/self-resources-never-reachable-by-a-mission.md)
(amendment of 2026-10-16),
[`secret-arguments-masked-in-the-approval-view`](../../decisions/secret-arguments-masked-in-the-approval-view.md).
Contributor guide: [`plugins/fly/README.md`](../../../plugins/fly/README.md).

**Why.** Vaubaan's managed offer runs one isolated gateway instance per
customer in a Fly organization: one app on its own private network per
tenant, a volume (SQLite), secrets (master key, sign-in configuration), an
image from a private registry, autostop for the free tier, a region per
customer, rolling image upgrades with a snapshot before, daily snapshots, a
certificate for `<client>.vaubaan.app`. A coding agent, and later the
provisioner of the private `vaubaan/cloud` repository, operates this
through the dogfood gateway, under a mission. The tool surface is what that
work needs, and nothing that hands out a Fly credential.

## Sources

Context7, on 2026-10-16: library `/websites/fly_io` (docs.fly.io, 8 591
snippets) for the facts below, and `/superfly/docs` for flyctl commands. Pages
returned and used:

| Page (as Context7 cites it)                                                  | What it settled                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `docs.fly.io/api/machines/openapi.json`                                      | Every endpoint and schema: apps, machines, leases, exec, volumes, snapshots, secrets, IP assignments, certificates, `tokens/current` |
| `docs.fly.io/machines/api/working-with-machines-api`                         | Base URL, status codes, rate limits (1 req/s per action and machine, burst 3)                                                        |
| `docs.fly.io/api/machines/secrets/list-app-secrets-belonging-to-an-app`      | `show_secrets=true` returns the values (§5.6)                                                                                        |
| `docs.fly.io/apps/secrets`                                                   | `fly secrets list` shows name, digest, date; machines pick up new secrets when updated                                               |
| `docs.fly.io/machines/api/volumes-resource`, `docs.fly.io/volumes/snapshots` | Restore by `snapshot_id`, daily snapshots, retention 1–60 days                                                                       |
| `docs.fly.io/apps/delete`                                                    | "When you destroy an app, you delete its volumes and volume snapshots"                                                               |
| `docs.fly.io/monitoring/metrics`                                             | `Authorization: FlyV1 <token>` for every token of `fly tokens create`; `Bearer` for `fly auth token`                                 |
| `docs.fly.io/machines/runtime-environment`                                   | `FLY_APP_NAME` is set in every machine (§5.10)                                                                                       |
| `docs.fly.io/security/tokens`, `superfly/docs` `flyctl/cmd/fly_tokens_*`     | Org, read-only, deploy, ssh, machine-exec tokens; expiry; `fly tokens attenuate`                                                     |
| `docs.fly.io/monitoring/logs-api-options`                                    | Logs endpoint, "not officially supported for external use, but mostly stable"                                                        |
| `docs.fly.io/reference/extensions_api`                                       | Fly's OAuth serves extension partners, scope `read` only                                                                             |
| `superfly/docs` `flyctl/cmd/fly_mcp*`                                        | `fly mcp server` is an experimental local flyctl process; Fly hosts no MCP server                                                    |

Caveat types of macaroons (`NoAdminFeatures`, `Apps`, `Commands`…) come from
Fly's own `superfly/macaroon` repository (`flyio/caveats.md`), which Context7
does not index.

### Rewrap or native — native

Fly hosts no MCP server; `fly mcp server` drives flyctl locally and is
experimental. Rewrapping it would mean shipping flyctl in the gateway image
and a process per connection, with an unpublished tool list. The Railway
rewrap ([[railway-rewrap-remote-mcp]]) rests on a hosted, Bearer-stateless
server, and the Vercel augmentation ([[vercel-augment-with-rest-tools]])
completes a hosted server: neither applies. The Machines API's OpenAPI covers
everything the use case needs, IP addresses and certificates included, so
the GraphQL API is not used.

## 1. Data model

One plane, `apps`. **The resource is a Fly app** of the connection's
organization, `ref` = the app name.

```
fly.org[O]                                  O = org slug of the connection
  .region[*]                                platform regions (read)
  .app                                      collection: W = create an app
  .app[A]                                   A = app name   ← the RESOURCE (envScopable)
    .app-destroy
    .machine                                collection: W = create a machine
      .config / .image                      (a creation sets both)
    .machine[M]                             M = machine id
      .config / .image / .guest / .power / .exec / .machine-destroy
      .event[*] / .process[*]               reads
    .volume                                 collection: W = create a volume
      .restore / .backup-settings           (a creation from a source, or with backup settings)
    .volume[V]                              V = volume id
      .extend / .backup-settings / .snapshot / .volume-destroy
      .snapshot[*]                          read
    .secret[N] / .secret[N1,N2]             N = secret name; values never read
    .ip / .ip[X]                            X = address (IPv6 written [*]); .ip-release
    .certificate[H]                         H = hostname; .certificate-remove
    .logs                                   read
```

**How `O` is known.** The classifier receives the connection's public form
fields (`ClassifyConnection`, ADR
[classify-sees-the-connection-public-fields](../../decisions/classify-sees-the-connection-public-fields.md))
and cites their `org_slug` — the organization `execute` sends to Fly and
checks every app against. When the field is absent or malformed (a host that
passes none, catalog tooling), it falls back to the organization the
mission's apps share (their discovered `org_slug`), then to `org[*]`. Every
catalog pattern matches `org[*]`, so the name changes what a refusal or an
audit entry says (`fly.org[vaubaan].app.W` for a `create_app` in a mission
with no app, where it used to say `fly.org[*].app.W`), never which risk is
touched. The organization is never read from the arguments (§5.1).

Every leaf name is unique in the plane (`app-destroy`, `machine-destroy`,
`volume-destroy`, `ip-release`, `certificate-remove`), so a pattern says what
it acts on without its path.

**Environment: the owner's label on the app** (Railway and Supabase
precedent, no `envOf`): `prod` for customer instances — the free tier
included **(PO, Q10)** — and `staging` for canary and internal instances. No
third label. The app name is never parsed for an environment.

## 2. Tool → slice mapping

42 tools. `A` is the resolved app (§5.1); the slice prefix `fly.org[O].app[A]`
is written `app[A]`.

| Tool                                                                     | Endpoint                                                           | Slice(s)                                                                          |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `list_regions`                                                           | `GET /platform/regions`                                            | `org[O].region[*].R`                                                              |
| `list_apps`                                                              | `GET /apps?org_slug=O` (filtered to the mission)                   | `org[O].app[*].R`                                                                 |
| `create_app`                                                             | `POST /apps` (`name`, `network` required, `org_slug` forced)       | `org[O].app.W`                                                                    |
| `get_app` / `destroy_app`                                                | `GET` / `DELETE /apps/{A}`                                         | `app[A].R` / `app[A].app-destroy.W`                                               |
| `list_machines`, `get_machine`, `wait_machine`                           | `GET /apps/{A}/machines[/{M}[/wait]]`                              | `app[A].machine[*].R`, `app[A].machine[M].R`                                      |
| `list_machine_events` / `list_machine_processes`                         | `GET …/{M}/events` / `…/{M}/ps`                                    | `machine[M].event[*].R` / `machine[M].process[*].R`                               |
| `create_machine`                                                         | `POST /apps/{A}/machines`                                          | `machine.W` + `machine.config.W` + `machine.image.W`                              |
| `update_machine`                                                         | `POST /apps/{A}/machines/{M}` (whole config)                       | `machine[M].config.W` + `machine[M].image.W` + `machine[M].guest.W`               |
| `deploy_image`                                                           | lease, `GET`, `POST` with only `image` changed, release            | `machine[M].image.W`                                                              |
| `scale_machine`                                                          | lease, `GET`, `POST` with only `guest` changed, release            | `machine[M].guest.W`                                                              |
| `start/stop/restart/suspend/cordon/uncordon_machine`                     | `POST …/{M}/<verb>`                                                | `machine[M].power.W`                                                              |
| `destroy_machine` / `exec_machine`                                       | `DELETE …/{M}` / `POST …/{M}/exec`                                 | `machine[M].machine-destroy.W` / `machine[M].exec.W`                              |
| `list_volumes`, `get_volume`, `list_snapshots`                           | `GET /apps/{A}/volumes[/{V}[/snapshots]]`                          | `volume[*].R`, `volume[V].R`, `volume[V].snapshot[*].R`                           |
| `create_volume`                                                          | `POST /apps/{A}/volumes`                                           | `volume.W` (+ `volume.restore.W` with a source, + `volume.backup-settings.W`)     |
| `extend_volume` / `update_volume` / `create_snapshot` / `destroy_volume` | `PUT …/extend` / `PUT …/{V}` / `POST …/snapshots` / `DELETE …/{V}` | `volume[V].extend.W` / `.backup-settings.W` / `.snapshot.W` / `.volume-destroy.W` |
| `list_secrets`                                                           | `GET /apps/{A}/secrets` (redacted)                                 | `secret[*].R`                                                                     |
| `set_secrets` / `unset_secret`                                           | `POST /apps/{A}/secrets` / `DELETE …/secrets/{N}`                  | `secret[N1,N2,…].W` / `secret[N].W`                                               |
| `list_ips` / `allocate_ip` / `release_ip`                                | `GET` / `POST /apps/{A}/ip_assignments`, `DELETE …/{X}`            | `ip[*].R` / `ip.W` / `ip[X].ip-release.W`                                         |
| `list_certificates`, `get_certificate`                                   | `GET /apps/{A}/certificates[/{H}]`                                 | `certificate[*].R`, `certificate[H].R`                                            |
| `request_certificate` / `check_certificate` / `remove_certificate`       | `POST …/certificates/acme` / `POST …/{H}/check` / `DELETE …/{H}`   | `certificate[H].W` / `certificate[H].W` / `certificate[H].certificate-remove.W`   |
| `get_logs`                                                               | `GET https://api.fly.io/api/v1/apps/{A}/logs`                      | `app[A].logs.R`                                                                   |

**Why `update_machine` touches three risks.** Fly updates a machine with its
whole config. A pure classifier cannot diff it against the current one, so a
replacement is priced as all it can change. `deploy_image` and
`scale_machine` change one field each and need one risk each.

**Only declared arguments.** `execute` builds JSON bodies from the
arguments, so the argument surface is closed: `undeclaredArgumentDenial`
runs in `readFlyCall`, which `classify` and `execute` both call, after the
app is resolved. `show_secrets`, `force`, `org_slug`, `machine` (exec in the
machine namespace) are refused as undeclared.

**Left out on purpose** (spec §7.2): `POST /apps/{app}/deploy_token` (hands
out a Fly credential), `/tokens/*` (token plumbing; `tokens/current` serves
the check at paste only), `/secretkeys/*` (decrypt and sign), custom
certificate upload (a private key in the body), machine metadata, signals,
memory, organization-wide machine and volume lists (they cross tenants),
Managed Postgres.

## 3. Catalog and presets

`src/risk-catalog.yaml`, `catalog_version: 1`: 24 named risks and
`fly.uncategorized-write`. Write patterns are exact: a write slice touches
the risk named for it, and a call doing several things emits several slices.
**Env-scoped `[staging, prod]`**: every write on an existing app's state.
**Not env-scoped**: the four reads, `app-create` (a creation names no
resource, so no label can exist), `volume-create` (empty) and
`volume-snapshot`.

| Risk                            | Vector (rev / blast / data / cost / vis / persist)               | Why it is its own decision                                 |
| ------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| `read-org`                      | reversible / account / metadata / free / internal / stateless    | The list of apps is the list of customers.                 |
| `read-runtime`                  | reversible / single / data / free / internal / stateless         | Configs hold plain env variables.                          |
| `read-secret-names`             | reversible / single / metadata / …                               | Names and digests; values redacted.                        |
| `read-logs`                     | reversible / single / pii / …                                    | Logs carry customer data.                                  |
| `app-create`                    | reversible / account / metadata / moderate / internal / posture  | A new tenant; own network required.                        |
| `app-destroy`                   | irreversible / env / pii / free / public / posture               | Volumes and snapshots go with the app.                     |
| `machine-create`                | reversible / single / metadata / moderate / internal / session   | Billed VM; touches config and image too.                   |
| `machine-config-write`          | costly / single / secret / moderate / public / posture           | A config can run anything with the app's secrets.          |
| `deploy`                        | reversible / single / secret / free / public / session           | The image runs with the app's secrets and volume.          |
| `scale`                         | reversible / single / metadata / unbounded / internal / session  | Cost.                                                      |
| `machine-power`                 | reversible / single / metadata / free / public / session         | Availability only.                                         |
| `machine-destroy`               | costly / single / metadata / free / public / session             | Rebuild needed; volumes stay.                              |
| `machine-exec`                  | irreversible / env / secret / free / internal / posture          | Reads the master key and every sealed account of a tenant. |
| `volume-create`                 | reversible / single / metadata / moderate / internal / session   | Empty storage.                                             |
| `volume-restore`                | costly / single / pii / moderate / internal / session            | Copies data, possibly old.                                 |
| `volume-extend`                 | irreversible / single / metadata / moderate / internal / posture | Never shrinks.                                             |
| `volume-backup-settings`        | reversible / single / data / moderate / internal / posture       | Less to restore from.                                      |
| `volume-snapshot`               | reversible / single / metadata / moderate / internal / stateless | Changes nothing that runs.                                 |
| `volume-destroy`                | irreversible / single / pii / free / internal / posture          | Only snapshots remain.                                     |
| `secret-write`                  | costly / env / secret / free / internal / posture                | A wrong master key or sign-in setting locks an instance.   |
| `ip-write` / `ip-release`       | reversible / … / public / posture; irreversible for release      | Exposure and cost; a released dedicated address is lost.   |
| `certificate-write` / `-remove` | reversible / costly, public / posture                            | HTTPS of a customer hostname.                              |

`machine-config-write` and `deploy` override `visibility: internal` on
staging. Each risk carries `infra_limits.calls_per_minute_max` under Fly's
own per-action limit.

### Presets

`quota · rate per minute · gate`; `s|p` = one entry per environment.

| Risk                     | `read-only`       | `operator`                        | `fleet-upgrade`          | `provisioner`           |
| ------------------------ | ----------------- | --------------------------------- | ------------------------ | ----------------------- |
| `read-org`               | 2000 · 60 · auto  | same                              | same                     | same                    |
| `read-runtime`           | 5000 · 120 · auto | same                              | same                     | same                    |
| `read-secret-names`      | 500 · 30 · auto   | same                              | —                        | same                    |
| `read-logs`              | 1000 · 30 · auto  | same                              | same                     | same                    |
| `app-create`             | —                 | —                                 | —                        | 10 · 2 · auto           |
| `app-destroy`            | —                 | —                                 | —                        | s 5, p 2 · **approval** |
| `machine-create`         | —                 | —                                 | —                        | s\|p 20 · 5 · auto      |
| `machine-config-write`   | —                 | s 50 · auto; p 10 · **approval**  | —                        | s 50, p 20 · auto       |
| `deploy`                 | —                 | s 100 · auto; p 20 · **approval** | s 200, p 500 · 10 · auto | s 50, p 20 · auto       |
| `scale`                  | —                 | s auto; p **approval**            | —                        | s\|p auto               |
| `machine-power`          | —                 | s\|p 200 · 20 · auto              | s\|p 500 · 20 · auto     | s\|p 100 · 20 · auto    |
| `machine-destroy`        | —                 | s auto; p **approval**            | —                        | s auto; p **approval**  |
| `machine-exec`           | —                 | s\|p 10 · 2 · **approval**        | —                        | —                       |
| `volume-create`          | —                 | auto                              | —                        | auto                    |
| `volume-restore`         | —                 | s\|p **approval**                 | —                        | s\|p **approval**       |
| `volume-extend`          | —                 | s auto; p **approval**            | —                        | s\|p auto               |
| `volume-backup-settings` | —                 | s\|p **approval**                 | —                        | s\|p auto               |
| `volume-snapshot`        | —                 | 100 · 10 · auto                   | 500 · 10 · auto          | 50 · 10 · auto          |
| `volume-destroy`         | —                 | s **approval**                    | —                        | s\|p **approval**       |
| `secret-write`           | —                 | s\|p **approval**                 | —                        | s\|p **approval**       |
| `ip-write`               | —                 | s\|p **approval**                 | —                        | s\|p auto               |
| `ip-release`             | —                 | s\|p **approval**                 | —                        | s\|p **approval**       |
| `certificate-write`      | —                 | s\|p auto                         | —                        | s\|p auto               |
| `certificate-remove`     | —                 | s\|p **approval**                 | —                        | s\|p **approval**       |

**Gates (PO, Q5 and the brief):** destroying an app or a volume, writing
secrets and `exec` ask first in every preset that has them; `exec` is in
`operator` only. **`fleet-upgrade` (PO, Q9)** lets production image changes
run freely, which is acceptable only because every image change goes
through the image guard (§5.5) and the fresh-snapshot guard (§5.6). The
fallback is in no preset; every named risk is in at least one.

## 4. Coverage

| Risk                                                   | Tools                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `read-org`                                             | `list_regions`, `list_apps`, `get_app`                                     |
| `read-runtime`                                         | machine, volume, snapshot, IP and certificate reads (11 tools)             |
| `read-secret-names` / `read-logs`                      | `list_secrets` / `get_logs`                                                |
| `app-create` / `app-destroy`                           | `create_app` / `destroy_app`                                               |
| `machine-create`                                       | `create_machine`                                                           |
| `machine-config-write`                                 | `create_machine`, `update_machine`                                         |
| `deploy`                                               | `create_machine`, `update_machine`, `deploy_image`                         |
| `scale`                                                | `update_machine`, `scale_machine`                                          |
| `machine-power`                                        | the six power tools                                                        |
| `machine-destroy` / `machine-exec`                     | `destroy_machine` / `exec_machine`                                         |
| `volume-create` / `volume-restore`                     | `create_volume` (with `snapshot_id` or `source_volume_id` for the restore) |
| `volume-backup-settings`                               | `update_volume`, `create_volume` with backup settings                      |
| `volume-extend` / `volume-snapshot` / `volume-destroy` | `extend_volume` / `create_snapshot` / `destroy_volume`                     |
| `secret-write`                                         | `set_secrets`, `unset_secret`                                              |
| `ip-write` / `ip-release`                              | `allocate_ip` / `release_ip`                                               |
| `certificate-write` / `certificate-remove`             | `request_certificate`, `check_certificate` / `remove_certificate`          |
| `uncategorized-write`                                  | none: `fallbackHits` is empty in `plugin.test.ts`                          |

## 5. Edge cases

### 5.1 Which app a call is on

`resolveApp`: `app` must be an app name and one of the mission's Fly apps;
absent, the mission's single app; otherwise refused (ambiguous, none,
outside the mission, malformed). A resource whose ref is not an app name is
never used. `org_slug` is no argument: `create_app` and discovery take the
connection's organization, so a call never leaves it.

### 5.2 One organization hosts every customer

Discovery lists every tenant app. A mission selects apps; quotas are per
mission, so a `fleet-upgrade` mission over many tenants has its quotas
raised deliberately. Machine, volume and snapshot ids are always under
`/apps/{A}/…`: an id of another app answers 404 at Fly.

### 5.3 App names are reused after destruction

The ref is the name (Fly's paths use it). Discovery records `app_id`; before
every write on an app, `execute` reads `GET /apps/{A}` and declines when the
id or the organization differs, or when no id is recorded (refresh the
resources).

### 5.4 Creation names no resource — two steps **(PO, Q1)**

`create_app` is `org[O].app.W`, not env-scoped. The new app is not part of
the mission: the agent creates it; a person refreshes the account's
resources, labels the app and adds it to the mission (or issues another);
then the configuration runs. A one-shot provisioner needs a core change —
see "Open questions".

### 5.5 The image guard **(PO, Q4)**

An image runs with the app's secrets and volume (Fly: "people with deploy
access can deploy code that reads secret values"). Every image a call gives
a machine — `deploy_image`'s `image`, a config's `image`, each
`containers[].image`, each `files[].image_config` — must be
`<repository>[:tag]@sha256:<64 lower-case hex>` with the repository under
one of the connection's prefixes, at a path boundary
(`ghcr.io/vaubaan/gateway` accepts `ghcr.io/vaubaan/gateway/edge`, refuses
`ghcr.io/vaubaan/gateway-evil`). The prefixes are the connection's
`image_prefixes` field (default `ghcr.io/vaubaan/gateway`); discovery copies
them into each app's metadata so the pure classifier refuses with a typed
denial, and `execute` checks again against the field itself. A registry
with a port is not accepted.

### 5.6 Image changes need a fresh snapshot **(PO, Q9)**

`deploy_image`, and `update_machine` when the image changes, read the
machine, then, for each volume it mounts, require a snapshot `created` in
the last `SNAPSHOT_FRESH_MINUTES` (60) — otherwise declined with the steps
(`create_snapshot`, wait, retry). A machine without volumes needs none.
`deploy_image` and `scale_machine` write under a lease (TTL 120 s) with
`current_version`, and release it even when the update fails.

### 5.7 Secrets **(PO, Q6)**

Context7 confirms that `GET …/secrets?show_secrets=true` returns values,
contrary to `fly secrets list`. `show_secrets` is no argument, and every
secret answer goes through an allow-list (`name`, `digest`, `created_at`,
`updated_at`, `version`): any other non-empty field becomes `[redacted by
Vaubaan]` (ADR self-resources §3). There is no "read secret values" risk.
`set_secrets` carries values in its arguments: the plugin declares
`secretArguments: { fly__set_secrets: ['values'] }`, and the approval page
shows each value as `[secret · sha256:<12 hex>]`, names kept (ADR
secret-arguments-masked-in-the-approval-view). Machines pick up new secrets
when next updated: `deploy_image` with the same image applies them.

### 5.8 `exec` is a shell with the app's secrets **(PO, Q5)**

Kept, one risk, `data: secret`, irreversible, asked first in the only preset
that has it. Commands are not classified by their text (unlike SSH): on a
Vaubaan instance even a read reaches the master key. `machine` is not
declared; `timeout` is capped at 60 s; stdout and stderr are cut at 64 KiB.

### 5.9 Restores read from the same app

`source_volume_id` must answer under `/apps/{A}/volumes/{id}`; `snapshot_id`
must be listed under one of the app's current volumes (50 searched). A
snapshot of a destroyed volume cannot be restored through the plugin.

### 5.10 Self resources and the control plane **(PO, Q7, Q8)**

An instance on Fly counts `fly:$FLY_APP_NAME` among its self resources
(`config/self-resources.ts`), as Railway's project. **Rule: the control
plane (the `vaubaan/cloud` provisioner, any Vaubaan app that is not a
tenant) lives in a Fly organization separate from the tenants', never
connected to the gateway it hosts.** Organization-level calls (`create_app`,
`list_apps`) are not bound to a resource, and an organization token reaches
every app. Any other non-tenant app in the tenant organization is listed in
`self_resources` as `fly:<app name>`. Tenants are gateways too: `deploy`,
`machine-config-write` and `exec` on one reach every account its customer
connected, hence `data: secret`.

### 5.11 Network isolation **(PO, Q3)**

`create_app` without `network` is refused: an app on the organization's
default network reaches every other tenant over the private network.

### 5.12 Autostop, region, size

Autostop (`services[].autostop`, `min_machines_running`) and the region are
in the config and the creation body: priced by `machine-create` and
`machine-config-write`. The region is immutable after creation.

### 5.13 Logs

`api.fly.io/api/v1/apps/{A}/logs` is Fly's unsupported-but-stable endpoint;
a change breaks `get_logs` only.

## 6. Credential, discovery, execution, tests

### 6.1 Credential — `api-key`, an organization token **(PO, Q2)**

Fly's OAuth serves extension partners only (`read`), so a token is the only
way. Fields: `api_token` (secret; `^(FlyV1 )?fm[12]_…`, one or several
macaroons), `org_slug`, `image_prefixes` (optional). The guide asks for
`fly tokens create org --org <slug> --expiry 2160h`, attenuated with
`[{"type":"NoAdminFeatures","body":{}}]` through `fly tokens attenuate`, and
never `fly auth token`. The token is sent as `Authorization: FlyV1 <token>`
(the prefix is added when pasted without it). **Check at paste**
(`verifyFlyToken`): `GET /v1/tokens/current` must describe at least one
macaroon, all for the named organization; the account reads "the
`<organization>` organization", with "(N apps only)" for a token restricted
to apps; malformed prefixes are refused first. Expiry is not exposed
(`null`). Revocation: the dashboard (organization, Tokens) or
`fly tokens revoke`.

### 6.2 Discovery

`GET /v1/apps?org_slug=<org>&limit=500[&cursor]`, up to `MAX_DISCOVERED_APPS`
(2000). Each app passes a type guard and `appName`; an app of another
organization fails discovery. Resource: `ref` = name, `displayName` = name,
`metadata` = `app_id`, `org_slug`, `network`, `image_prefixes`.

### 6.3 Execution

`ctx.fetch` only. 401 / 403 → `UpstreamAuthError`, any other failure →
`UpstreamHttpError`; a 404 is an answer only in the restore lookup. Every
refusal of the executor is an `ExecutorRefusal` under `declining`. Guards:
app identity before writes (§5.3), image (§5.5), fresh snapshot (§5.6),
restore source (§5.9), secret redaction (§5.7), `list_apps` filtered to the
mission, exec limits (§5.8).

### Identifiers

One grammar per kind in `src/identifiers.ts`, used by `readFlyCall` (so by
`classify` and `execute`):

| Value                                | Grammar                                                | Where it lands                     |
| ------------------------------------ | ------------------------------------------------------ | ---------------------------------- |
| app name (argument and resource ref) | `^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`               | URL path, slice `app[A]`           |
| machine, volume, snapshot id         | `pathIdent` `^[A-Za-z0-9_-]{1,64}$`                    | URL path, slices                   |
| secret name                          | `^[A-Za-z_][A-Za-z0-9_]{0,127}$`                       | URL path (unset), JSON keys, slice |
| hostname                             | lower-case DNS labels, ≥ 2, ≤ 253, no wildcard         | URL path, slice                    |
| IP address                           | `net.isIP`; percent-encoded in the path; IPv6 as `[*]` | URL path                           |
| org slug, network                    | `^[a-z0-9][a-z0-9_-]{0,62}$`                           | JSON body, query                   |
| region, volume name, log cursor      | `^[a-z]{3}$`, `^[A-Za-z0-9_]{1,64}$`, `^[0-9]{1,25}$`  | JSON body, query                   |
| image                                | `PINNED_IMAGE` + prefix match (§5.5)                   | JSON body                          |

### 6.4 Tests

`npx vitest run plugins/fly` — 74: `plugin.test.ts` (7: the kit, coverage of
all 42 tools with no fallback hit and no risk untouched,
`assertIdentifiersRefused`, identity, version), `classify.test.ts` (29:
every branch and refusal, the image guard, hostile identifiers through
`classify` and `execute`), `execute.test.ts` (32: requests, the guards,
lease, redaction, discovery, the token check), `risk-catalog.test.ts` (6:
gates, preset contents, data model). Host side:
`apps/gateway/tests/unit/server/requests/masked-arguments.test.ts`,
`apps/gateway/tests/unit/server/config/self-resources.test.ts`, and the
`secretArguments` cases of the SDK's `define-plugin.test.ts`.

## Open questions

1. **A created resource joins the mission (future spec change, PO Q1 (b)).**
   A resource created by a mission would join it, with an environment the
   creation declares and the mission must hold (`fly[prod].machine-create`…),
   recorded in the audit. A change to `gateway-risk-model` §5/§6 and the
   connections handbook, needed before self-service sign-up.
2. **Per-call attenuation (PO Q2, later).** `execute` could attenuate the
   stored token to the mission's app ids (`Apps` caveat) before each call,
   making the restriction hold at Fly's side. Needs a macaroon
   implementation in TypeScript.
3. **Private GHCR pulls.** The machine config has no registry-credential
   field in the OpenAPI; Fly documents `registry.fly.io/<app>` (images
   reusable across apps of one organization). The release pipeline either
   mirrors images there (then add `registry.fly.io/` to `image_prefixes`) or
   makes the GHCR package public. A release question, not a plugin one.
4. **Not in the sources, kept conservative:** the exact app-name grammar
   (the plugin accepts Fly's documented lower case, digits and hyphens, at
   most 63), whether `create_volume` would accept another app's snapshot
   (the executor refuses it anyway), and a token's expiry in
   `tokens/current` (not read).
