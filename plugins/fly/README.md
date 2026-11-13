# `@vaubaan/plugin-fly`

Fly.io for Vaubaan Gateway: the apps of one Fly organization, their
machines and images, volumes and snapshots, secrets, IP addresses and
certificates, through the Machines REST API (`https://api.machines.dev/v1`),
and the app logs `fly logs` reads. Usable for any Fly organization, gateway
instances included.

Handbook (the model and its reasons):
[`docs/handbook/providers/fly.md`](../../docs/handbook/providers/fly.md).
Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).

## Data model

One plane, `apps`:

```
org[<slug>]                         the organization of the connection
  ├─ region[*]                      platform regions (read)
  └─ app[<app name>]                the resource; labelled staging / prod by its owner
       ├─ app-destroy               verb leaf
       ├─ machine[<id>]             config · image · guest · power · exec · machine-destroy · event[*] · process[*]
       ├─ volume[<id>]              extend · backup-settings · snapshot[*] · volume-destroy
       │    (collection: restore, backup-settings at creation)
       ├─ secret[<name>]            names only; values never read
       ├─ ip[<address>]             ip-release
       ├─ certificate[<hostname>]   certificate-remove
       └─ logs
```

## Credential and resources

Kind `api-key`, three fields:

| Field            | Secret | Purpose                                                                                                                                            |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_token`      | yes    | An organization token (dashboard Tokens page, or `fly tokens create org`). Sent as `Authorization: FlyV1 …`. Never `fly auth token`.               |
| `org_slug`       | no     | The one organization the connection works in. Checked at paste against `GET /v1/tokens/current`: a token reaching another organization is refused. |
| `image_prefixes` | no     | Repository prefixes machines may run, comma-separated; empty means `ghcr.io/vaubaan/gateway`.                                                      |

Fly offers OAuth to extension partners only (scope `read`), so a token is
the only way. `discoverResources` lists the organization's apps
(`GET /v1/apps?org_slug=…`, cursor pages of 500, **at most 2000 apps**) and
returns **one resource per app**: `ref` = the app name, with `app_id`,
`org_slug`, `network` and `image_prefixes` in its metadata.

## Tools

42 tools named `fly__<verb>_<noun>`. Every tool on an app takes `app` (one
of the mission's apps; optional when the mission has one).

| Group        | Tools                                                                                                                                                                                                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Organization | `list_regions`, `list_apps` (mission apps only), `create_app` (`network` required)                                                                                                                                                                                                                                   |
| App          | `get_app`, `destroy_app`                                                                                                                                                                                                                                                                                             |
| Machines     | `list_machines`, `get_machine`, `list_machine_events`, `list_machine_processes`, `wait_machine`, `create_machine`, `update_machine`, `deploy_image`, `scale_machine`, `start_machine`, `stop_machine`, `restart_machine`, `suspend_machine`, `cordon_machine`, `uncordon_machine`, `destroy_machine`, `exec_machine` |
| Volumes      | `list_volumes`, `get_volume`, `list_snapshots`, `create_volume`, `extend_volume`, `update_volume`, `create_snapshot`, `destroy_volume`                                                                                                                                                                               |
| Secrets      | `list_secrets` (names and digests), `set_secrets`, `unset_secret`                                                                                                                                                                                                                                                    |
| Addresses    | `list_ips`, `allocate_ip`, `release_ip`                                                                                                                                                                                                                                                                              |
| Certificates | `list_certificates`, `get_certificate`, `request_certificate`, `check_certificate`, `remove_certificate`                                                                                                                                                                                                             |
| Logs         | `get_logs`                                                                                                                                                                                                                                                                                                           |

Undeclared arguments are refused by `classify` and by `execute`
(`show_secrets`, `force`, `org_slug`…). Left out on purpose: deploy tokens,
OIDC/KMS tokens, secret keys (decrypt/sign), custom certificate upload,
metadata, memory, signals, organization-wide lists, Managed Postgres.

Guards of the executor: the app is still the one discovered (same id and
organization) before any write; images pinned by `@sha256:` digest under the
allowed prefixes; a fresh snapshot (last 60 minutes) of every mounted volume
before an image change; restores from the same app only; secret values
redacted from every answer; `exec` capped at 60 s and 64 KiB of output.

## Catalog

`src/risk-catalog.yaml`: 24 named risks and the fallback.

| Risk                         | Env-scoped | Notes                                                                |
| ---------------------------- | ---------- | -------------------------------------------------------------------- |
| `fly.read-org`               |            | Apps and regions of the organization.                                |
| `fly.read-runtime`           |            | Machines, volumes, snapshots, addresses, certificates.               |
| `fly.read-secret-names`      |            | Names and digests only.                                              |
| `fly.read-logs`              |            | May carry customer data.                                             |
| `fly.app-create`             |            | Creation names no resource; own network required.                    |
| `fly.app-destroy`            | yes        | Irreversible: volumes and snapshots go with it.                      |
| `fly.machine-create`         | yes        | With `machine-config-write` and `deploy`.                            |
| `fly.machine-config-write`   | yes        | `data: secret`: a config can run anything.                           |
| `fly.deploy`                 | yes        | `data: secret`: the image runs with the app's secrets.               |
| `fly.scale`                  | yes        | `cost: unbounded`.                                                   |
| `fly.machine-power`          | yes        | Start, stop, restart, suspend, cordon, uncordon.                     |
| `fly.machine-destroy`        | yes        |                                                                      |
| `fly.machine-exec`           | yes        | Irreversible, `data: secret`.                                        |
| `fly.volume-create`          |            | Empty volume.                                                        |
| `fly.volume-restore`         | yes        | From a snapshot or a volume of the same app.                         |
| `fly.volume-extend`          | yes        | Never shrinks.                                                       |
| `fly.volume-backup-settings` | yes        | Daily snapshots and retention.                                       |
| `fly.volume-snapshot`        |            |                                                                      |
| `fly.volume-destroy`         | yes        | Irreversible.                                                        |
| `fly.secret-write`           | yes        | Values masked in the approval view.                                  |
| `fly.ip-write`               | yes        |                                                                      |
| `fly.ip-release`             | yes        |                                                                      |
| `fly.certificate-write`      | yes        | Request or check (ACME).                                             |
| `fly.certificate-remove`     | yes        |                                                                      |
| `fly.uncategorized-write`    |            | Fallback (`fallback: true`); reached by no tool, in no macro-action. |

## Macro-actions

A creator ticks macro-actions, each at a trust level (Careful / Trusting /
Autonomous, risk model §4.6); the trust level sets each risk's gate from its vector and
multiplies the base budget. The fallback sits apart, under "Anything else".

| Macro-action | What it covers                                               | Its risks                                                                                                              |
| ------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `observe`    | Apps, machines, volumes, secret names and logs.              | `read-org`, `read-runtime`, `read-secret-names`, `read-logs`                                                           |
| `operate`    | Deploy, power, resize, snapshot, certificates and shell.     | `deploy`, `machine-power`, `scale`, `volume-snapshot`, `volume-backup-settings`, `certificate-write`, `machine-exec`   |
| `build`      | Create apps, machines, volumes and addresses.                | `app-create`, `machine-create`, `machine-config-write`, `volume-create`, `volume-extend`, `volume-restore`, `ip-write` |
| `secrets`    | Set or remove app secrets.                                   | `secret-write`                                                                                                         |
| `tear-down`  | Destroy machines, volumes, apps, addresses and certificates. | `machine-destroy`, `volume-destroy`, `app-destroy`, `ip-release`, `certificate-remove`                                 |

Destroying an app or a volume and `exec` are irreversible: left out at
Careful, they ask first at every other trust level. Writing secrets and scaling
(an unbounded cost) ask first below Autonomous. Deploys, machine power,
volumes, addresses and certificates are repairable but worth a look (a public
effect, a moderate cost or secrets): they ask first at Careful and run freely
from Trusting.

## Tests

`npx vitest run plugins/fly` — 74 tests: the SDK kit (`assertPluginWellFormed`,
`assertNoWildcard`, `assertCatalogCoverage` on one
sample per tool, `assertIdentifiersRefused`), the classifier branch by
branch (refusals, the image guard, hostile identifiers fed to `classify`
and `execute`), the executor and its guards, discovery and the token check
against `mockFetch`, and the gates each trust level gives. No test calls Fly.
