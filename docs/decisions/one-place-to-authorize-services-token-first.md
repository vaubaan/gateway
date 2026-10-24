---
title: One place to authorize a service; the service's page guides to the simplest way, a pasted token whenever the service offers one
status: accepted
date: 2026-10-20
author: Renaud Pelissier (product owner), drafted with Claude
supersedes:
  - company-apps-kept-where-they-add-something
  - token-connections-beside-the-integration-app
  - company-app-created-from-a-manifest
amended-by:
  - gmail-over-imap-with-an-app-password
---

# One place to authorize a service; the service's page guides to the simplest way, a pasted token whenever the service offers one

> **Amended on 2026-10-24** by [gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md): Gmail no longer keeps the OAuth way. It
> connects with a Google app password over IMAP, a key a person makes alone,
> which puts it on the simple path this ADR prefers. With Gmail gone, no
> service needs an OAuth client declared by an administrator, and that way is
> removed from the gateway; the rule of the amendment of 2026-10-21 now reads:
> a key a person can make, whenever the service offers one that works;
> otherwise the service's sign-in, with a client the gateway registers itself.

> **Accepted** on 2026-10-20 by the product owner. It supersedes the
> proposal of 2026-10-16, [token-connections-beside-the-integration-app](token-connections-beside-the-integration-app.md)
> (D2 "both ways kept") and [company-app-created-from-a-manifest](company-app-created-from-a-manifest.md)
> (the manifest flow goes with the GitHub App).

## Context

A gateway sends a key to a service on every call, whatever the way the
account was connected. Two ways exist today to obtain that key:

- **a token pasted by hand**: the person makes the key in the service's own
  settings and pastes it; the gateway keeps it, encrypted, and sends it as is;
- **a company app**: an administrator first registers the gateway at the
  service (a GitHub App, an OAuth client at Supabase, Railway or Google); the
  service then hands keys to the gateway by itself, after the person clicks
  "authorize". The GitHub App goes further: the gateway keeps only an
  installation number and mints one-hour keys per repository.

The second way has a real cost that the first does not: a registration form
at the service with a dozen fields, a private key or a client secret to copy
into the instance, a setting the person must not forget ("Request user
authorization during installation", "Where can this App be installed"), and a
page of the gateway ("Company apps") that explains all of it. The GitHub
manifest flow of 2026-10-14 reduced it to one click, and it still bit on
2026-10-20: the App it creates is private to its owner account, so a second
GitHub organisation could not be connected. Ten of the thirteen providers
have no app at all and work fine.

The product owner's finding (2026-10-20): "the distinction is artificial; a
Google app is tokens to fetch as well; it is always tokens". The difference
between the two ways is not what the gateway sends but **who makes the key**:
the person, by hand, or the service, after the gateway was declared to it.
Declaring the gateway is a cost the service imposes, worth paying only where
the service offers no key a person can make.

## Decision

**There is one place to authorize a service, and one gesture: give the
gateway a key.** The page of a service guides the person through the
simplest way that service offers. When the service lets a person make a key
in their own settings, that is the way, and the only one the plugin declares.
When it does not (Gmail for a personal Google account), the page guides
through the more elaborate setup the service imposes — declaring the gateway
at the service, then authorizing — presented as steps of the same
connection, not as a layer of its own.

Consequently:

- **GitHub connects with a fine-grained personal access token only.** The
  GitHub App, its manifest flow, the installation verification, the per-call
  installation tokens and `github__mint_install_token` are removed.
- **Supabase and Railway connect with their personal or workspace token
  only.** Their OAuth apps are removed.
- **Gmail keeps the OAuth way**, the only one Google offers for a personal
  account. The declaration of the gateway at Google is the first step of its
  connection page. A service account key for Google Workspace — a key a
  Workspace administrator can make and paste — is the way to study if a
  company Gmail is wanted on the simple path.
- **The "Company apps" page of Administration disappears.** What remains of
  it (the Google client of Gmail) lives on Gmail's connection page, reached
  by an administrator.
- The plugin contract keeps one credential kind per plugin; `app-install`
  leaves the SDK. `oauth2` stays, for the providers that have no token way.

## Consequences

### Positive

- An install opens on "connect a service", never on "should I register
  apps?". No private key, client secret or App slug to copy into the
  instance for GitHub, Supabase or Railway.
- One path per plugin: one credential, one execute, one discovery, one
  guide. The provider modeler and the handbooks shrink accordingly. Roughly
  2,800 lines of server and GitHub plugin code, one administration page, three
  e2e specs and their fixtures go away.
- A second GitHub organisation is one more token, like a second Supabase
  organisation.

### Negative / constraints

- **The gateway's database holds long-lived GitHub keys.** With the App it
  held an installation number, useless without the gateway. The database
  already holds such keys for ten providers; the master-key encryption at
  rest is the protection, as it was for them.
- **GitHub actions are attributed to the person who pasted the token**, not
  to a bot. A team that wants a neutral author uses a dedicated GitHub
  account, as it does for the other services.
- **A fine-grained token lives one year at most** (GitHub's rule) and is
  reconnected by hand; the App never expired. The connection turns "Needs
  reconnecting", as any expired token does today.
- **A GitHub organisation may forbid fine-grained tokens, or require an
  administrator's approval.** The connection page says so; a customer may
  need its GitHub administrator before the first connection.
- **No per-call permission check before sending** on GitHub: the plugin
  declined by name a permission the App lacked; GitHub now answers the
  refusal itself, as it does for every token provider.
- **`github__mint_install_token` is gone.** The gateway's git remote covers
  clone and push; a mission that needs a raw token (Git LFS, a tool that
  speaks to GitHub outside the gateway) has none. To be revisited if a pilot
  asks for it.
- Instances that connected GitHub, Supabase or Railway through an app must
  reconnect those accounts with a token after the upgrade; the release notes
  say so and the account shows "Needs reconnecting" with the reason.

### Amendment of 2026-10-20 — what the contract keeps without a shipped user

Three generic capabilities of the plugin contract had the GitHub App as
their only shipped user and stay, each under its own decision: the
per-connection upstream credential cache (`ExecuteContext.credentialCache`,
ADR upstream-credential-cache-and-rejected-credentials), the git remote's
`admitPush` hook (ADR gateway-as-git-remote, amendment of 2026-10-18) and
`tokenHandouts` (spec §2.4, "one deliberate exception"). They describe how a
plugin that derives a short-lived credential per call behaves, which the
next such plugin will need; removing them would be a decision of their own.

### Amendment of 2026-10-21 — Miro joins Gmail on the OAuth way, with nothing to declare

Miro's REST token belongs to an app the person creates; an organisation
that allows approved apps only hands that app a token without scopes, and
the token way is unusable there. The Miro plugin now connects through
Miro's official MCP server by OAuth (ADR
[miro-rewraps-the-official-mcp-server](miro-rewraps-the-official-mcp-server.md)),
and its token way is removed — still one way per service. The cost this ADR
held against OAuth (declaring the gateway at the service) does not apply:
Miro's authorization server accepts dynamic client registration, and the
gateway registers its own client there (ADR
[oauth-client-registered-by-the-gateway](oauth-client-registered-by-the-gateway.md)).
The rule reads: a token a person can make, whenever the service offers one
that works; otherwise the service's sign-in, with the client the gateway
registers itself when the service allows it, declared by an administrator
when it does not.

## Rejected alternatives

### Keep the GitHub App, token first everywhere else (the proposal of 2026-10-16)

Kept the one app with a genuine security benefit (short-lived scoped keys,
nothing to rotate) and moved the others behind a link. Rejected because the
benefit is paid by every administrator at install, for a protection — a leak
of the database — that the product does not claim for the other twelve
providers, and because the two notions stayed in the code, the docs and the
first screens, where the confusion was.

### Make the GitHub App public and keep everything

Fixes the second-organisation case in one line (`public: true` in the
manifest). Rejected as a fix of the symptom: the registration, the five
app-config keys and the Company apps page stay.

### Apps only, no pasted token (the v4 position)

[oauth-app-install-per-provider](oauth-app-install-per-provider.md). Already
set aside on 2026-10-13: three apps to register before the first connection
of a self-hosted instance.

### A shared app operated by Vaubaan, so that no instance registers anything

Rejected on 2026-10-14 ([feedback: integration apps, Supabase model]): a
GitHub App's private key mints tokens for every installation of that App; in
every instance it would let one instance reach every customer's repositories.
Reserved to a hosted offer whose keys never leave Vaubaan.

### Keep both ways in the code and hide the app way in the interface

The code, the tests and the handbooks keep two paths per plugin for a way
no instance is expected to use. The removal is the point.

## References

- Spec: `docs/spec/vaubaan-gateway.md` §0 "Connection", §4.2 Administration
  (company apps), §6, §7.2 — to amend on acceptance.
- Handbooks: `docs/handbook/connections.md`, `docs/handbook/providers/github.md`,
  `docs/handbook/providers/supabase.md`, `docs/handbook/providers/railway.md`,
  `docs/handbook/providers/gmail.md` — to amend with the removal.
- ADRs superseded: [company-apps-kept-where-they-add-something](company-apps-kept-where-they-add-something.md),
  [token-connections-beside-the-integration-app](token-connections-beside-the-integration-app.md),
  [company-app-created-from-a-manifest](company-app-created-from-a-manifest.md).
- ADR kept: [gateway-as-git-remote](gateway-as-git-remote.md) (the remote
  works with a pasted token; its mention of `mint_install_token` for LFS
  becomes a known gap).
