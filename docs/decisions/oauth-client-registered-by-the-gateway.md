---
title: An OAuth service that accepts dynamic client registration gets a client the gateway registers itself
status: accepted
date: 2026-10-21
author: drafted by the coding agent on the product owner's request of 2026-10-21 ("decide the details yourself, record them in an ADR")
extends:
  - one-place-to-authorize-services-token-first
  - plugin-contract-and-credential-spec
---

# An OAuth service that accepts dynamic client registration gets a client the gateway registers itself

## Context

The `oauth2` way of the plugin contract runs the authorization-code flow
against an OAuth client **an administrator declares**: they register the
gateway at the service, then paste a client id and secret on the service's
connect page (Gmail). ADR
[one-place-to-authorize-services-token-first](one-place-to-authorize-services-token-first.md)
kept that way for the services that offer no key a person can make, and
accepted its cost: a registration form at the service, a secret to copy,
a page that explains it.

Some services remove that cost themselves. The authorization servers of
remote MCP servers implement **OAuth 2.1 with dynamic client registration**
(RFC 7591), as the MCP authorization specification asks: any client
registers itself with one unauthenticated `POST /register` and receives a
client id (and, for a confidential client, a secret). Miro's MCP server is
one (`https://mcp.miro.com/register`, checked on 2026-10-21 — a test
registration answered `201` with a client id and secret, no expiry). Every
MCP client (Claude, Cursor, Copilot) connects to such a server with one
click and a consent screen; nobody creates an app.

The product owner on 2026-10-21, after Miro's REST token turned out unusable
in an organisation that allows approved apps only: "je ne veux pas avoir à
créer une app". The gateway can do what those MCP clients do.

## Decision

1. **The contract.** `OAuth2CredentialSpec.clientRegistration?:
{ registrationUrl }` (plugin SDK). A spec that declares it has **no app
   setting**: `definePlugin` refuses `appConfigFields` beside it, the host
   derives no `client_id` / `client_secret` field for it, the service needs
   nothing from an administrator and is connectable at once.
2. **One client per instance and provider**, registered by the host the
   first time someone starts a connection (`OAuth2Clients.forAuthorization`,
   `connections/oauth2-clients.ts`). The registration asks for the
   authorization-code and refresh-token grants, the spec's scopes, the
   instance's callback (`<public_url>/connections/callback/<provider>`) as
   the only redirect URI, and the spec's `clientAuthMethod`; the client is
   named `Vaubaan Gateway (<public host>)`, which the person reads on the
   service's consent page and in their list of allowed apps. The answer must
   carry a client id, a secret unless the client is public, and no other
   authentication method than the one asked for.
3. **Kept in the instance settings**, beside a declared client:
   `instance_config` keys `oauth_clients.<provider>.client_id`,
   `.redirect_uri`, `.registered_at` as values, `.client_secret` sealed by
   the store's encryptor (the master key; resealed by a master-key rotation
   and carried by a backup like every sealed setting). Never shown, never
   handed to a plugin (`appConfig` stays empty).
4. **Reused**, for every connection of the instance and for every token
   request (code exchange, refresh, revocation:
   `OAuth2Clients.forTokenRequest`, which never registers: a grant belongs
   to the client that obtained it).
5. **Registered again** when there is none; when the instance's callback is
   no longer the one it was registered with (the public URL changed); and
   after the provider rejected it — an `invalid_client` at the code exchange
   or at a refresh makes `OAuth2Clients.rejected` forget it (only if it is
   still the current one), so the next connection registers a new one. The
   connection whose refresh was refused is "needs reconnecting", as with any
   refused refresh. Registrations are single-flight per provider inside the
   process: two people connecting at once share one client.
6. **Failures in the gateway's words.** A registration the service refuses
   is the connect error `client-registration-failed` ("The service refused
   to register this gateway as one of its apps…"), with the status and the
   protocol error code only; one that does not answer is
   `provider-unreachable`. A registered client gone between the start of a
   flow and its callback is `state-invalid` (start again).
7. **The page.** A service whose client registers itself says "You sign in
   at <service> and allow this gateway; there is nothing to create or
   paste"; no administrator section is shown (`ConnectableProvider.
registersItself`, `redirects`).

The flow is otherwise the existing `oauth2` one: PKCE when the spec asks
(always, for a registered client in practice), the resource indicator,
`state` single use, the callback limited to the public URL, the generic
refresh with rotation.

## Consequences

### Positive

- A service like Miro's MCP server is connected with one click and the
  service's own consent, by anyone, from the first minute of an instance.
- Each instance has its own client, as the spec requires of every OAuth
  client (§4.3, §11.1): no client shared between customers, no secret held
  by Vaubaan.
- One more `oauth2` service costs a declaration in its plugin, nothing in
  the host.

### Negative / constraints

- **The service sees one app per instance**, named after the instance's
  host. A person who wants to withdraw the gateway removes that app at the
  service (`manualRevocation`).
- **An organisation may forbid dynamically registered apps** (the same
  policy that made Miro's REST token useless). The connection then fails at
  the service's consent page, in the service's words, or at the
  registration with `client-registration-failed`; the gateway cannot work
  around an organisation's policy, and should not.
- **A change of public URL re-registers** on the next connection, and the
  accounts connected through the previous client stop refreshing ("needs
  reconnecting"). A changed public URL already breaks every declared OAuth
  client's redirect; this is the same event.
- **The registration endpoint is unauthenticated**: anybody can register
  clients there. The client the gateway keeps is the one it registered
  itself; nothing an agent or a page sends reaches the registration.
- A provider that expires registered clients (`client_secret_expires_at`)
  is not handled ahead of time: the expiry is noticed as an
  `invalid_client` and the next connection registers again. Miro's
  registration answers no expiry.
- The single-flight is per process; a deployment with several replicas
  could register twice, and the last write wins — the flows started with
  the other client then fail at the exchange with `invalid_client`, which
  forgets nothing (it is no longer the current client) and asks the person
  to start again. The gateway runs one process today.

## Rejected alternatives

### Discover the endpoints at run time (RFC 9728 → RFC 8414)

The host could read the protected-resource metadata of the MCP server, then
the authorization server's metadata, and take the authorization, token and
registration endpoints from there, as a generic MCP client does. Rejected
for now: the plugin already declares its endpoints statically for every
other way, a static declaration is reviewed and tested, and a provider that
moves its endpoints changes its plugin anyway (its tools, its catalog). The
facts were read from the metadata once, on 2026-10-21, and are written in
the plugin with the date.

### A client per connection

Register a client for each person's connection, and keep its secret in the
connection's credential. Removes the shared registration and its
re-registration rules. Rejected: it multiplies the apps a person sees at the
service (one per reconnection), puts a client secret in the credential that
plugins receive, and leaves orphan clients at the service on every revoke.

### Ask an administrator to register the client by hand, as for Gmail

The service accepts a registration from anyone; asking a person to do by
hand what one request does is the cost the product owner refused.

### A client registered once by Vaubaan and shipped in the image

Rejected for the reasons of the token-first ADR ("A shared app operated by
Vaubaan"): a client secret common to every instance, held by Vaubaan.

## References

- Spec: `docs/spec/vaubaan-gateway.md` §4.3 (the OAuth client of a service),
  §7.2 (connect an account), §11.1 — amended on 2026-10-21 to describe both
  sources of the client, declared and registered.
- Code: `packages/plugin-sdk/src/credential.ts` (`OAuth2ClientRegistration`),
  `apps/gateway/src/server/connections/oauth2.ts` (`registerClient`),
  `apps/gateway/src/server/connections/oauth2-clients.ts`.
- Handbook: [connections](../handbook/connections.md), [plugin-sdk](../handbook/plugin-sdk.md).
- First user: ADR [miro-rewraps-the-official-mcp-server](miro-rewraps-the-official-mcp-server.md).
- RFC 7591 (dynamic client registration), RFC 7636 (PKCE), RFC 8707
  (resource indicators), MCP authorization (2025-06-18).
