---
title: Google Calendar is Google's official MCP server reached with a token from an OAuth broker the instance is enrolled with; other calendars are a generic CalDAV plugin
status: accepted
date: 2026-10-24
author: Renaud Pelissier (product owner), drafted with Claude
---

# Google Calendar is Google's official MCP server reached with a token from an OAuth broker the instance is enrolled with; other calendars are a generic CalDAV plugin

## Context

Google takes OAuth 2.0 only for calendars (CalDAV included), with no wildcard redirect and no
dynamic registration: the failure that moved Gmail to IMAP. Calendar scopes are sensitive, not
restricted: one OAuth client may serve many instances after a one-time verification, provided its
secret and refresh tokens stay with whoever registered it, never in instances. Google publishes an
official remote Calendar MCP server; other servers (iCloud, Fastmail, Nextcloud) speak CalDAV with
an app password.

## Decision

An OAuth broker owns a provider client and runs the authorization-code flow for enrolled instances;
the gateway is only its client, enrolled by configuration (`oauth_brokers.<name>`), and never holds
the client secret. An `oauth2` spec names `broker: { provider }` as its client source;
`google-calendar` relays Google's MCP server with the brokered token, and `caldav` serves every
other calendar server. What the broker may keep, and how it is trusted:
[oauth-broker-stateless-in-an-attested-enclave](oauth-broker-stateless-in-an-attested-enclave.md).

## Consequences

- Without a broker, Google Calendar cannot connect; a broker down fails calls once the access token
  expires. Calendar data never transits the broker.
- Any future provider can use the same contract: handbook
  [oauth-broker-contract](../handbook/oauth-broker-contract.md).
- The plugin never sees the refresh token or a broker key; scopes stay the narrowest covering its
  tools.
- Google's server is a Developer Preview: a schema check against `tools/list` fails loudly on change.

## Rejected alternatives

### One Google OAuth client per instance

Hand registration at the exact public URL, redone whenever it changes.

### Google's Calendar REST API, or Google Calendar over the CalDAV plugin

Every tool to write; CalDAV at Google needs the full `calendar` scope and lacks free-busy.

### An Apps Script web app or a service account

Full calendar authority behind a public URL, or a JSON key per company with no invitations
without domain-wide delegation.

### Gmail through the same broker

Gmail's scopes are restricted (yearly CASA); Gmail stays on IMAP.
