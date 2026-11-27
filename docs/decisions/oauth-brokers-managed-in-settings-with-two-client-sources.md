---
title: Brokers are managed in Settings, one client source per service, an external broker or the gateway's own client
status: accepted
date: 2026-11-05
author: Renaud Pelissier (product owner), drafted with Claude
---

# Brokers are managed in Settings, one client source per service, an external broker or the gateway's own client

## Context

A service that offers neither a key a person can paste nor dynamic client registration (Google)
connects through an OAuth broker ([google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md)).
Today the only broker is external and the only way to name one is the configuration file
(`oauth_brokers.<name>`): an administrator sees "not configured" on Connect an account with
nowhere to go, and an on-premises instance that wants Google Calendar must either enrol with a
broker someone else operates — whose operator sees the tokens pass when it runs unattested — or
run the broker image itself only to hold its own client, a detour that brings none of the broker's
value (sealing against the operator, attestation) since the operator is the instance's own
administrator. The Calendar decision rejected "one Google client per instance" because of the hand
registration at the exact public URL: an objection that holds for a hosted fleet, not for an
administrator who owns the URL.

## Decision

- **Settings › Administration › OAuth brokers** manages the brokers in the store, their secrets sealed
  under the master key, like sign-in providers: an administrator adds, tests, edits and removes one;
  one set by the configuration file is read-only and always on; one added here is off until its
  test passed. Every change is audited.
- **Two kinds of source.** An **external broker**: URL, the enrolment key the broker provides, attestation `required` or
  `none`, the services it serves. **This gateway's own client**: a service, the client id and
  secret of an OAuth client the administrator created at that service, with the redirect
  `<public URL>/oauth/callback/<service>`; the gateway runs the flow itself, as it does for a
  client it registered.
- **One source per service.** The administrator chooses which source serves each service that a
  shipped plugin signs in through; every plugin of that service follows. A service no source serves
  is "not configured": Connect an account says so, with the way to Settings for an administrator and
  "ask an administrator" for anyone else.
- **The plugin declaration does not change**: `broker: { provider, scopes }` and nothing else.
- **The provider table** — endpoints, allowed scopes, consent parameters — leaves the broker's
  source for a package the gateway and the broker both compile in; adding a scope stays a release
  of both.
- The account pages say how an account signed in: through an attested broker, an unattested one, or
  this gateway's client.

## Consequences

- With an own client the instance holds the client secret and the refresh tokens, sealed like its
  other secrets; nothing attests it, and the pages say so. The customer trusts their own instance,
  which already holds every other credential.
- A changed public URL breaks an own client's redirect: the page warns and says what to re-register
  at the service; the gateway cannot re-register it itself.
- Changing the source of a service does not touch the accounts connected through the former one:
  they keep working until their token expires or is revoked, and new sign-ins use the new source.
  The page says so before the change.
- `oauth_brokers.<name>` stays as a seed for a managed deployment; the store is the reference.
- Amended: [google-calendar-through-an-oauth-broker](google-calendar-through-an-oauth-broker.md)
  (one client per instance is a source an administrator may choose) and
  [oauth-client-registered-by-the-gateway](oauth-client-registered-by-the-gateway.md) (a client an
  administrator registers by hand is admitted for a service with no dynamic registration only).

## Rejected alternatives

### Running the broker's code inside the gateway process

Nothing the broker is for survives it: no separate operator, no measured code, no sealing against
whoever runs the machine. What remains is "the gateway holds a client", which is this decision
without the detour.

### A broker chosen per plugin

Two plugins of one service would sign in through two clients at the same provider for no reason;
the service is the unit a client belongs to.

### Configuration only, with better messages

Leaves the administrator of an installed instance editing files and restarting to connect a
calendar; every other administration act moved to the interface
([administrators-live-in-the-instance](administrators-live-in-the-instance.md)).

### A client per connection

A client secret in every credential, orphan apps at the service on each revoke (already rejected in
[oauth-client-registered-by-the-gateway](oauth-client-registered-by-the-gateway.md)).

## History

- 2026-11-27: a local instance has a third source, Vaubaan's installed-app client, serving `google` and `microsoft` by default ([local-instance-carries-installed-oauth-clients](local-instance-carries-installed-oauth-clients.md)).
