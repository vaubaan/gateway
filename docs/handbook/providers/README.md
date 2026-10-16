---
title: Provider plugin handbooks — index
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - plugins/*/src/risk-catalog.yaml
  - plugins/*/src/index.ts
---

# Provider plugin handbooks

One handbook per provider plugin (`plugins/<id>`). Every shipped plugin is on
the v5 plugin SDK (2026-10-13) and was brought to one consistent
surface since: catalog loaded with `catalogPathNextTo`, fallback
entry flagged `fallback: true`, no preset on the fallback, standard `oauth2`
refresh performed by the host. Each handbook covers the same six subjects, under headings of its own
(spec [`gateway-risk-model.md`](../../spec/gateway-risk-model.md),
[`vaubaan-gateway.md`](../../spec/vaubaan-gateway.md) §5):

1. **Data model** — the entities of each plane, cardinalities, the
   `envScopable` entity.
2. **Tool → slice mapping** — the slice(s) each MCP tool emits.
3. **Catalog and presets** — the YAML risks (6-axis vector,
   `acceptable_in_envs` where relevant) and the shipped presets.
4. **Coverage** — every tool covered by at least one non-fallback risk.
5. **Edge cases** — the non-obvious classification decisions, argued.
6. **Credential, discovery, execution, tests** — how the plugin runs today.

These handbooks are the human source of truth for a provider's model. The
code under `plugins/<id>/src/` materialises them; the `tracks:` frontmatter
lets the drift detector compare the two.

## Index

| Plugin         | Handbook                                   | Plane(s)                             | Risks                              | Presets                                                        | Credential    | Notes                                                                                                                                                                           |
| -------------- | ------------------------------------------ | ------------------------------------ | ---------------------------------- | -------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare DNS | [`cloudflare-dns.md`](./cloudflare-dns.md) | `dns`                                | 11 + fallback                      | `read-only`, `dns-operator`, `zone-admin`                      | `api-key`     | Zone-scoped token; record-write overlays.                                                                                                                                       |
| Fly.io         | [`fly.md`](./fly.md)                       | `apps`                               | 24 + fallback                      | `read-only`, `operator`, `fleet-upgrade`, `provisioner`        | `api-key`     | Organization token; image guard (digest + prefix), fresh snapshot before image changes, secret values masked.                                                                   |
| GitHub         | [`github.md`](./github.md)                 | `repo`                               | 18 + fallback                      | `read-only`, `developer`, `release-manager`                    | `app-install` | Per-call installation token. No env-scoped risk.                                                                                                                                |
| Gmail          | [`gmail.md`](./gmail.md)                   | `mailbox`                            | 14 + fallback (+ 1 deprecated id)  | `read-only`, `developer`                                       | `oauth2`      | **Experimental**: classifier-only, no tool exposed.                                                                                                                             |
| Railway        | [`railway.md`](./railway.md)               | `runtime`                            | 9 + fallback                       | `read-only`, `developer`, `operator`                           | `oauth2`      | Resource indicator on every token request. Services bound to their project.                                                                                                     |
| Resend         | [`resend.md`](./resend.md)                 | `email`                              | 15 + fallback (+ 2 deprecated ids) | `read-only`, `developer`, `marketing-operator`, `domain-admin` | `api-key`     | Recipient zones from the domain resource metadata.                                                                                                                              |
| SSH            | [`ssh.md`](./ssh.md)                       | `host`                               | 7 + fallback                       | `read-only`, `developer`, `operator`                           | `ssh-key`     | Pinned host key; command classes.                                                                                                                                               |
| Stripe         | [`stripe.md`](./stripe.md)                 | `billing`                            | 16 + fallback                      | `read-only`, `test-mode-developer`, `finance-operator`         | `api-key`     | One resource per mode (test / live); catalog v4. `read-only` covers catalog, subscriptions and balance: invoices, charges, payment intents and events need `read-customer-pii`. |
| Supabase       | [`supabase.md`](./supabase.md)             | `db`, `storage`, `auth`, `functions` | 24 + fallback (+ 1 deprecated id)  | `read-only-analyst`, `staging-developer`, `migration-operator` | `oauth2`      | Management API; `execute_sql` read-only. Prod migrations are limited to plain DDL and RLS.                                                                                      |
| Upstash Redis  | [`upstash-redis.md`](./upstash-redis.md)   | `cache`                              | 10 + fallback                      | `read-only`, `developer`, `operator`                           | `api-key`     | Env from the owner's database label.                                                                                                                                            |
| Vercel         | [`vercel.md`](./vercel.md)                 | `runtime`                            | 16 + fallback                      | `read-only`, `developer`, `operator`                           | `api-key`     | Declares `envOf` (the `env[<label>]` segment).                                                                                                                                  |

Risk counts are the live named entries of each `risk-catalog.yaml`; every
catalog adds exactly one `<id>.uncategorized-write` fallback. Deprecated ids
are counted apart. Preset values are a
starting point — ADR `mission-presets-default-values` is deferred.

An env-scoped risk is acceptable in the environments its catalog entry
lists, and the environment of a call is the label of the resource it
touches (or what the plugin's `envOf` derives). **An unlabelled resource
cannot run env-scoped operations**: the call is refused with
`risk-not-accepted`, whatever the mission accepted, until the owner labels
the resource on the account's page (Accounts).

The v4 modelling notes of Railway and SSH (French) are archived as legacy in
[`railway-ssh.md`](../legacy/railway-ssh.md); both plugins have their own
handbook above.

## Updating

When a `risk-catalog.yaml`, a classifier or a preset changes, update the
corresponding handbook in the same pull request and bump `catalog_version`
(and the plugin `version` per the semver rule of ADR
[[plugin-contract-and-credential-spec]] D9, spelled out for `0.x` plugins in
[`plugins/README.md`](../../../plugins/README.md), "Step 11 — Version, changelog, pull request"). The
`tracks:` frontmatter lists the files to watch.

## Revoking a connection: what happens at the provider

When an owner revokes a connection the gateway erases the credential it
holds and, where the provider documents an endpoint for it, withdraws the
grant there too ([connections, "The grant at the
provider"](../connections.md#the-grant-at-the-provider-credentialsts-oauth2ts-provider-grantts)).
An endpoint enters this table once it was read in the provider's
documentation through Context7
([ADR](../../decisions/use-context7-for-provider-docs.md)), never from memory
and never by analogy with another provider.

| Provider                                              | Credential    | Withdrawn by the gateway                                                                                      | Read in the documentation                                                                                                                                                                                                                                                                                                                                                                 | Otherwise: by hand                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase                                              | `oauth2`      | **yes** — `POST https://api.supabase.com/v1/oauth/revoke`, JSON `{ client_id, client_secret, refresh_token }` | the path, its purpose ("revokes an OAuth app authorization and its corresponding tokens") and the three body fields, in the Management API types (`OAuthRevokeTokenBody`). **Not read there**: the HTTP method and the success status. `POST` and JSON are what a typed request body means for this API; any 2xx is taken as confirmed, and any other answer is reported as not withdrawn | the organisation's settings, authorised OAuth apps                                                                                                                                                                                                    |
| Gmail (experimental)                                  | `oauth2`      | **yes** — `POST https://oauth2.googleapis.com/revoke`, form-encoded `token`                                   | Google's OAuth 2.0 guide: method, content type, the `token` parameter (access or refresh token; revoking one revokes the other), 200 on success and 400 on error                                                                                                                                                                                                                          | the Google Account, Security, third-party access                                                                                                                                                                                                      |
| Railway                                               | `oauth2`      | no                                                                                                            | the documentation describes revocation by the account holder only (account settings, Authorized Apps, Revoke Access) and no endpoint for the application                                                                                                                                                                                                                                  | account settings, Authorized Apps, Revoke Access                                                                                                                                                                                                      |
| GitHub                                                | `app-install` | no, on purpose                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                         | uninstall the company's App from the organisation. The gateway never does it: one installation may serve several connections of the instance, and the stored credential is the installation, not a user authorization                                 |
| Vercel, Stripe, Cloudflare DNS, Upstash Redis, Resend | `api-key`     | no, on purpose                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                         | delete the key or token in the provider's dashboard. The key was created by a person and may be used elsewhere: the gateway erases its copy and deletes nothing at the provider                                                                       |
| GitHub, Supabase, Railway — a token pasted by hand    | `api-key`     | no, on purpose                                                                                                | GitHub: `POST /credentials/revoke` exists but is the leak-report endpoint (credentials the caller does not own, the owner is notified of a leak, 60 unauthenticated requests an hour, an authenticated call answers 403); Supabase and Railway: no endpoint deleting a personal or account token was found                                                                                | delete the token on the service's token page, signed in as the account that created it (each token way's own `manualRevocation`; ADR [token-connections-beside-the-integration-app](../../decisions/token-connections-beside-the-integration-app.md)) |
| SSH                                                   | `ssh-key`     | no                                                                                                            | —                                                                                                                                                                                                                                                                                                                                                                                         | remove the connection's public key from `authorized_keys` on the host                                                                                                                                                                                 |

Each plugin carries its "by hand" sentence (`manualRevocation`), shown in
the "Disconnect this account…" dialog and on the page of the disconnected
account. A structural test
(`shipped-providers.test.ts`) pins this table: the providers that declare
an endpoint, the endpoint and its shape; adding one changes the test and
this table in the same commit.

Versions shipped today (`version` in `src/index.ts`, equal to the plugin's
`package.json`; what telemetry reports as `plugin_version`): `4.2.0` for
supabase; `4.2.0` for railway; `3.2.0` for github; `3.0.0` for cloudflare-dns,
upstash-redis and vercel; `2.0.0` for ssh; `0.4.0` for stripe; `0.3.0` for gmail and
resend. A version moves by a breaking step — major, or minor before 1.0 —
when the classification becomes stricter or the executor refuses what it used
to forward, because a call the previous version allowed is then refused: the
classifiers that fail closed (root `CHANGELOG.md`, "Plugin classifiers fail
closed"), the closed argument surface and the typed refusals of the executors
(ADR
[plugin-arguments-closed-surface-and-typed-refusals](../../decisions/plugin-arguments-closed-surface-and-typed-refusals.md)
D5). `execute` throws every provider failure and returns what it declines
itself ([plugin-sdk](../plugin-sdk.md), "Errors of `execute`").

Three rules of that ADR are applied plugin by plugin, and each handbook says
where its plugin stands:

- **undeclared arguments** — a plugin whose executor forwards the arguments
  it was given refuses an argument the tool's schema does not declare, in
  `classify` and again in `execute`; a plugin that builds its request field
  by field never reads such an argument;
- **identifiers the slice grammar cannot carry** — classified as "any"
  (`[*]`), never dropped or escaped;
- **what the executor declines** — an `isError` result carrying the reason,
  never a thrown `Error`.

To draft a new provider, start from
[`plugins/README.md`](../../../plugins/README.md) and copy the structure of an
existing handbook.
