---
title: Company apps kept where they add something; a token is the default way everywhere else
status: superseded
superseded-by: one-place-to-authorize-services-token-first
date: 2026-10-16
extends:
  - token-connections-beside-the-integration-app
---

# Company apps kept where they add something; a token is the default way everywhere else

> **Proposed** on 2026-10-16, for the product owner to decide. Raised by him:
> "app or token — I find these two notions confusing; I wonder what keeping
> the integration-app level is worth." Nothing is implemented. If accepted, it
> amends [[token-connections-beside-the-integration-app]] (D2: which way is
> offered first) and the Administration page of company apps.

## Context

Since [[token-connections-beside-the-integration-app]], a service can be
connected two ways:

- **through the company app**: an administrator registers, once for the
  instance, an app at the service (GitHub App from a manifest; Supabase,
  Railway and Google OAuth apps by hand), then each person connects with one
  click;
- **with a token**: each person creates a token at the service and pastes it,
  guided by the plugin.

Today a service with both ways offers the app first when it is registered,
and "Use a token instead" one click away. What exists per service:

| Service                                         | App way               | Token way                                     |
| ----------------------------------------------- | --------------------- | --------------------------------------------- |
| GitHub                                          | GitHub App (manifest) | fine-grained token (no install-token minting) |
| Supabase                                        | OAuth app             | personal access token                         |
| Railway                                         | OAuth app             | workspace or account token                    |
| Gmail (experimental)                            | Google OAuth app      | — (Google has no personal token)              |
| Vercel, Stripe, Resend, Upstash, Cloudflare DNS | —                     | token only                                    |
| SSH                                             | —                     | key pair made by the gateway                  |

Two notions for one act (connect an account) confuse an administrator: the
first question of an install becomes "should I register apps?", for a benefit
the interface does not state. Teams of the pilots use one shared service
account per service, where the per-person consent of an OAuth app buys
little.

What an app gives that a token does not, per service:

- **GitHub App**: short-lived installation tokens (one hour, refreshed by the
  gateway), repositories chosen at installation, actions attributed to the
  app rather than to a person, nothing to rotate when the person who set it
  up leaves, and `mint_install_token` (a token for a clone or push outside
  the gateway). Real, and the manifest makes it one click.
- **Supabase and Railway OAuth apps**: short-lived access tokens with a
  refresh token, revocable at the service from its list of authorized apps.
  The person still needs an account with the same rights; with a shared
  service account, the difference with a token that has an expiry is small.
- **Google OAuth app**: the only way; Gmail has no token way.

## Decision (proposed)

### D1 — One notion in the interface: "connect", and the way is a detail

The page that connects an account shows one button per service. The way is
chosen by the gateway (D2) and named in one line under the button ("through
your company's GitHub App" / "with a token you create at Supabase"), with the
other way as a link. No page asks a person to choose between "app" and
"token" before they know what either is.

### D2 — Which way is offered first

- **GitHub**: the company app when it is registered; otherwise the token,
  and the setup checklist recommends registering the app, saying what it adds
  (D3).
- **Every other service**: the **token first**, even when a company app is
  registered. The OAuth app stays available ("connect through your company's
  app instead").
- **Gmail**: the OAuth app, the only way (unchanged).

### D3 — The company apps page says what each app adds, and is optional

Administration → Company apps lists only the services where an app exists,
each with one sentence on what it adds over a token (from the plugin), and is
no longer a step of the first-run checklist except for GitHub ("recommended")
and Gmail ("required to connect Gmail").

### D4 — Nothing is removed

No way is deleted from a plugin, no stored connection changes, no migration.
An instance that registered OAuth apps keeps using them for its accounts.

## Consequences

Positive:

- An install needs no app registration to connect every service but Gmail.
- One notion in the interface; the second appears only where it adds
  something, with the reason.
- The GitHub App keeps its place, which is where the security benefit is.

Negative:

- Tokens are long-lived and tied to the person who created them. The token
  guides already ask for an expiry and the narrowest permissions; a token
  that expires turns the account into "Needs reconnecting", as today.
- Two ways stay in the code for Supabase and Railway, for a way most
  instances will not use.

## Rejected alternatives

### Remove the OAuth apps of Supabase and Railway

Simplest code. Refused in this proposal because it deletes something built and
working (the decision behind [[token-connections-beside-the-integration-app]]:
nothing already built is removed) and because an instance with per-person accounts
(no shared service account) loses short-lived credentials. To reconsider after
the pilots if no instance uses them.

### Remove tokens, apps only

The v4 position ([oauth-app-install-per-provider](oauth-app-install-per-provider.md)).
Refused by [[token-connections-beside-the-integration-app]]: three apps to
register before the first connection.

### Keep the interface as it is and document the difference

The confusion is in the first steps of an install, where people read the
least.

## Questions for the product owner

1. Token first for Supabase and Railway even when their app is registered
   (D2), or app first whenever it is registered (today's rule)?
2. Remove the Supabase and Railway OAuth apps now (rejected alternative 1)
   rather than keep them behind a link?
