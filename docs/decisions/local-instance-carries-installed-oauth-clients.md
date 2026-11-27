---
title: A local instance carries Vaubaan's installed-app OAuth clients — one per provider, for sign-in and services, back on the loopback at any port
status: accepted
date: 2026-11-27
author: Renaud Pelissier (product owner), drafted with Claude
---

# A local instance carries Vaubaan's installed-app OAuth clients — one per provider, for sign-in and services, back on the loopback at any port

## Context

A person who installs Vaubaan on their computer
([local-mode-for-an-instance-on-this-computer](local-mode-for-an-instance-on-this-computer.md))
cannot register an OAuth client at Google, Microsoft or GitHub, and has no broker: they could
neither sign in with those accounts nor connect Calendar or Outlook. The three providers offer a
client made for this, an installed application (Google "Desktop app", a Microsoft public client,
a GitHub OAuth App): no confidential secret, PKCE, and a redirect on `127.0.0.1` at any port
without registering it. The desktop app opens these consent pages in the default browser, Google
refusing an embedded webview, so the redirect lands in a browser that is not the one that started.

## Decision

An instance in local mode, and only there, carries one Vaubaan installed-app client per provider
(`google`, `microsoft`, `github`), the same client for signing in and for the services, each flow
asking only the scopes of its purpose. It runs the code flow itself, with `state` and PKCE S256,
back to `http://127.0.0.1:<port of its public URL>/oauth/loopback`; the callback finishes the exchange from the
server-side record named by `state`, and the browser or window that started the flow, proven by
its own cookie, takes the result. Refresh tokens stay on the computer, sealed under the master key.

## Consequences

- The embedded client is the default source of the `google` and `microsoft` services in local mode,
  beside a broker or an own client
  ([oauth-brokers-managed-in-settings-with-two-client-sources](oauth-brokers-managed-in-settings-with-two-client-sources.md));
  plugins keep `broker: { provider, scopes }` unchanged. A hosted instance never uses these clients.
- Google, Microsoft and GitHub are sign-in providers of a local instance from its setup on, beside
  email and password; identities stay (issuer, subject), never merged by email. The master key
  recovers the instance whatever the first account signed in with.
- A client id is public and lives in the repository; a client secret (Google, GitHub) enters the
  build from CI secrets, and a build without it offers neither that sign-in nor that service.
- Scopes that need a provider's verification are asked by the plugin that needs them: Gmail stays
  on IMAP ([gmail-over-imap-with-an-app-password](gmail-over-imap-with-an-app-password.md)); Drive's
  restricted scopes show "unverified app" and a 100-user cap until Vaubaan passes Google's review.

## Rejected alternatives

### The hosted OAuth broker for local instances too

An instance meant for one computer would depend on a service run elsewhere, and its mailbox and
calendar grants would transit it, for nothing the loopback flow cannot do itself.

### One client of the person's own, as on a hosted instance

The wall this decision removes: a Google Cloud project, an Entra registration and a GitHub app
before the first sign-in.

### Separate clients for sign-in and for services

Two consent screens naming two Vaubaans for one account, and twice the verification work.

### A custom URL scheme (`vaubaan://`) for the redirect

Desktop app only, and any other app can claim the scheme; the loopback serves the docker command as
well.
