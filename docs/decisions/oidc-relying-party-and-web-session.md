---
title: OIDC relying party and web session
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
  - docker-image-and-config-format
---

# OIDC relying party and web session

> Fixes what the pivot ADR (D2: generic OpenID Connect, groups from claims,
> no password, bootstrap by token) left open: the relying-party library, the
> session model, the claim mapping, the bootstrap-to-admin-rule transition
> and the operator identification afterwards (plan §5.2, §8-Q2). Implemented
> by feature P1.1. Handbook: [authentication](../handbook/authentication.md).

## Context

The instance is one Node process behind the company's TLS terminator
(ADR docker-image-and-config-format): every endpoint is a Next route
handler, the server code never imports `next`, the composition root is built
once and holds the ports (`SessionStore` among them, in-memory until now).
Spec §6 requires short web sessions bound to the instance's origin and an
origin check on every mutation; §4.3 lists the IdP block (issuer, client
id/secret, claim mapping) in the operator's configuration; §0 and §7.1
describe the bootstrap token and the **admin rule** (IdP group name or email
list) that defines the operator once the token is revoked.

Facts that shaped the choice (research note `v5-process-shape.md` §6):

- `openid-client` 6.8.x is runtime-agnostic (Web Crypto + `fetch`), covers
  discovery, PKCE, `authorizationCodeGrant` with state/nonce checks,
  `fetchUserInfo`, client authentication methods and a `customFetch` hook.
- `authorizationCodeGrant` validates the callback against the `currentUrl`
  the caller passes; behind a proxy `request.url` is the internal host.
- Corporate IdPs differ on groups: Keycloak and Okta emit names (Okta
  behind a `groups` scope), Entra ID emits object ids by default, Google
  has no groups claim at all. Some bridges emit a delimited string.
- The v4 UI authenticated through Supabase Auth (GitHub SSO); the pivot
  drops it.

## Decision

1. **Library: `openid-client` 6.8.x, used as a plain relying party.**
   `discovery()` + `ClientSecretPost`, `buildAuthorizationUrl` with
   PKCE S256, `state` and `nonce`, `authorizationCodeGrant(config,
currentUrl, { expectedState, expectedNonce, pkceCodeVerifier,
idTokenExpected })`, `fetchUserInfo` when the server has a userinfo
   endpoint. One generic RP for every IdP; no per-provider adapter. Clock
   tolerance 60 s on ID-token validation. The `Configuration` of an issuer
   is cached per process (dropped on failure); `RootDeps.oidc.fetch`
   injects `customFetch` (corporate proxy, in-process IdP in tests) and
   `allowInsecureIssuer` lets tests use an `http://` issuer.
2. **The callback URL is rebuilt from `public_url`.** `/auth/callback`
   passes `callbackUrl(config.publicUrl)` plus the request's query string to
   the grant — never `request.url`, never `X-Forwarded-*`. The redirect URI
   to register at the IdP is therefore exactly `<public_url>/auth/callback`.
3. **Server-side session rows behind the `SessionStore` port, opaque
   cookie.** `SqliteSessionStore` (table `web_sessions`, migration 0003)
   replaces the in-memory default of the root; the record holds the user id
   (or the bootstrap marker) and the claims seen at sign-in for display,
   never authority. Cookie `vbn_session`: `HttpOnly; Secure; SameSite=Lax;
Path=/`, **8 hours absolute** (no sliding). The pending OIDC attempt
   (state, nonce, PKCE verifier, return path) is a second record kind in
   the same store, cookie `vbn_login`, 10 minutes, single use.
4. **Origin check in the handler, no middleware.** Every mutation
   (`POST /logout`, `/api/auth/bootstrap`, `/api/admin/identity-provider`)
   requires `Origin` (fallback: `Referer`'s origin) to equal
   `public_url`'s origin; absent → 403. Forms are plain HTML POSTs so
   browsers always send `Origin`. No CSRF token, no `proxy.ts`.
5. **Claim mapping from configuration, ID token over userinfo.** Claims =
   `{ ...userinfo, ...idToken }`; the configured `sub`/`email`/`groups`
   names are read from that object; `groups` accepts an array, a
   space/comma/semicolon delimited string, or nothing. `sub` or `email`
   missing fails closed (`claims-missing`); email lower-cased; the optional
   `allowed_email_domains` filter applies after mapping. Scopes requested:
   `openid profile email`, plus `groups` only when `scopes_supported`
   advertises it.
6. **Groups: IdP memberships replaced on every sign-in, local groups
   untouched.** Claimed names are `getOrCreate(name, 'idp')`; the user is
   removed from IdP-sourced groups no longer claimed; a claim whose name
   is an existing **local** group is ignored with a warning (the operator's
   table is never written by a claim). Emptied IdP groups keep their row.
7. **IdP settings: file wins over store; secret sealed.** `InstanceConfig.idp`
   (mounted file / env) is authoritative and makes the Admin page read-only;
   otherwise the Admin → Identity provider page writes `instance_config`
   (`idp.*` keys), the client secret sealed by the `Encryptor` under
   `instance_config:idp.client_secret`. Saving is audited as
   `config-changed` on `instance-config/idp` with issuer and client id only.
8. **Bootstrap token revoked by the first operator sign-in.** While no IdP
   is configured in the file, the operator signs in at `/admin/bootstrap`
   with the token (constant-time compare, refused once revoked). The first
   IdP sign-in of a user **matching the admin rule** writes
   `bootstrap.revoked_at` in `instance_config`; from then on the token and
   every open bootstrap session are refused. A non-operator sign-in revokes
   nothing. The audit actor of a change made under bootstrap is the literal
   user id `bootstrap`.
9. **Operator after bootstrap = the admin rule, recomputed each time.**
   `isOperator(user)` is true for a member of `admin.group` or a listed
   `admin.emails` entry, evaluated from the user's current `group_members`
   rows on every request (answers plan §8-Q2 with the configuration's
   admin rule rather than a snapshot or a flag on the user row).
10. **Out of scope for v1.** RP-initiated logout at the IdP (the instance
    session ends alone), refresh tokens and any storage of IdP tokens,
    `private_key_jwt` client authentication, a rate limit on the bootstrap
    form (the token is ≥ 32 random characters), several IdPs at once (the
    login page is built for a list but the configuration holds one).

## Consequences

- One generic relying party replaces the GitHub SSO and Supabase Auth of
  v4; an operator configures any OIDC provider from the file or the Admin
  page and verifies it with "Test login", which shows the mapped claims.
- Web sessions survive a restart, are revocable by deleting a row, and are
  shared by replicas as soon as a shared `SessionStore` is injected; the
  cookie carries no claim a browser could read.
- The route handlers are one-liners; every decision is tested against the
  real `openid-client` with an in-process IdP (`FakeIdp` through
  `customFetch`), including the state and nonce checks and the public-URL
  callback.
- Entra ID deployments must either configure the app registration to emit
  group names or name the group's object id in `admin.group`; Google
  deployments rely on `admin.emails` (no groups claim).
- The `web_sessions` table adds a migration (schema v3) and the root reaches
  the store's connection to build the session store; `Store.db` is no longer
  diagnostics-only.
- A removed user (`status: removed`) loses their session on the next request;
  a session's absolute 8-hour life is the only other expiry.

## Rejected alternatives

- **Auth.js / NextAuth.** Framework-bound (the server code would import
  `next`), hides the groups-claim handling behind provider adapters, and its
  database session model would duplicate the store's repositories. A hosted
  variant on another HTTP host could not reuse it.
- **Hand-rolled over `oauth4webapi` or `jose`.** Possible (openid-client is
  a thin layer over oauth4webapi), but discovery, client authentication,
  response validation and the error taxonomy would be re-implemented for no
  gain; the thin layer is exactly what is needed.
- **Passport strategies.** Express-shaped middleware; no web-standard
  `Request` path.
- **Signed or encrypted stateless cookie.** No store round trip, but
  revocation would need a denylist anyway, the cookie would carry claims,
  and the 8-hour TTL makes the round trip (one indexed SQLite read) a
  non-issue.
- **In-memory sessions (the P0.4 default).** Lost on restart; not shareable
  between replicas; acceptable for caches, not for a credential.
- **Session cookie `SameSite=Strict`.** Would drop the pending-login cookie
  on the top-level redirect back from the IdP (the classic "state
  mismatch"); `Lax` plus the origin check on mutations gives the same
  protection for POSTs.
- **CSRF tokens in forms.** Redundant with the origin check for same-origin
  HTML forms; would reappear only if a cross-origin API client needs the
  session, which spec §6 forbids (agents use mission or delegated tokens).
- **Trusting `request.url` or `X-Forwarded-Host` for the callback.** The
  former is the internal host behind the terminator, the latter is
  attacker-controlled unless `trusted_proxies` is consulted on every hop;
  `public_url` is already the single declared origin of the instance.
- **Requesting the `groups` scope unconditionally.** Google answers
  `invalid_scope`; keyed on `scopes_supported` instead.
- **Revoking the bootstrap token on any IdP sign-in, or only by hand.**
  The first would let a non-operator sign-in lock the instance (the rule
  may name a group nobody has joined yet); the second leaves a live
  super-credential in the configuration indefinitely. Revoking on the first
  operator sign-in is both safe and automatic; spec §7.1's manual
  revocation is subsumed.
- **Granting a claimed group that collides with a local group.** Would let
  the IdP write the operator's local table; skipped with a warning.
- **A "test login" that does not create a session.** Would need a second
  flow and could not show what authority the user actually gets; the real
  sign-in with a return path is simpler and more truthful.
