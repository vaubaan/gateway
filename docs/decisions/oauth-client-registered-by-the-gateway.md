---
title: An OAuth service that accepts dynamic client registration gets a client the gateway registers itself
status: accepted
date: 2026-10-21
---

# An OAuth service that accepts dynamic client registration gets a client the gateway registers itself

## Context

An OAuth client declared by an administrator means registering the gateway at the service and
pasting an id and secret, a cost the owner refused after Miro's REST app proved unusable in an
approved-apps-only organisation. The authorization servers of remote MCP servers implement dynamic
client registration (RFC 7591): one unauthenticated `POST /register` returns a client.

## Decision

An `oauth2` credential spec declares `clientRegistration: { registrationUrl }`, its only client
source: the gateway registers one client per instance and provider on the first connection, keeps
it in the instance settings with its secret sealed, and reuses it for every connection and token
request. A client is registered again when absent, when the instance's callback changed, or after
an `invalid_client`.

## Consequences

- Each instance has its own client; no client or secret is shared or held by Vaubaan, and a plugin
  never sees it.
- Withdrawing the gateway means removing its app at the service (`manualRevocation`).
- A changed public URL re-registers, and accounts connected through the old client need
  reconnecting.
- Registrations are single-flight within the process; several replicas could register twice.

## Rejected alternatives

### A client per connection

Multiplies apps at the service, puts a client secret in the credential plugins receive, and leaves
orphan clients on every revoke.

### An administrator registers the client by hand

Doing by hand what one request does.

### A client registered once by Vaubaan and shipped in the image

A client secret common to every instance, held by Vaubaan.

### Discover the endpoints at run time (RFC 9728, RFC 8414)

Static endpoints in the plugin are reviewed and tested; a provider moving them changes its plugin
anyway.

## History

- 2026-11-05: "an administrator registers the client by hand" stays rejected where the service
  offers dynamic registration; for a service that offers neither a key nor registration, it is one
  of the two sources an administrator may choose in Settings
  ([oauth-brokers-managed-in-settings-with-two-client-sources](oauth-brokers-managed-in-settings-with-two-client-sources.md)).
- 2026-11-27: "a client registered once by Vaubaan and shipped in the image" is admitted for a local instance only, as an installed-app client whose secret is not confidential and whose redirect is the loopback ([local-instance-carries-installed-oauth-clients](local-instance-carries-installed-oauth-clients.md)).
