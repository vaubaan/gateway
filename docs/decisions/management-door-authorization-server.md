---
title: The instance is the management door's own OAuth authorization server, issuing opaque delegated tokens stored as digests
status: accepted
date: 2026-10-13
---

# The instance is the management door's own OAuth authorization server, issuing opaque delegated tokens stored as digests

## Context

`/mcp/manage` serves agents acting for a user and must accept a standard MCP client (Claude Code)
with no special configuration: discovery from a `401`, dynamic registration, authorization code with
PKCE. Corporate IdPs will not issue a token for an arbitrary laptop program with this door as
audience, and the MCP SDK has frozen its authorization-server helpers. Spec §6 wants delegated
tokens short-lived, renewable, revocable, limited to one scope and unable to open any other door.

## Decision

The instance at `public_url` is the authorization server; the IdP only identifies the human on the
consent page, and no IdP token is accepted, forwarded or stored. An in-house module
(`src/server/oauth-as/`, no new dependency) serves one flow, one scope (`mgmt`) and one resource
with opaque prefixed tokens stored as SHA-256 digests, read at every call. One consent is one
delegation and one token family: refresh tokens rotate, a replay revokes the family, and the
delegation ends `oauth.delegation_max_lifetime` (90 days) after consent, derived, never stored.

## Consequences

- Revocation, removed users and disabled clients take effect at the next request, for one indexed
  read per call.
- Client registration is behind a policy, `operator-approved` by default, loopback redirects
  approved alone; consent is asked every time and states where the code goes.
- The management door admits a delegated token only: a mission token or a session answers `403`
  `wrong-credential-kind`. Grants, reuse window and endpoint rules: handbook
  [management-door](../handbook/management-door.md).

## Rejected alternatives

### Accept the IdP's tokens at the management door

Every IdP admin would register every MCP client for an unknown audience, and one delegation could
neither be scoped nor revoked.

### The SDK's frozen helpers, or `oidc-provider`

A deprecated dependency under the most sensitive surface, or a large library mostly disabled.

### JWT access tokens

Issuer and verifier are one process on one store; a JWT cannot be revoked early without the lookup
it avoids.

### Remembering consent, or `open` registration by default

A public client id is no secret, and an open registration is one phishing link away from a user's
authority.

### Store the delegation's expiry

A second source for a configured value; a shortened key would not reach existing rows.
