---
title: Management door — the instance is its own authorization server
status: accepted
date: 2026-10-13
extends:
  - pivot-v4-to-v5-on-prem-mission-tokens
  - oidc-relying-party-and-web-session
  - docker-image-and-config-format
---

# Management door — the instance is its own authorization server

> Settles the open question of spec §11.2 "Authorization server" and the
> points plan §5.3 lists with it: who issues delegated tokens, with which
> code, in which format, for how long, to which clients, and what the consent
> screen says. Implemented by feature P2.3. Handbook:
> [management-door](../handbook/management-door.md).

## Context

Spec §4.1 bis adds a second MCP door, `/mcp/manage`, for agents acting on
behalf of a user, "authenticated by OAuth … following the standard
authorization of MCP servers, metadata discovery included, so that a client
such as Claude Code connects with no special configuration". Spec §6 wants
the delegated token short-lived, renewable through a revocable refresh token,
limited to one management scope, traceable to the delegating user and the
client, and never able to open the execution door, the interface or a
request.

Facts that shaped the choice (research note `v5-process-shape.md` §5, the MCP
authorization specification revision 2026-07-28, and the behaviour of
`@modelcontextprotocol/client` 2.3.1 read in its source):

- An MCP client discovers everything from a `401`: the `WWW-Authenticate`
  challenge names the RFC 9728 document of the resource, which names the
  authorization server, whose RFC 8414 metadata names the endpoints. It then
  registers itself — by dynamic client registration (RFC 7591) or, when the
  server advertises `client_id_metadata_document_supported`, by presenting an
  https URL as its `client_id` — and runs the authorization-code flow with
  PKCE `S256`, the RFC 8707 `resource` parameter and, when advertised, the
  RFC 9207 `iss` check.
- The 2026-07-28 revision deprecates dynamic registration in favour of
  Client ID Metadata Documents, and keeps it for compatibility. Claude Code
  and most clients in the field register dynamically today.
- Corporate identity providers do not hand a client id to an arbitrary
  program on a developer's laptop. Okta, Entra ID and Google require an
  administrator to register each application, and none of them would issue a
  token whose audience is this instance's management door.
- The MCP TypeScript SDK in use (`@modelcontextprotocol/server` 2.3.1) keeps
  the resource-server half first-class and has **frozen** its
  authorization-server helpers in `@modelcontextprotocol/server-legacy/auth`,
  deprecated, with the advice to use a dedicated server or library.
- The instance already has what an authorization server needs: a human
  session backed by the IdP (ADR oidc-relying-party-and-web-session), a store
  with tables for clients, delegations, codes and tokens (P0.3), a
  `SessionStore` and a `RateLimiter` port, an append-only audit.

## Decision

### D1 — The instance issues delegated tokens itself; the IdP only identifies the user

`/mcp/manage` is the protected resource; the instance, at its `public_url`,
is the authorization server (issuer = `public_url` without a trailing slash).
The IdP is used exactly as for the interface: `/oauth/authorize` requires the
human session, and sends a visitor without one through `/auth/login` and back
to the very same request. No IdP token is accepted at a door, forwarded or
stored.

### D2 — A small in-house server, on the SDK's resource-server contract

The server is about 3,400 lines (comments included) under `apps/gateway/src/server/oauth-as/`,
host-agnostic (`Request → Response`), with no new dependency: metadata,
registration, authorization, token, revocation. It does one flow
(authorization code + PKCE), one scope and one resource, which is why it
stays small.

It is written against the standards, not from memory of them, and held to the
official client: an integration test drives `@modelcontextprotocol/client`
through discovery, registration, consent, the code exchange, an automatic
refresh and a revocation with no configuration but the door's URL. On the
resource-server side the module exports `DelegatedTokenVerifier`, which
satisfies the SDK's `OAuthTokenVerifier` contract (for `requireBearerAuth`)
and the execution door's `DelegatedTokenResolver`.

### D3 — Opaque tokens, stored as digests

| Secret             | Shape                        | Lifetime                                    | Stored as    |
| ------------------ | ---------------------------- | ------------------------------------------- | ------------ |
| authorization code | 32 random bytes, base64url   | 60 seconds, single use                      | SHA-256, row |
| access token       | `vbn_dat_` + 32 random bytes | `oauth.access_token_ttl`, 15 min            | SHA-256, row |
| refresh token      | `vbn_drt_` + 32 random bytes | `oauth.refresh_token_ttl`, 30 d, single use | SHA-256, row |
| client secret      | `vbn_dcs_` + 32 random bytes | until the client is disabled                | SHA-256, row |

A token carries no claim; its worth is its row, read at every call of the
management door. A revocation therefore takes effect on the next request,
with no signature to wait out and no key to manage. At 256 bits a plain
SHA-256 is not guessable, so no slow hash is needed and a copy of the
database is not a set of live tokens (the rule web sessions already follow).
The prefixes let a door and a secret scanner tell the kinds apart; none
collides with the mission token's `vbn_live_`.

The access token lifetime is configurable and **capped at one hour** by the
loader: a longer one is no longer the "short lifetime" of spec §6. The
refresh lifetime restarts at every renewal, so a delegation ends by itself
after `oauth.refresh_token_ttl` without use.

### D4 — One consent is one delegation is one token family; replay ends it

Every approved consent creates a new delegation row, and every token of that
delegation descends from its single authorization code. "The family" and "the
delegation" are the same thing, so revoking one is revoking the other, in one
transaction.

Refresh tokens rotate at every use. A refresh token **or an authorization
code** that comes back after it was used means two parties hold it; the
server cannot tell which is the thief, so it revokes the delegation with
every token under it and writes a `delegation-revoked` audit entry whose
reason is `refresh-token-replay` or `authorization-code-replay` (RFC 9700
§2.2.2 and §4.14; decided by the orchestrator for v5). There is no grace
window: two honest processes sharing one stored refresh token and renewing at
the same instant end their delegation, and the user consents again.

### D5 — Dynamic registration and metadata documents, behind a registration policy

Both ways of becoming a client are implemented. Dynamic registration is on
(Claude Code needs it today); Client ID Metadata Documents are implemented
and **off by default** (`oauth.client_registration.metadata_documents`),
because enabling them makes an on-prem instance issue outbound requests to
URLs a caller chose. When on, a document is fetched only for a signed-in
user's authorization request, over https, on the default port, from a DNS
name all of whose addresses are public, without following a redirect, capped
in size and time, and rate-limited per user.

A client is never trusted for what it says of itself. Whether it may ask
users for a delegation is decided by `oauth.client_registration.policy`:

- `open` — any client that registers is usable at once;
- `operator-approved` (**default**) — a client waits for an operator's
  approval under Administration → OAuth clients; except, while
  `oauth.client_registration.auto_approve_loopback` is true (**default**), a
  client all of whose redirect URIs are on the loopback interface;
- `closed` — nothing registers; only clients an operator approved are usable.

The status of a client is the operator's decision when there is one, else
what the policy says of it **now**: nothing is snapshotted, so tightening the
policy applies at once to every undecided client. Disabling a client revokes
every delegation it holds.

Why this default. The danger of open registration is consent phishing: anyone
who can reach the instance registers "Claude Code" with a redirect URI on
their own server, sends a colleague the authorization link, and one click on
"Authorize" hands them tokens that issue missions under the victim's
authority. A redirect URI on the loopback interface delivers the code to the
user's own machine only, so that attack needs code already running there —
the trust class RFC 8252 describes for native applications. Approving every
laptop's client by hand would contradict "connects with no special
configuration"; approving none would leave hosted clients one click away from
a user's authority. The default therefore lets command-line and desktop
agents connect by themselves and makes anything that sends the code elsewhere
(a server, an application-scheme link) wait for an operator.

### D6 — Redirect URIs: exact match, with the loopback port exception

A registration accepts three kinds and refuses everything else: `http` on
the loopback interface, `https` anywhere, and private-use application
schemes (a deny list keeps out `javascript:`, `data:`, `file:` and their
kin). A request's `redirect_uri` must equal a registered string exactly — no
prefix, no pattern, no normalisation. The one exception is the one OAuth 2.1
requires for native applications: a loopback URI may differ from a registered
loopback URI by its port alone.

Until the client and the redirect URI are established the server never
redirects: the human reads a page. It does not redirect either — not even an
error — before a user is signed in and the client is `approved`: registration
is open to anyone who reaches the instance, and a freshly registered client
must not turn the authorization endpoint into a redirector (RFC 9700
§4.11.2). Only then are the other parameters judged and their errors returned
through the redirect, with `state` and `iss`.

### D7 — The consent screen states where the code goes and treats the name as a claim

The screen is rendered by the server module itself, as a self-contained
document with no script and no external resource, never cached, never framed
(`Content-Security-Policy` with `frame-ancestors 'none'`, `X-Frame-Options:
DENY`), sending no referrer outside the instance, with every value the client
supplied escaped. It names the
application as "calls itself …" with the note that the name is not verified,
the client id and how it registered, the user it would act for, the single
scope `mgmt`, what that covers and what it can never do (spec §4.1 bis), and
— in its own box — the host or scheme the access will be sent to, with a
warning that depends on the kind (this computer, a server, an application
link). "Deny" is the first button, hence the one the Enter key activates.

What the screen showed is kept on the server (`SessionStore`, ten minutes,
single use, bound to the user): the form posts back an opaque id and a yes or
a no, through `guardMutation` like every mutation of the interface. Consent
is asked at every authorization; none is remembered.

### D8 — Two families of endpoints that never mix

`/oauth/register`, `/oauth/token`, `/oauth/revoke` and the two metadata
documents are **protocol endpoints**: they never read a cookie, so nothing
ambient authenticates them, which is why they may answer any origin (CORS,
for browser-based clients) and need no origin check. Each is rate-limited
through the `RateLimiter` port per client address.
`/oauth/authorize`, its decision, the delegation revocation and the client
decision are **human endpoints**, behind the session and the one mutation
guard.

### D9 — The management door admits a delegated token and nothing else

`ManagementGate` is the mirror of the execution door's admission. No
credential, or an unknown one, gets `401` with the RFC 9728 challenge — what
makes a client start the flow. A mission token (identified through the
execution door's throttled verifier) or a human session gets `403`
`wrong-credential-kind`, naming the door that would accept it, and no
challenge: an OAuth flow would not help. P2.3 ships the gate and a
placeholder door behind it that lists no tool; P2.4 keeps the gate and
replaces the placeholder.

## Consequences

- A Claude Code user adds `<public_url>/mcp/manage` and is sent to the
  browser: sign-in, one consent screen, done. No operator action under the
  default policy, because the client redirects to the loopback interface.
- A hosted client (one that redirects to an `https` server) shows the user
  "Waiting for an operator" until approved once. With metadata documents
  enabled its client id is a stable URL, so that approval is given once for
  every user; with dynamic registration each registration is a new client.
- Disabling a dynamically registered client ends its delegations at once but
  does not stop the program from registering again: under the default policy
  a loopback client is usable again immediately. Disabling is a revocation,
  not a ban; the ban is `auto_approve_loopback: false` or `closed`.
- The delegated token being opaque, every call of the management door costs
  one indexed read (two with the user and the client). In exchange a revoked
  delegation, a removed user and a disabled client stop at the next request.
- Delegations accumulate: each consent is a row, kept after revocation for
  the Delegations page and the audit. Codes and tokens are swept a day after
  they expire; a rotated refresh token is kept as long as its successor
  lives, so that its replay is still recognised.
- A client that renews one refresh token from two processes at once loses its
  delegation (D4). This is the price of treating replay as theft without a
  grace window.
- The instance must be reachable by the client at `public_url` for the token
  endpoint, and the RFC 8414 document lives at the origin's
  `/.well-known/oauth-authorization-server`: a `public_url` with a sub-path
  needs the reverse proxy to route `/.well-known/oauth-authorization-server/<path>`
  to it (the application has no base path).
- New operator surface: Administration → OAuth clients; five configuration
  keys under `oauth.*`; two administrative acts (`oauth-client-approved`,
  `oauth-client-disabled`) and one audit object type (`oauth-client`).
- Migration `0006` adds the client's registration kind, authentication
  method and operator decision, and the reason a delegation ended.

## Rejected alternatives

- **Accept the IdP's tokens at the management door.** No registration, no
  token endpoint to write. But every company's IdP administrator would have
  to register every MCP client, grant it an audience the IdP does not know,
  and the instance could neither bound the token to mission management nor
  revoke one delegation without touching the IdP. It also ties the door to
  what each IdP puts in its tokens. This is the alternative spec §11.2 named;
  it fails "connects with no special configuration".
- **The SDK's frozen helpers (`@modelcontextprotocol/server-legacy/auth`).**
  They exist and speak the right dialect, but they are Express routers in a
  deprecated package kept for migration, with the advice not to use them in
  production; the instance's endpoints are web-standard handlers. Building on
  a frozen dependency to save a few hundred lines would be a debt on the most
  security-sensitive surface.
- **A full OpenID provider library (`oidc-provider`).** Certified and
  complete, and far larger than the need: its own storage adapters, session
  and interaction model, key management and JWT machinery for a server that
  issues one opaque scope for one resource. Most of the work would be
  disabling features and bridging its sessions to the instance's.
- **JWT access tokens.** Verifiable without a read, which matters across
  services; here the verifier and the issuer are one process on one store.
  A JWT cannot be revoked before it expires without the very lookup it was
  meant to avoid, and it brings signing keys to generate, store and rotate.
- **Remembering consent** (skip the screen for a client the user already
  approved). A public client's id is not a secret: any program presenting it
  with a loopback redirect would be granted a delegation silently.
- **A grace window on refresh rotation** (accept the previous token for a few
  seconds). It tolerates concurrent renewals, and it is exactly the window a
  thief needs. The orchestrator decided replay revokes the family.
- **`open` as the default policy.** Simplest for everyone, and one phishing
  link away from a user's authority for any client that redirects off the
  machine.
- **Approval of every client, loopback included, as the default.** Safest,
  and it makes each developer wait for an operator before their agent can
  prepare a mission, for a class of client that can only return the code to
  the developer's own machine.
- **Prefix or pattern matching of redirect URIs.** Convenient for clients
  with many callback paths; every open-redirect and code-theft bug of OAuth's
  history lives there.
