---
title: Fly.io provider plugin
tracks:
  - plugins/fly/src/
  - plugins/fly/README.md
  - apps/gateway/src/server/config/self-resources.ts
  - apps/gateway/src/server/requests/masked-arguments.ts
last_reviewed: 2026-10-27
---

# Fly.io provider plugin — handbook

`@vaubaan/plugin-fly`: native plugin on the Machines REST API (`https://api.machines.dev/v1`) and
the logs endpoint `fly logs` uses. Fly hosts no MCP server (`fly mcp server` is a local flyctl
process), hence native. The resource is a Fly app of the account's organization; its
environment is the owner's label, never parsed from the name. Rules common to every plugin:
[providers README](README.md).

## Start here

- [`src/call.ts`](../../../plugins/fly/src/call.ts) — `readFlyCall`, shared by classify and
  execute; app resolution, image guard.
- [`src/identifiers.ts`](../../../plugins/fly/src/identifiers.ts) — one grammar per kind.
- [`src/execute.ts`](../../../plugins/fly/src/execute.ts) — requests, app identity, snapshot,
  lease, secret redaction, discovery.
- [`src/created.ts`](../../../plugins/fly/src/created.ts) — the app `create_app` made.

## Invariants

- **Nothing hands out a Fly credential**: `deploy_token`, `/tokens/*` (beyond the paste check),
  `/secretkeys/*`, custom certificate upload and organization-wide lists stay out.
- **The organization is the account's** `org_slug`, never an argument: `create_app` and
  discovery cannot leave it. It changes what a refusal or audit line says, never which risk is
  touched (every pattern matches `org[*]`).
- **App names are reused after destruction**: before every write the executor reads the app and
  declines when its id or organization differs from the recorded `app_id`, or none is recorded.
- **Image guard**: every image a call gives a machine (`deploy_image`, a config's `image`,
  `containers[].image`, `files[].image_config`) is `<repo>[:tag]@sha256:<64 hex>` under one of the
  account's `image_prefixes` (default `ghcr.io/vaubaan/gateway`) at a path boundary
  (`…/gateway-evil` refused, registry with a port refused). Classify checks the copy discovery puts
  in metadata; execute checks again against the account field.
- **Image changes need a fresh snapshot**: each mounted volume must have one from the last 60
  minutes; `deploy_image` and `scale_machine` write under a lease, released even on failure.
- **Secret values never come back**: `show_secrets` is no argument and every secret answer passes an
  allow-list (name, digest, dates, version); `set_secrets` values are
  [masked on the approval page](../../decisions/secret-arguments-masked-in-the-approval-view.md).
- `update_machine` takes a whole config a pure classifier cannot diff, so it is priced as config +
  image + guest. `exec` is one risk, `data: secret`, not classified by its text: on a gateway
  instance even a read reaches the master key.
- `create_app` without `network` is refused: the default network reaches every app of the org.
- Restores read from the same app only (source volume or snapshot listed under its volumes).

## Traps

- `GET …/secrets?show_secrets=true` returns values (unlike `fly secrets list`).
- After `create_app`, `org_slug` and `image_prefixes` arrive with the discovery that follows: a
  deploy before it is refused with "refresh the account's resources".
- Machines pick up new secrets only when next updated: `deploy_image` with the same image applies
  them.
- The logs endpoint is "not officially supported for external use, but mostly stable": a change
  breaks `get_logs` only.
- The machine config has no registry-credential field: a private GHCR image cannot be pulled.

## Outside the repo

- Fly's OAuth serves extension partners only: use an organization token, from the dashboard's
  Tokens page (`https://fly.io/tokens`, Create Organization token) or
  `fly tokens create org --org <slug> --expiry 2160h`, never `fly auth token`. No caveat is asked:
  the token reaches the whole organization and the missions narrow it (ADR
  one-place-to-authorize-services-token-first, amended 2026-10-31); no tool needs the admin
  features a `NoAdminFeatures` caveat would remove, so a person may still attenuate the token. The paste check (`GET /v1/tokens/current`) requires every macaroon to name the
  organization. Revoke in the dashboard or `fly tokens revoke`.
- **The Fly organization that hosts a gateway is never connected to that gateway**: an org token
  reaches every app and org-level calls are bound to no resource. Any other app to keep out of reach
  goes in `self_resources` as `fly:<app name>`.

## Debug

- "no app id is recorded for it" / "no list of allowed images is recorded" → refresh the account's
  resources.
- Deploy declined for a snapshot → `create_snapshot` on each mounted volume, wait, retry.
- Image refused → pin a digest, under a listed prefix.
- An env-scoped write refused on a new app → label it (or set the account's default environment).
