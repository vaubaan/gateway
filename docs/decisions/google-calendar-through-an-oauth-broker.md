---
title: Google Calendar is Google's Calendar REST API reached with a token from an OAuth broker the instance is enrolled with; other calendars are a generic CalDAV plugin
status: accepted
date: 2026-11-02
author: Renaud Pelissier (product owner), drafted with Claude
---

# Google Calendar is Google's Calendar REST API reached with a token from an OAuth broker the instance is enrolled with; other calendars are a generic CalDAV plugin

## Context

Google takes OAuth 2.0 only for calendars (CalDAV included), with no wildcard redirect and no
dynamic registration: the failure that moved Gmail to IMAP. Calendar scopes are sensitive, not
restricted: one OAuth client may serve many instances after a one-time verification, provided its
secret and refresh tokens stay with whoever registered it, never in instances. Google's hosted
Calendar MCP server (2026-10-24 decision) is gated to Google Workspace Developer Preview members;
Google refused our application, as it will refuse any customer without a Workspace. Other servers
(iCloud, Fastmail, Nextcloud) speak CalDAV with an app password.

## Decision

An OAuth broker owns a provider client and runs the authorization-code flow for enrolled instances;
the gateway is only its client, enrolled by configuration (`oauth_brokers.<name>`), and never holds
the client secret. An `oauth2` spec names `broker: { provider }` as its client source.
`google-calendar` implements its tools on the public Calendar REST API v3 with the brokered token,
under the two scopes `calendar.calendarlist.readonly` and `calendar.events` and nothing wider;
`caldav` serves every other calendar server. What the broker may keep, and how it is trusted:
[oauth-broker-stateless-in-an-attested-enclave](oauth-broker-stateless-in-an-attested-enclave.md).

## Consequences

- Without a broker, Google Calendar cannot connect; a broker down fails calls once the access token
  expires. Calendar data never transits the broker.
- Any future provider can use the same contract: handbook
  [oauth-broker-contract](../handbook/oauth-broker-contract.md).
- The plugin never sees the refresh token or a broker key; the tool list is the plugin's own, so a
  Google change surfaces as a typed upstream error on the call, not as a tool drift at discovery.
- Free/busy is `freeBusy.query` under `calendar.events`; semantic search is gone, `q` text search
  stands in.

## Rejected alternatives

### Google's hosted Calendar MCP server (the 2026-10-24 decision)

Developer Preview only, membership refused without a Workspace: unusable for us and for most
customers. Replaced on 2026-11-02 by this decision.

### One Google OAuth client per instance

Hand registration at the exact public URL, redone whenever it changes.

### Google Calendar over the CalDAV plugin

Needs the full `calendar` scope at Google and lacks free-busy.

### An Apps Script web app or a service account

Full calendar authority behind a public URL, or a JSON key per company with no invitations
without domain-wide delegation.

### Gmail through the same broker

Gmail's scopes are restricted (yearly CASA); Gmail stays on IMAP.

## History

- 2026-11-05: "one Google OAuth client per instance" is no longer rejected outright: an
  administrator may choose it as the source serving Google, next to an external broker
  ([oauth-brokers-managed-in-settings-with-two-client-sources](oauth-brokers-managed-in-settings-with-two-client-sources.md)).
  The broker stays the way for a hosted fleet and for whoever does not want to register a client.
