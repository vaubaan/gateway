---
title: Outlook mail and calendar are one plugin on Microsoft Graph, with a token from the OAuth broker's microsoft provider
status: accepted
date: 2026-11-05
author: Renaud Pelissier (product owner), drafted with Claude
---

# Outlook mail and calendar are one plugin on Microsoft Graph, with a token from the OAuth broker's microsoft provider

## Context

Microsoft disabled basic authentication for Exchange Online: there is no app password that opens
IMAP or SMTP as Gmail's does, only OAuth. The Microsoft identity platform offers no dynamic client
registration, but one Entra app registration (any organizational directory and personal Microsoft
accounts, platform Web, one fixed redirect URI) can serve every instance: the case the OAuth broker
was built for with Google Calendar. Mail and calendar of an account are reached by one access token
on Microsoft Graph. Microsoft has no endpoint that revokes one refresh token: only
`revokeSignInSessions`, which signs the person out of every application and device.

## Decision

The reference broker serves a `microsoft` provider (`/common/oauth2/v2.0` endpoints,
`response_mode=query`, `offline_access`, the delegated permissions `User.Read`, `Mail.ReadWrite`,
`Mail.Send`, `Calendars.ReadWrite`, plus `openid`, `email`, `profile`), with no revocation endpoint:
its `/revoke` answers 204 and calls nothing. One plugin, `outlook`, implements mail and calendar as
two planes of one Microsoft account over Graph v1.0 with the brokered token: one connection per
account, one consent, the account its single resource. Mail is zoned as Gmail is (sender, recipient
and send zones); the calendar is modelled as Google Calendar is.

## Consequences

- Without a broker serving `microsoft`, Outlook cannot connect; the gateway never holds the client
  secret, and mail or calendar content never transits the broker.
- Disconnecting erases the gateway's copy only: the person removes the app under their Microsoft
  account (`manualRevocation`). The handbook's revocation table says so.
- A tenant whose consent policy blocks user consent needs an administrator's consent once; the
  broker operator needs publisher verification for other tenants to consent at all.
- Microsoft returns a new refresh token on each refresh, which `/token` does not pass on (spec
  oauth-broker, open question 2): a connection lives as long as its first refresh token.
- The broker contract serves a second provider unchanged, except that revocation became optional.

## Rejected alternatives

### IMAP and SMTP with OAuth (XOAUTH2)

Still an Entra client registration, and no calendar: two connections for one account.

### Exchange Web Services

Retired for new applications; Graph is its replacement.

### Power Automate or Microsoft's connectors

A second platform with its own accounts and licences between the gateway and the mailbox.

### One Entra app registered per instance

Comes later as "this gateway's own client"
([oauth-brokers-managed-in-settings-with-two-client-sources](oauth-brokers-managed-in-settings-with-two-client-sources.md));
the broker stays the way for whoever does not want to register an app.

### Two plugins, mail and calendar

Two consents and two connections for the same token, and a mission could not tell they are one
account.

## History

- 2026-11-27: in local mode, Outlook connects with Vaubaan's installed-app Microsoft client (public client, no secret), no broker ([local-instance-carries-installed-oauth-clients](local-instance-carries-installed-oauth-clients.md)).
