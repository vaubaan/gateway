---
title: Revoking a connection withdraws the grant at the provider when the provider documents how; the outcome is stored and shown
status: accepted
date: 2026-10-13
extends:
  - plugin-contract-and-credential-spec
  - use-context7-for-provider-docs
---

# Revoking a connection withdraws the grant at the provider when the provider documents how; the outcome is stored and shown

> Product owner's decision of 2026-10-13 (question 6 of the final pass). Spec:
> [vaubaan-gateway §2.3, §5, §7.8](../spec/vaubaan-gateway.md). Handbooks:
> [connections, "The grant at the provider"](../handbook/connections.md#the-grant-at-the-provider-credentialsts-oauth2ts-provider-grantts),
> [providers, "Revoking a connection"](../handbook/providers/README.md#revoking-a-connection-what-happens-at-the-provider),
> [plugin-sdk](../handbook/plugin-sdk.md).

## Context

Revoking a connection erased the credential the instance held and did nothing
at the provider. The notice said so in one line: "remove it there too if
needed". An OAuth authorization nobody removed is a standing grant to the
company's app, and a refresh token that leaked before the revocation still
worked.

## Decision

### D1. The plugin says how; two ways

- **Declarative, for `oauth2`**: `credential.revocation: { url, format }`. The
  **host** sends the request (`revokeGrant`), because one of the two shapes
  carries the company's OAuth client secret, which a plugin never receives
  (ADR plugin-contract-and-credential-spec). Two shapes, each the one a
  shipped provider documents: `token-form` and `client-credentials-json`.
- **A hook, for anything else**: `ProviderPlugin.revoke?(ctx)`. It takes
  precedence when present. No shipped plugin implements it today; it exists so
  that a provider whose revocation is neither shape does not need a contract
  change.

Every plugin also carries `manualRevocation`, a sentence saying where a person
removes the grant themselves.

### D2. Only endpoints read in the provider's documentation

Checked with Context7 on 2026-10-13, never from memory:

| Provider       | Finding                                                                                                                                                                                                                                     | Decision                                                                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google (Gmail) | `POST https://oauth2.googleapis.com/revoke`, form-encoded `token`, 200 on success, 400 on error; revoking a refresh token revokes its access tokens                                                                                         | implemented, `token-form`                                                                                                                                                                                                                                                                                                     |
| Supabase       | `/v1/oauth/revoke`, "revokes an OAuth app authorization and its corresponding tokens", body `{ client_id, client_secret, refresh_token }` (Management API types). The HTTP method and the success status were **not** in what could be read | implemented, `client-credentials-json`, as `POST` with a JSON body: the only method a typed request body allows in this API. Any 2xx is "confirmed"; anything else is reported as not withdrawn, so a wrong guess shows up as a `failed` outcome and a message to remove the access by hand — it cannot pass for a revocation |
| Railway        | revocation is described for the account holder only (account settings, Authorized Apps, Revoke Access); no endpoint for the application                                                                                                     | not implemented                                                                                                                                                                                                                                                                                                               |

### D3. Three providers are left alone on purpose

- **GitHub** (`app-install`). The grant is the installation of the company's
  App on an organisation. Uninstalling it through the API would end every
  connection of the instance that uses the same installation, and the instance
  does not hold a user authorization to revoke instead.
- **API keys** (Vercel, Stripe, Cloudflare DNS, Upstash Redis, Resend). The key
  was created by a person, who may use it elsewhere. The gateway erases its
  copy and deletes nothing at the provider.
- **SSH.** The grant is a line in `authorized_keys` on the host.

### D4. Local first, then the provider; never dependent on it

The credential is read, the connection is revoked in the store, and only then
is the provider asked, within ten seconds. Whatever the provider does — refuse,
hang, be down — the connection is revoked here and its missions refuse every
call through it (since 2026-10-21 they keep serving through their other
connections: ADR orphaned-missions-and-ownerless-connections, amendment
2026-10-21).

### D5. The outcome is stored and shown

`connections.provider_grant` (migration `0012`): `revoked`, `manual`, `failed`,
written once. The `connection-revoked` entry carries it. The revoke dialog says
beforehand what will happen; the notice and the revoked connection's page say
what did, and keep saying where to remove a grant that still stands.

## Consequences

- A revocation can take up to ten seconds longer for the two OAuth providers.
- A connection revoked before this build has no stored outcome and reads as
  "remove the access by hand".
- A new provider's endpoint enters through its plugin's spec, the handbook
  table and the structural test, with its source.

## Rejected alternatives

- **Hand the client secret to a plugin `revoke`.** It breaks the one rule the
  credential spec exists for.
- **Ask the provider first, revoke locally on success.** A provider outage
  would keep a connection alive that its owner wanted dead.
- **Uninstall the GitHub App.** See D3.
- **Delete API keys through the providers' token APIs.** Several offer one;
  see D3 for why the key is not the gateway's to delete.
- **Implement Railway by analogy** (an RFC 7009 endpoint next to its token
  endpoint). Not documented; a guessed URL would receive a refresh token.
- **Keep the outcome in the audit only.** A grant that still stands must be in
  front of the owner, not in a log they have to search.
