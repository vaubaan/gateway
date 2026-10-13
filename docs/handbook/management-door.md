---
title: Management door — authorization server, delegated tokens, admission, tools
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/oauth-as/
  - apps/gateway/src/server/management/
  - apps/gateway/src/server/compose/management.ts
  - apps/gateway/src/server/store/repositories/delegations.ts
  - apps/gateway/migrations/0006_oauth_client_decisions.sql
  - apps/gateway/src/app/oauth/
  - apps/gateway/src/app/.well-known/oauth-authorization-server/route.ts
  - apps/gateway/src/app/.well-known/oauth-protected-resource/mcp/manage/route.ts
  - apps/gateway/src/app/.well-known/oauth-protected-resource/route.ts
  - apps/gateway/src/app/mcp/manage/route.ts
  - apps/gateway/src/app/(app)/delegations/
  - apps/gateway/src/app/admin/(guarded)/oauth-clients/
  - apps/gateway/tests/integration/oauth-as/
  - apps/gateway/tests/integration/management/
  - apps/gateway/tests/e2e/v5/delegate-agent.spec.ts
  - apps/gateway/tests/integration/store/oauth-clients.test.ts
  - apps/gateway/tests/integration/store/delegations.test.ts
  - apps/gateway/src/server/missions/draft-schema.ts
  - apps/gateway/src/app/agent-bootstrap.md/content.md
---

# Management door — authorization server, delegated tokens, admission, tools

How an agent comes to act **on behalf of a user** (spec §0 "Delegation",
§4.1 bis, §6 "separation of the three credentials", "short, traceable
delegated tokens"): the instance is an OAuth authorization server for one
resource, the management MCP door `/mcp/manage`. ADR
[management-door-authorization-server](../decisions/management-door-authorization-server.md).
Built on [authentication](authentication.md) (the human session, the mutation
guard), the [store](store.md) (`store.delegations`), the
[configuration](configuration.md) (`oauth.*`, the `SessionStore` and
`RateLimiter` ports) and the [audit](audit.md).

The page has two halves. **The authorization server** (feature P2.3):
discovery, clients, consent, tokens, revocation, the admission gate of the
door, the Delegations page. **The door's tools** (feature P2.4, section
[The door's tools](#the-doors-tools)): what an admitted agent can read,
preview, issue, rotate and revoke, and what the door is structurally unable
to do.

## Layout

```
apps/gateway/src/server/oauth-as/        host-agnostic, never imports `next`
  index.ts                    createOAuthAsModule() → root.oauth; createManagementGate() → root.management.gate
  endpoints.ts                paths, the scope `mgmt` and its three rules, issuer and resource URLs, RFC 8414 / RFC 9728 documents
  secrets.ts                  mint (256-bit, prefixed), SHA-256 digest, shape checks, constant-time match
  pkce.ts                     S256 only: challenge / verifier syntax, constant-time verification
  redirect-uri.ts             what may be registered (loopback, https, app scheme), exact match + loopback port
  client-metadata-document.ts client ids that are https URLs: URL rules, public-address-only fetch, document validation
  clients.ts                  ClientRegistry: dynamic registration, document clients, registration policy, operator decisions
  authorization.ts            AuthorizationService: client + redirect URI, request validation, pending consent, the answer
  token-service.ts            TokenService: client authentication, code grant, refresh rotation, replay, revocation, sweep
  delegations.ts              DelegationService: a user's delegations with client and missions; revoke. endDelegation(): the one revoke-and-audit
  verifier.ts                 DelegatedTokenVerifier: resolve(bearer)
  management-gate.ts          ManagementGate.admit(request): the resource-server check of /mcp/manage
  pages.ts                    the consent screen and the message pages, as self-contained HTML
  handlers.ts                 Request → Response handlers of the nine endpoints; the execution door's discovery document
  errors.ts                   OAuthProtocolError (slowDown), AuthorizationPageError, AuthorizationRedirectError
  testing.ts                  openOAuthRig(): the services on the :memory: store (tests only)
apps/gateway/src/server/management/      host-agnostic, never imports `next`
  index.ts                    createManagementModule(ports) → { tools, door, handlers }
  ports.ts                    ManagementModuleDeps: the four ports the door is built from — the hard deny
  definitions.ts              MANAGEMENT_TOOLS: names, input schemas, the descriptions an agent reads; MANAGEMENT_INSTRUCTIONS
  output-schemas.ts           MANAGEMENT_OUTPUT_SCHEMAS: the shape of each tool's successful answer, loose at every level
  tools.ts                    ManagementTools: the seven acts as typed methods, refusals, the mutation budget
  views.ts                    snake_case answers: connection, catalog, mission, preview — over the mission module's own rules
  door.ts                     ManagementDoor: admit → surface rate limit → MCP server with the seven tools
apps/gateway/src/server/compose/
  management.ts               wireManagementDoor(): builds the gate and narrows the services to the ports
apps/gateway/src/app/
  .well-known/oauth-authorization-server/route.ts          GET   RFC 8414
  .well-known/oauth-protected-resource/mcp/manage/route.ts GET   RFC 9728, the management door
  .well-known/oauth-protected-resource/route.ts            GET   RFC 9728, the execution door (no authorization server)
  oauth/register/route.ts            POST  dynamic client registration
  oauth/authorize/route.ts           GET   authorization request → sign-in → consent screen
  oauth/authorize/decision/route.ts  POST  the user's answer
  oauth/token/route.ts               POST  code and refresh grants
  oauth/revoke/route.ts              POST  RFC 7009
  mcp/manage/route.ts                the management door (gate + tools)
  (app)/delegations/page.tsx                 /delegations
  (app)/delegations/[id]/revoke/route.ts     POST  one-click revoke
  admin/(guarded)/oauth-clients/page.tsx     /admin/oauth-clients
  admin/(guarded)/oauth-clients/[id]/route.ts POST  approve / disable
```

Every route file is a one-line adapter over `root.oauth.handlers.*`,
`root.oauth.discovery.executionResource` (the path-less RFC 9728 document) or
`root.management.handlers.mcp`. `tests/integration/oauth-as/routes.test.ts`
holds the table the tests drive (`ROUTES` in `support.ts`) to those files.

## What a client does, and what answers

```
agent                                          instance                                      human
POST /mcp/manage                 ─────────────▶ 401  WWW-Authenticate: Bearer realm=…,
                                                     resource_metadata="<public_url>/.well-known/oauth-protected-resource/mcp/manage",
                                                     scope="mgmt"
GET  …/oauth-protected-resource/mcp/manage ───▶ { resource: <public_url>/mcp/manage, authorization_servers: [<public_url>], scopes_supported: [mgmt] }
GET  /.well-known/oauth-authorization-server ─▶ { issuer: <public_url>, authorization_endpoint, token_endpoint, registration_endpoint, … }
POST /oauth/register {redirect_uris,…} ───────▶ 201 { client_id: vbn_client_… }
opens the browser at /oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&state&scope=mgmt&resource
                                                303 /auth/login?return_to=/oauth/authorize?…  ──▶ IdP sign-in ──▶ back to the same request
                                                200 consent screen                             ──▶ Authorize / Deny
                                 POST /oauth/authorize/decision {consent, decision}  ◀──────────
                                                303 <redirect_uri>?code=…&state=…&iss=<public_url>
POST /oauth/token grant_type=authorization_code code code_verifier client_id [redirect_uri] [resource]
                                 ─────────────▶ 200 { access_token: vbn_dat_…, token_type: Bearer, expires_in: 900, refresh_token: vbn_drt_…, scope: mgmt }
POST /mcp/manage  Authorization: Bearer vbn_dat_… ▶ 200 (MCP)
POST /oauth/token grant_type=refresh_token refresh_token client_id ▶ 200 a new pair; the presented refresh token is spent
```

This is the sequence `@modelcontextprotocol/client` 2.3.1 performs with no
configuration but the door's URL (`mcp-client-flow.test.ts` asserts the order
of the discovery requests).

## Discovery (`endpoints.ts`)

`oauthEndpoints(publicUrl)` builds every URL on the configured `public_url`,
never on the host the process sees. The **issuer** is `public_url` without a
trailing slash; clients compare it as a string with the entry of
`authorization_servers` they followed and with the `iss` of the authorization
response.

The RFC 8414 document advertises exactly what is implemented:
`response_types_supported: [code]`, `response_modes_supported: [query]`,
`grant_types_supported: [authorization_code, refresh_token]`,
`code_challenge_methods_supported: [S256]`,
`token_endpoint_auth_methods_supported` and
`revocation_endpoint_auth_methods_supported: [none, client_secret_basic,
client_secret_post]`, `scopes_supported: [mgmt]`, `revocation_endpoint`,
`authorization_response_iss_parameter_supported: true`,
`client_id_metadata_document_supported` (the configuration), and
`registration_endpoint` unless the policy is `closed`.

There are two RFC 9728 documents. `/.well-known/oauth-protected-resource`
describes the **execution** door and lists no authorization server
(`executionResourceMetadata`: `resource: <public_url>/mcp`,
`authorization_servers: []`, `bearer_methods_supported: [header]` — an MCP
client that probes on connect then uses the bearer it was configured with);
`/.well-known/oauth-protected-resource/mcp/manage` describes the management
door. A client looks at the path-aware one first, and the door's challenge
names it explicitly. The three discovery documents are served the same way
(`metadata()` in `handlers.ts`): `GET` and `HEAD`, `OPTIONS` as a CORS
preflight, any origin, `Cache-Control: no-store`, 405 otherwise. The
execution door's one is `root.oauth.discovery.executionResource`, beside
`root.oauth.handlers` and not in it: it is no endpoint of the authorization
server, only a document built on the same `public_url` rule.

**One scope, one resource — stated once, in `endpoints.ts`.** The three rules
about the scope differ on purpose and each has its name:

| Function                         | Used by                               | Rule                                                            |
| -------------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `asksForManagement(scope)`       | `AuthorizationService.validate`       | the request **includes** `mgmt`; other values are ignored       |
| `staysWithinManagement(scope)`   | `TokenService.refresh`                | a renewal **names nothing but** `mgmt` (it must not widen)      |
| `carriesManagementScope(scopes)` | `ManagementGate.admit`                | the delegation's scopes include `mgmt`                          |
| `foreignResource(endpoints, rs)` | `validate`, `TokenService` (RFC 8707) | the first `resource` that is not the management door, or `null` |

`scopesOf` splits a scope string; `ONLY_SCOPE_MESSAGE` and
`onlyResourceMessage` word the two refusals.

A `public_url` with a sub-path: the application has no base path, so the
reverse proxy must route `/.well-known/oauth-authorization-server/<path>` to
`/.well-known/oauth-authorization-server`.

## Secrets (`secrets.ts`)

| Secret             | Shape                                | Lifetime                                       |
| ------------------ | ------------------------------------ | ---------------------------------------------- |
| authorization code | 43 base64url characters              | `AUTHORIZATION_CODE_TTL_MS`, 60 s, single use  |
| access token       | `vbn_dat_` + 43 base64url characters | `oauth.access_token_ttl`, 15 min (at most 1 h) |
| refresh token      | `vbn_drt_` + 43 base64url characters | `oauth.refresh_token_ttl`, 30 d, single use    |
| client secret      | `vbn_dcs_` + 43 base64url characters | the life of the client                         |
| client id          | `vbn_client_` + 22 characters        | not a secret                                   |

All are 32 random bytes; only `digestOf(secret)` (SHA-256, hex) is stored and
looked up. A value of another shape is refused before anything is hashed
(`isAccessTokenShaped`…). A client secret is compared with its stored digest
by `matchesDigest` (`timingSafeEqual` over two digests), a PKCE verifier with
the challenge by `verifyS256` (same). Nothing logs a secret: entries name the
delegation id and the client id (`http-surface.test.ts` "logs" searches the
whole log for the code, both tokens and the verifier after every refusal
path).

## Clients (`clients.ts`, `redirect-uri.ts`, `client-metadata-document.ts`)

**A client is a claim.** Its name is whatever the registering party typed
(`cleanClientName`: control characters, zero-width characters and
bidirectional overrides stripped, 80 characters). What the instance states as
fact is where the code will be sent.

### Redirect URIs

`checkRedirectUri(raw)` accepts three kinds and refuses the rest:

| Kind         | Example                                                                     | The code goes to                               |
| ------------ | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `loopback`   | `http://127.0.0.1:43210/callback`, `http://localhost/cb`, `http://[::1]/cb` | the user's own machine                         |
| `web`        | `https://agent.example.net/oauth/callback`                                  | a server on the network                        |
| `app-scheme` | `cursor://…`, `com.example.app:/cb`                                         | the application the system bound to the scheme |

Refused: plain `http` off the loopback interface, a fragment, credentials,
spaces / control characters / backslashes, more than 1024 characters, and the
schemes a browser gives a meaning of its own (`javascript`, `data`, `file`,
`blob`, `ws`, browser-extension schemes…). The loopback interface is judged on
the host the URL parser yields, so `http://127.1/` is the loopback and
`http://127.0.0.1.example.net/` is not.

`matchesRegisteredRedirect(registered, presented)`: one of the registered
strings **exactly**, or — loopback only — a registered loopback URI on
another port (same scheme, host, path and query). Nothing else: no prefix, no
case folding, no dot-segment resolution.

### Dynamic registration (`ClientRegistry.register`)

`POST /oauth/register` with an RFC 7591 JSON body. Validated: `redirect_uris`
(1 to 10, each through `checkRedirectUri` → `invalid_redirect_uri`),
`token_endpoint_auth_method` (`none`, `client_secret_basic`,
`client_secret_post`; omitted means `client_secret_basic`, RFC 7591 §2),
`grant_types` (must include `authorization_code`, only the two supported),
`response_types` (`code`). Ignored: any `scope` (always `mgmt`), any
`client_id` or `client_secret` the caller proposes. A confidential client
receives its secret once, in the response; the row keeps the digest.

Each registration first deletes the clients registered more than 30 days ago
that no operator decided about and that never received a delegation
(`UNUSED_CLIENT_RETENTION_MS`).

### Client ID Metadata Documents

Off unless `oauth.client_registration.metadata_documents` is true; no fetcher
is even constructed otherwise. A `client_id` starting with `https://` is then
a document URL:

- `checkClientIdUrl`: canonical form (`new URL(raw).href === raw`), default
  port, a path, a fully qualified DNS name — no IP literal, credentials or
  fragment.
- `handlers.authorize` signs the user in **before** resolving such a client,
  so only a signed-in user causes a fetch; `resolveDocumentClient` rate-limits
  them per user (`DOCUMENT_FETCHES_PER_WINDOW`, 10 per minute).
- `createClientDocumentFetcher`: one `GET` over `node:https` with
  `publicOnlyLookup` — the name is resolved once, and if **any** of its
  addresses is not public the lookup fails (`isPublicAddress`: loopback,
  private, link-local, carrier-grade NAT, unique-local, the deprecated IPv6
  site-local block `fec0::/10`, multicast, documentation, NAT64,
  IPv4-mapped); the peer actually connected to is
  checked again; no redirect is followed; 5 s; 16 KiB; `agent: false`.
- `parseClientDocument`: HTTP 200, a JSON content type, `client_id` equal to
  the URL, no `client_secret`, `token_endpoint_auth_method` absent or `none`
  (public clients only), a `client_name`, 1 to 10 valid `redirect_uris`.
  `Cache-Control: max-age` bounds the reuse (5 minutes to 24 hours, 1 hour by
  default); an expired document is fetched again and **fails closed** when it
  cannot be read.
- The token endpoint never fetches: it only knows clients an authorization
  request already resolved.

A deployment behind an outbound HTTP proxy cannot use them (the fetcher
connects directly).

### Registration policy and operator decisions

```
statusOf(client) = client.operatorDecision            when an operator decided (approved | disabled)
                 = policy says, now:
                     open               → approved
                     operator-approved  → approved  if auto_approve_loopback and every redirect URI is loopback
                                          pending   otherwise
                     closed             → pending   (and nothing registers)
```

Nothing but the operator's decision is stored (`oauth_clients.operator_decision`,
`decided_at`, `decided_by`); the policy is evaluated at every use, so a
stricter configuration applies at once to every undecided client, and a
metadata-document client that adds a server to its redirect URIs goes back to
`pending`.

"Every use" is three places, and all three call `statusOf`:

| Where                                     | A client that is not `approved` gets                              |
| ----------------------------------------- | ----------------------------------------------------------------- |
| `GET /oauth/authorize`, and the decision  | a 403 page; `client-unavailable` if it changed after the screen   |
| `POST /oauth/token`, `POST /oauth/revoke` | `unauthorized_client`                                             |
| **the management door**, at every request | 401 with the challenge: `DelegatedTokenVerifier.resolve` → `null` |

The third row is what makes "at once" true for tokens already issued: an
access token of a client the policy no longer approves — or that an operator
disabled — stops at its next call, not at its expiry (15 minutes, up to an
hour). Nothing is revoked by a policy change: the delegation stays `active`,
and a policy relaxed again restores the client, its refresh token and its
unexpired access tokens. The execution door, which uses the same verifier
only to name the kind of a bearer it refuses, answers such a token as an
unknown bearer (401) instead of `wrong-credential-kind`; it refuses it either
way.

`ClientRegistry.decide(actor, id, decision)` — Administration → OAuth clients
— records the decision and writes `oauth-client-approved` or
`oauth-client-disabled` (object `oauth-client`). **Disabling revokes every
delegation the client holds**: the decision, the delegations and their
refresh and access tokens are **one transaction** of the store
(`DelegationsRepo.disableClient`), so a client is never left marked
`disabled` with a live delegation, and a store fault half-way changes nothing
at all. Each delegation then leaves its own `delegation-revoked` entry
(reason `operator`, `after.delegating_user_id`) that the delegating user
finds in their audit. The entries are written after the transaction: a fault
of the audit store at that point leaves the client disabled and the
delegations revoked — the safe side — with entries missing, and the error is
thrown to the operator's request.

Disabling a dynamically registered client is a revocation, not a ban: the
program can register again, and under the default policy a loopback client is
usable at once. To bar a class of clients, set `auto_approve_loopback: false`
or the policy `closed`.

## Authorization (`authorization.ts`, `handlers.authorize`, `pages.ts`)

`GET /oauth/authorize`, in this order:

1. **The client and its redirect URI** (`resolveClient`). Unknown client,
   missing `client_id`, a `redirect_uri` that is not registered (or absent
   when several are): **a page, HTTP 400, never a redirect**
   (`AuthorizationPageError`). The page does not repeat the address it
   refused to trust.
2. **The human session.** None: `303 /auth/login?return_to=/oauth/authorize?<same query>`
   (validated by `safeReturnTo`, like every return address). The bootstrap
   operator: a 403 page (a delegation is given by a user).
3. **The client's status.** `disabled` or `pending`: a 403 page naming the
   client and, for `pending`, what to ask the operator.
4. **The rest of the request** (`validate`): `response_type=code`;
   `code_challenge` present and a base64url SHA-256;
   `code_challenge_method=S256` (absent or `plain` is refused); `scope` absent
   or containing `mgmt` (other scopes are ignored, the grant is always exactly
   `mgmt`); every `resource` equal to the management door; `state` at most
   1024 characters. A refusal goes **to the client, through the redirect**,
   with `error`, `error_description`, `state` and `iss`
   (`AuthorizationRedirectError`).
5. **The consent screen.** `createPending(user, request)` stores what is
   about to be shown — user, client, redirect URI, state, challenge — in the
   `SessionStore` under `oauth-consent:<id>` (32 random bytes, 10 minutes;
   rows of `web_sessions` keyed by a digest), and `consentPage` renders it.

Steps 2 and 3 come before step 4 on purpose: **nothing is sent to a redirect
URI, not even an error, before a user is signed in and the client is one that
may ask**. Registration is open to anyone who reaches the instance; were
errors redirected first, a client registered a minute ago with
`https://evil.example/` would turn a link on the instance's own host name
into a redirect there (RFC 9700 §4.11.2). Under the `open` policy a signed-in
user can still be bounced to the redirect URI of a self-registered client;
that is what `open` means.

The screen (`pages.ts`) is a self-contained document: no script, no external
resource, a per-response style nonce, `Cache-Control: no-store`,
`Content-Security-Policy: default-src 'none'; style-src 'nonce-…'; base-uri
'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy:
same-origin` (not `no-referrer`: a browser posts the form of a `no-referrer`
document with `Origin: null`, which the mutation guard refuses — the browser
test `delegate-agent.spec.ts` clicks the real button). Every client-supplied value goes through `escapeHtml`. It says
who asks ("an application that calls itself …", not verified), for whom, the
client id and how it registered, the scope `mgmt`, what the delegation can do
and can never do (spec §4.1 bis), and where the access goes with a warning per
kind. The form carries the consent id and nothing of the request; "Deny" is
the first button.

`POST /oauth/authorize/decision` (`handlers.decide` →
`AuthorizationService.decide`): `guardMutation(…, 'user')` (origin, session,
a user), then the pending consent is **taken** — deleted whether or not the
caller is the user it was shown to, so an attempt from another session spends
it. `deny` → redirect with `access_denied`. `approve` → the client must still
be `approved` and the redirect URI still registered, then:

```
delegations.create(user, client, scope 'mgmt')
audit  delegation-granted  (user_id = the user; after: client_id, client_name, scope, redirect_uri, resource)
createCode(digest, redirect_uri, code_challenge, S256, expires in 60 s)
         └─ if the entry cannot be written or the code cannot be minted: the delegation is revoked
            (no reason, no `delegation-revoked` entry: it never had a code), nothing is redirected
303 <redirect_uri>?code=…&state=…&iss=<issuer>
```

A failure there is not the host's raw 500: `handlers.decide` logs `consent
decision failed unexpectedly` at `error` and renders a page ("Nothing was
granted: start the connection again from your application"), as
`handlers.authorize` does for its own failures. The consent is spent either
way.

Consent is asked at every authorization. **One approval is one delegation —
one family of tokens.**

## Tokens (`token-service.ts`, `handlers.token`)

`POST /oauth/token`, `application/x-www-form-urlencoded`, at most 16 KiB, a
parameter repeated is `invalid_request` (`resource` excepted).

**Client authentication** (`clientCredentialsOf`, `authenticateClient`):
HTTP Basic or `client_id` / `client_secret` in the body, never both. A public
client is identified by its id (its proof is the PKCE verifier or the refresh
token); a confidential client must present its secret. Unknown client or wrong
secret → `401 invalid_client` (with `WWW-Authenticate: Basic` when Basic was
used); a client that is not `approved` → `unauthorized_client`. The
`token_endpoint_auth_method` a client registered is stored and returned, not
enforced: a confidential client may present its secret by either of the two
methods the server supports.

**Every grant is one transaction of the store.** What a client is told and
what the store holds cannot diverge:

| What happens                                     | Store                                                             | Answer                       |
| ------------------------------------------------ | ----------------------------------------------------------------- | ---------------------------- |
| the grant succeeds                               | code spent / token rotated **and** the new pair written, together | 200                          |
| a check refuses (wrong verifier, other client…)  | the code is **spent**, nothing else is written                    | `invalid_grant`              |
| a replay is detected                             | the family is revoked                                             | `invalid_grant`              |
| a **write fails** (a store fault, in the middle) | **rolled back whole**: as if the request never arrived            | `server_error` (500), logged |

The last row is the rule for failures. Rotating a refresh token and writing
the access token of the renewal used to be two writes, and a fault between
them left a rotated token whose successor nobody had received: the client's
retry then looked like a replay and — outside the reuse window, or with a
window of `0` — revoked a delegation nobody had attacked. Now the presented
refresh token is still the live head after a fault, the code is still
unspent, no token exists that was never sent, and the same request sent again
succeeds. This weakens nothing in replay detection: a rollback leaves no
second copy of anything (the new tokens never left the server), and a token
is marked rotated in exactly the transactions whose pair was written. A fault
is never answered `invalid_grant`, which tells a client to discard its
tokens and ask the user again.

**`authorization_code`** (`exchangeCode` → `DelegationsRepo.redeemCode`):

- the code is looked up by digest; unknown → `invalid_grant`;
- **already consumed → replay**: the delegation is revoked
  (`authorization-code-replay`), `invalid_grant`. A concurrent second exchange
  is told the same by the transaction and is treated as a replay; an expired
  code is plain `invalid_grant`;
- the code is spent, then judged, in the same transaction — a request that
  fails a check has no second try: the delegation's client must be the
  authenticated one; `redirect_uri`, when sent, must equal the one of the
  authorization request; `verifyS256(code_verifier, code_challenge)`; the
  user must still be active; the delegation must still be active;
- the first refresh token and access token are written with it.

**`refresh_token`** (`refresh`): the presented token is looked up by digest
whatever its state.

- **Already rotated (`replaced_by_id` set)** → `replayed()`:
  - **inside the reuse window** — the presented token is the one rotated
    last (its successor is still the live head of the family), it was rotated
    at most `oauth.refresh_reuse_window_seconds` ago (30 by default; the
    instant is the row's `revoked_at`), and the caller is the delegation's
    client — `DelegationsRepo.rotateSuccessorOf` rotates the head once more
    and writes the access token of the renewal, in one transaction, and the
    caller receives a new pair. The family stays
    one chain with one live head. Logged `delegated tokens issued` with
    `reuse_window: true`; no audit entry. This is what lets two sessions of
    one agent, sharing one stored refresh token, renew at the same moment.
  - **anything else → replay**, whoever presents it: an older generation,
    the same token a second time (the head moved on), outside the window,
    another client, a window of `0`. The delegation and every token under it
    are revoked (`refresh-token-replay`), `invalid_grant`. A dead token tried
    again later writes nothing more.
  - After a reuse, the token the _first_ renewal received is no longer the
    head: presenting it once the window has closed is a replay. Two sessions
    must read their shared store before renewing.
- Another client's token: `invalid_grant`, nothing revoked.
- `rotateRefreshToken` revokes the presented token, links it to its
  successor and writes the access token of the renewal in one transaction; a
  concurrent renewal that loses goes through `replayed()` too, hence through
  the window.
- **A renewal is counted against its delegation**
  (`oauth:token:delegation:<id>`, `RENEWALS_PER_DELEGATION` 120 per minute),
  once the refresh token is recognised as a live one of this client and
  before anything is written: `slow_down` (429, `Retry-After`) changes
  nothing, and the same token renews when the window has passed. The replay
  path takes no budget — nothing stands between a replay and the revocation
  it causes — and bounds itself: a rotated token is answered once.
- `scope`, when sent, may only be `mgmt`; `resource` must be the door.
- Access tokens issued before a rotation live out their 15 minutes.

**One function ends a delegation and leaves its trace**
(`endDelegation(deps, id, { reason, actorId, viaClient })` in
`delegations.ts`), for the three callers — the token service (a replay, the
client signing out), `DelegationService.revoke` (the user) and, through
`recordDelegationEnded`, `ClientRegistry.decide` (the operator, whose
revocations are part of the `disableClient` transaction). The store's
`revokeIfActive` answers only to the call that actually revoked, so a
revocation is audited once however many requests noticed it. The
`delegation-revoked` entry:

| Field                      | Value                                                                             |
| -------------------------- | --------------------------------------------------------------------------------- |
| `user_id`                  | who acted: the delegating user, or the operator                                   |
| `after.reason`             | `user`, `client`, `operator`, `refresh-token-replay`, `authorization-code-replay` |
| `after.client_id`, `_name` | the client that held the delegation                                               |
| `after.delegating_user_id` | the delegating user, **only when somebody else acted** (the operator)             |
| `delegated_client_id`      | the client, when the act came through it (sign-out, replay); else `null`          |

It is logged as `delegation revoked`, at `warn` for a replay and at `info`
otherwise (the client signed out, the user or an operator revoked).

**`POST /oauth/revoke`** (RFC 7009): the client authenticates like above; a
refresh token of that client ends its delegation (reason `client`, audited); an
access token is revoked alone (logged `access token revoked`, not audited);
anything else changes nothing. Always `200`.

**Sweep.** At most once an hour, an issuance deletes codes and tokens expired
for more than a day (`DelegationsRepo.purgeExpired`). A rotated refresh token
is kept as long as its successor lives, so its replay is still recognised.

### Error responses

JSON `{ error, error_description }`, `Cache-Control: no-store`. Codes used:
`invalid_request` (400; 405 with `Allow` for another method; 413 for a body
over 16 KiB), `invalid_client` (401), `invalid_grant`,
`unauthorized_client`, `unsupported_grant_type`, `invalid_scope`,
`invalid_target` (RFC 8707), `invalid_redirect_uri`, `invalid_client_metadata`,
`access_denied` (403, registration closed), `slow_down` (429 with
`Retry-After`), `server_error` (500). The authorization endpoint also sends
`unsupported_response_type`, through the redirect. A description never
contains a token, a code or a secret.

## Two families of endpoints (`handlers.ts`)

|                  | Protocol endpoints                                         | Human endpoints                                           |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Which            | metadata, `register`, `token`, `revoke`                    | `authorize`, `decide`, `revokeDelegation`, `decideClient` |
| Called by        | OAuth clients                                              | the user's browser                                        |
| Authenticated by | what the request carries (code, refresh token, client)     | the web session                                           |
| Cookie           | **never read**                                             | read                                                      |
| Origin           | any (`Access-Control-Allow-Origin: *`, preflight answered) | mutations through `guardMutation` (origin, session, role) |
| Rate limit       | per client address, through the `RateLimiter` port         | —                                                         |

Rate limits, all through the `RateLimiter` port:

| Key                           | Limit                                | Taken when                                                               |
| ----------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `oauth:token:ip:<ip>`         | `TOKEN_REQUESTS_PER_WINDOW` 60/min   | every `token` and `revoke` request, first                                |
| `oauth:token:client:<id>`     | `TOKEN_REQUESTS_PER_CLIENT` 120/min  | `token`, a **confidential** client, once its secret matched              |
| `oauth:token:delegation:<id>` | `RENEWALS_PER_DELEGATION` 120/min    | the refresh grant, once the refresh token is recognised as this client's |
| `oauth:register:ip:<ip>`      | `REGISTRATIONS_PER_WINDOW` 20/10 min | every registration                                                       |
| `oauth:register`              | `REGISTRATIONS_PER_INSTANCE` 300/h   | every registration, whatever the address                                 |

**A budget that belongs to a client or to a delegation is only spent by a
caller that proved it holds something of it.** A `client_id` is not a secret
— for a metadata-document client it is one URL shared by every user of the
instance — so naming a public client spends nothing but the caller's own
per-address window: its renewals are counted per delegation, in the grant,
after the refresh token was found to be one of this client's. A confidential
client proves itself with its secret and is then also counted per client. A
code exchange is counted per address only: a code is single use, so there is
nothing to repeat. Every limit answers `slow_down` (429) with `Retry-After`
and changes nothing.

The address is the trusted-proxy rule's
(`clientIpResolver`); with no `trusted_proxies` configured every caller shares
one window. `tests/unit/server/auth/mutation-guard.test.ts` classifies the
three mutating protocol endpoints apart (`PROTOCOL_ENDPOINTS`) and asserts
that an operator's cookie from a foreign origin changes nothing in their
answer.

## Admission to the door (`management-gate.ts`, `verifier.ts`)

`DelegatedTokenVerifier.resolve(bearer)` → `DelegationContext | null`
(`delegation_id`, `user_id`, public `client_id`, `scopes`, `expires_at`): the
token must have the access-token shape, a live row, an active delegation, an
**active user** and a **client that is `approved` as of now**
(`ClientRegistry.statusOf`, see
[Registration policy and operator decisions](#registration-policy-and-operator-decisions)).
It reads the store at every call: no cache. It is the only verification of a
delegated bearer: the door goes through `ManagementGate.admit`, which is the
path that checks the scope.

The same verifier is wired into the **execution** door as its
`DelegatedTokenResolver` (`compose/root.ts`), which is how `/mcp` refuses a
delegated token by kind rather than as an unknown bearer.

`ManagementGate.admit(request)` → `{ delegation, client } | Response`:

| Presented                                                                      | Answer                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| a browser `Origin` other than the instance                                     | 403                                                                                           |
| nothing                                                                        | 401, `WWW-Authenticate: Bearer realm, resource_metadata, scope` (no `error`: RFC 6750 §3.1)   |
| a live delegated access token                                                  | admitted                                                                                      |
| a live delegated access token whose scopes lack `mgmt`                         | 401 with the challenge and `error="invalid_token"`                                            |
| a delegated access token of a client that is not approved as of now            | 401 with the challenge and `error="invalid_token"`                                            |
| a mission token (identified by the execution door's throttled `TokenVerifier`) | 403 `wrong-credential-kind` (`presented: mission-token`), no challenge                        |
| a mission-token-shaped bearer while its identification is throttled            | 429, JSON-RPC `-32002`, `Retry-After` (the execution door's throttle, per prefix and address) |
| a web session, as a cookie with no bearer or as the bearer                     | 403 `wrong-credential-kind` (`presented: human-session`), no challenge                        |
| anything else (unknown, expired, revoked, a refresh token, a look-alike)       | 401 with the challenge and `error="invalid_token"`                                            |

The refusal bodies are the execution door's (`refusalToRpcError`,
`rpcError`). A string that merely has the shape of a mission token is an
unknown bearer: a kind is only named for a credential that was identified.

The gate is built by the composition root (`createManagementGate`) and stays
`root.management.gate`; the door receives its `admit` as a function.

## The door's tools

Spec §4.1 bis, §7.10. `/mcp/manage` is an MCP server (Streamable HTTP,
stateless, both protocol eras like the execution door) named
`vaubaan-gateway-management`. Every request:

```
ManagementDoor.handle(request)                                   door.ts
  admit(request)                      → 401 challenge | 403 wrong-credential-kind | the delegation
  rateLimit.take(`delegation:<id>`, 120, 60 s)                    → 429, JSON-RPC -32002, Retry-After
  one McpServer for the request, instructions = MANAGEMENT_INSTRUCTIONS
    registerTool × MANAGEMENT_TOOLS (input schema, output schema, annotations), bound to the actor
      { userId: delegation.user_id, delegationId, clientId: delegation.client_id }
  tools/call → definition.run(tools, actor, args) → toolResultOf(outcome)
```

The actor is rebuilt from the token at every request; nothing is kept
between two requests.

### The seven tools (`definitions.ts`, `tools.ts`)

| Tool                   | Kind     | `ManagementTools` method | Reads / writes through                                                                 |
| ---------------------- | -------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `list_my_connections`  | read     | `listMyConnections`      | `missions.issuanceContext(user)`                                                       |
| `get_catalog`          | read     | `getCatalog`             | `catalog.get(provider)`, `issuanceContext` for `connection_id`                         |
| `list_my_missions`     | read     | `listMyMissions`         | `missions.list(user)`, or `missions.get` with `mission_id`                             |
| `preview_policy`       | preview  | `previewPolicy`          | `missions.preview(user, draft)`                                                        |
| `issue_mission`        | mutation | `issueMission`           | `missions.preview`, then `missions.issue(user, draft, { delegation })`                 |
| `rotate_mission_token` | mutation | `rotateMissionToken`     | `missions.get`, the delegation check, then `missions.rotate(user, id, { delegation })` |
| `revoke_mission`       | mutation | `revokeMission`          | `missions.get`, then `missions.revoke(user, id, { delegation })`                       |

`user` is always `{ id: actor.userId }`: every act is the delegating user's,
checked against their **current** authority by the mission service — owner,
or the union of their direct and group shares (handbook
[authority](authority.md)). The door decides nothing about authority itself.

**Rotation reaches only what the delegation issued** (ADR
[management-door-rotation-scope-and-replay-trace](../decisions/management-door-rotation-scope-and-replay-trace.md)).
`rotate_mission_token` answers with the new token, so rotating a mission is
obtaining its token. A mission the user issued in the interface, or that
another client or an earlier delegation of the same client issued, is refused
`mission-not-issued-here` before anything is read of its state and before the
mutation budget is touched: `mission.delegationId` must equal the delegation
of the call. The same rule is held a second time by
`MissionService.rotate` itself (`not-issued-by-delegation` whenever a
`delegation` option names another delegation than the mission's), so the door
cannot reach a wider rotation through its one `rotate` port. `revoke_mission`
keeps reaching every mission of the user: ending a mission enlarges nothing.
The human rotates any of their missions on the mission's page.

**Inputs** are Zod schemas, advertised as JSON Schema by `tools/list` and
validated by the SDK before the method runs; unknown keys are refused
(`.strict()`). `preview_policy` and `issue_mission` take a mission draft —
`missionDraftSchema` of `missions/draft-schema.ts`, the very schema the
creation form parses, with the descriptions an agent reads.

**Answers** (`toolResultOf`) are `structuredContent`, repeated as JSON text
for clients that only read text, in the shape the tool's `outputSchema`
advertises (next section). A "no" is a tool error — `isError: true`
with `structuredContent: { error: { code, message, hint, … } }` — so the
model reads it and corrects itself:

| `error.code`              | When                                                                                  | Extra fields                     |
| ------------------------- | ------------------------------------------------------------------------------------- | -------------------------------- |
| `draft-refused`           | `issue_mission` on a draft the preview does not accept                                | `uncovered`, `issues`, `preview` |
| `mission-not-found`       | no such mission of this user (another user's reads the same)                          | `mission_id`                     |
| `mission-inactive`        | `rotate_mission_token` on a revoked, expired or orphaned mission                      | `mission_id`, `state`, `orphan`  |
| `mission-not-issued-here` | `rotate_mission_token` on a mission of the user that this delegation did not issue    | `mission_id`                     |
| `unknown-provider`        | `get_catalog` on a provider the instance does not ship                                | `providers`                      |
| `unknown-connection`      | `get_catalog` with a `connection_id` the user holds nothing on                        | `connection_id`                  |
| `rate-limited`            | the delegation's mutation budget is spent                                             | `retry_after_seconds`            |
| `internal-error`          | the method threw (logged `management tool failed`); the message never carries details |                                  |

A call that fails the input schema is a tool error whose text is the SDK's
validation message; a tool name that does not exist is the JSON-RPC error
`Tool <name> not found`. `MANAGEMENT_REFUSAL_CODES` is the list of the first
six codes; `tools.test.ts` holds it to this table, both ways.

### Output schemas (`output-schemas.ts`)

Each of the seven tools advertises an `outputSchema` in `tools/list`: the
JSON Schema of `MANAGEMENT_OUTPUT_SCHEMAS[<tool>]`, the shape of its
`structuredContent` when it answers "yes". A refusal is not described: the
SDK validates the answer of a successful call only (`isError` skips it), and
so does a client, so `{ error }` travels as before.

**The schema is checked after the tool ran.** `@modelcontextprotocol/server`
2.3.1 validates `structuredContent` against the advertised schema once the
handler returned, and answers a bare `Output validation error …` tool error
when it does not match. For `issue_mission` and `rotate_mission_token` that
would lose a token shown once, _after_ the mission was written or the
previous token revoked. Three things keep that from happening:

- **Every object is loose** (`z.looseObject`, JSON Schema
  `additionalProperties: {}`), at every level. A key the schema does not name
  never fails an answer, on the server or in a client that validates: a field
  added to a view is not a regression of the door.
  `output-schemas.test.ts` walks each schema and refuses a level that is not.
- **Thin where the shape is not the door's.** What the mission service or a
  catalog owns — policy lines, preview issues and notices, the summary,
  presets, the bootstrap kit — names the keys an agent reads and leaves the
  rest open; a value whose set is owned elsewhere (a state, a gate, a level,
  an orphan cause, `basis`) is a string, with the set in its description.
- **Every real answer is parsed in a test.**
  `tests/integration/management/output-schemas.test.ts` drives each success
  path of each tool through the real door with the official MCP client (which
  validates against the advertised JSON Schema once it listed the tools) and
  parses the answer with the Zod schema: an owner, a beneficiary and somebody
  who holds nothing; every provider's catalog; previews that pass, exceed,
  skip, cannot resolve an environment or name an unknown risk; issuance from
  a policy and from a preset; the list and the detail of active, orphaned,
  revoked and expired missions; rotation; revocation, twice. It also holds
  that each top-level key of an answer is named by its schema, and that every
  tool was covered.

If an answer nevertheless departs from its schema, the door logs `management
tool answer does not match its advertised schema` at `error`, with the tool,
the delegation and the paths and codes of the mismatches — never a value —
before the SDK replaces the answer (`ManagementDoor.checkAnswer`;
`door.test.ts` shows the whole sequence on a tool that reveals nothing).

A new field in an answer needs nothing here to keep working. Add it to the
schema when an agent should be able to rely on it. The TypeScript interfaces
of `views.ts` and `tools.ts` remain the full contract.

What each answer contains (`views.ts`):

- **`list_my_connections`** — per connection the user owns or was shared:
  its `status`; `authority.basis` (`owner` | `share`) and `authority.risk_ids`, **the exact
  restriction** (`IssuanceConnection.authority`: the whole catalog for an
  owner — `authority.whole_catalog` — the union of the shares otherwise); `resources` (ref, display name,
  `env` label, `hidden`; stale ones are left out); `env_qualified_risks` —
  `derives_env`, `labelled_envs`, `unlabelled_resources`, and the
  env-qualified ids of the authority split into `usable_risk_ids` and
  `unusable_risk_ids` (no resource carries their environment: a draft naming
  one is refused `unresolvable-env`); `presets` with `within_authority` and
  `outside_authority` — about authority only: an entry naming an env-scoped
  risk is covered when the user holds it in at least one environment, and
  what a given selection of resources leaves out of a preset is the preview's
  `skipped_from_preset`. Connections of experimental plugins are left out
  unless `include_experimental` (`hidden_experimental` counts them).
- **`get_catalog`** — `risks` as explicit ids, one per environment for an
  env-scoped entry (`enumerateCatalog`), with label, reason, level,
  `fallback`, `deprecated`, `rate_ceiling_per_minute`; `presets` entry by
  entry. With `connection_id`, each risk carries `in_my_authority`.
- **`list_my_missions`** — `state` (`active`, `expired`, `orphaned`,
  `revoked`) and `orphan` (`cause`, `connection_id`, `uncovered`,
  `can_come_back`) exactly as `MissionService.list` derives them at this
  read; `policy` with `remaining` per risk; `session` (current period);
  `exhausted`; `issued_via` (`client_id`, `client_name`, `this_client`,
  `this_delegation` — true for the missions `rotate_mission_token` accepts);
  the masked `token_prefix`. Revoked and expired missions are left out
  unless `include_closed` (`hidden_closed` counts them). With `mission_id`: plus `connections` with the
  resources reached and `policy_details` (label, `gate_open_until`).
- **`preview_policy`** — the mission preview: `ok`, `issues`, `notices`,
  `uncovered` (per connection, the accepted risks outside the authority),
  `policy`, `connections`, `summary`. A draft that does not pass is an
  answer, not an error.
- **`issue_mission`** — `mission` (`mission_id`, `creator_user_id`,
  `issued_via_client_id`), `token` (`secret`, `prefix`, `env_var`,
  `shown_once`), `bootstrap_kit` (`endpoint`, `env`, `mcp_json`,
  `agent_instructions`, `verify`), `policy`, `summary`, `notices`.
- **`rotate_mission_token`** — the new `token` and `bootstrap_kit`, for a
  mission this delegation issued.
- **`revoke_mission`** — `state: revoked`, `tokens_revoked`,
  `already_revoked` (a second call changes nothing and writes nothing).

The mission token appears in the answer of `issue_mission` and
`rotate_mission_token` and nowhere else: the door logs the tool name, the
outcome code and the ids of user, delegation and client — never arguments or
answers.

**The views restate no mission rule.** Three answers depend on a rule the
mission module owns, and each calls it instead of writing it again, so the
agent's tools and the web pages cannot disagree:

| Answer                                      | Rule, in `server/missions`                                                |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `orphan.can_come_back`                      | `explainOrphan(orphan, []).reversible` (`orphan-reason.ts`)               |
| `env_qualified_risks.usable_risk_ids` / un… | `isResolvable(risk, connection, resources)` (`catalog-view.ts`)           |
| `presets[].outside_authority`               | `expandPreset` (`preview.ts`) over the part of the catalog the user holds |

For the third, the preset is expanded against the risks the user holds, with
the environment taken as derivable: an entry that expands to nothing held
comes back as itself and is outside. What `preview_policy` then reports for
a real selection of resources is the same function on the whole catalog.

### `issued_via`: the mission, the audit, the interface

`MissionService.issue/rotate/revoke` take `{ delegation: { id, clientId } }`
(`IssueOptions`):

- the mission row keeps the delegation (`missions.delegation_id`, a column of
  migration `0001`); **the creator is the user** (`creator_user_id`);
- the `mission-issued`, `mission-rotated` and `mission-revoked` entries carry
  `user_id` = the user and `delegated_client_id` = the client's public id
  (spec §8); the Audit page prints "through client …";
- `MissionOverview.issuedVia` (`delegation_id`, `client_id`, `client_name`)
  is read at every listing by `MissionsRepo.issuersOf` — a join from the
  mission to its delegation to its client. Nothing is copied onto the
  mission: there is one place that says which client a delegation belongs to.

`/missions` shows "delegated — issued by <client name>" under the name,
`/missions/<id>` an "Issued by" row linking to the delegation, and each card
of `/delegations` the missions issued under it.

### Rate limits

Through the `RateLimiter` port, on keys the root prefixes with `mgmt:`
(`managementRateLimitOf`), per delegation:

| Key                              | Limit                                    | Refusal                                    |
| -------------------------------- | ---------------------------------------- | ------------------------------------------ |
| `mgmt:delegation:<id>`           | `MANAGEMENT_REQUESTS_PER_WINDOW` 120/min | HTTP 429, JSON-RPC `-32002`, `Retry-After` |
| `mgmt:delegation:<id>:mutations` | `MANAGEMENT_MUTATIONS_PER_WINDOW` 60/h   | tool error `rate-limited`                  |

The mutation budget is taken after the checks that need no write: a draft the
preview refuses, a mission that is not found or not active, a mission
already revoked do not spend it.

### The hard deny is the dependency list (`ports.ts`, `compose/management.ts`)

`ManagementModuleDeps` is everything the module receives:

| Port              | What it is                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `admit`           | `(request) => gate.admit(request)`                                                                        |
| `missions`        | `ManagementMissions` = `Pick<MissionService, issuanceContext, preview, issue, rotate, revoke, list, get>` |
| `catalog`         | `ManagementCatalog`: per provider, label, flags, `enumerateCatalog` rows and presets, as frozen data      |
| `rateLimit`       | `take` on prefixed keys                                                                                   |
| `build`, `logger` |                                                                                                           |

`wireManagementDoor` builds each port as a frozen object of closures
(`managementMissionsOf`, `managementCatalogOf`, `managementRateLimitOf`). The
door therefore holds no `MissionService` (which has `setGate`), no request,
budget, connection, share, group or execution service, no repository, no
plugin, and no limiter shared with the budget's windows. There is no method
to call, by mistake or by a crafted request, that answers a request, opens a
gate, extends a budget, touches a connection, a share or a group, or
executes a tool.

Held by four tests: the types (`Extract<Handed, Forbidden>` is `never`;
`tsc`), the imports of every file of the module, the tool table, and a walk
of the object graph of `root.management.door` on the real root, which meets
none of the root's modules, services or repositories
(`management/hard-deny.test.ts`, `tests/integration/management/hard-deny.test.ts`).

### Bootstrap text

`MANAGEMENT_INSTRUCTIONS` (the MCP `instructions` of the server) gives the
order of the calls and the rules of a policy. The bootstrap kit's instruction
block ends with "The management door" (`managementDoorSection`,
`missions/bootstrap-kit.ts`), and `/agent-bootstrap.md` has §7 with the tools
and how to compose a policy that passes.

## The three credentials, tested

`tests/integration/oauth-as/credential-separation.test.ts` holds one instance
with a real mission token, a real delegated token and a real web session:

- a delegated token at `/mcp` → 403 `wrong-credential-kind`
  (`presented: delegated-token`, the hint names the management door);
- a mission token at `/mcp/manage` → 403 `wrong-credential-kind`
  (`presented: mission-token`, the hint names the execution door);
- a session at `/mcp/manage`, as cookie or bearer → 403;
- a delegated token as a bearer or in the `vbn_session` cookie is nobody for
  the interface (`Authenticator.authenticate` → `null`; issuing or revoking a
  mission, revoking a delegation, answering a consent → 401);
- a delegated token cannot answer a request, even next to the creator's
  cookie (`requests.handlers.decide` → 403 `wrong-credential-kind`), nor open
  `/r/<id>` or the inbox.

## Store (`store/repositories/delegations.ts`, migration `0006`)

Tables of `0001`: `oauth_clients`, `oauth_client_redirect_uris`,
`delegations`, `oauth_codes`, `oauth_refresh_tokens`, `oauth_access_tokens`.
Migration `0006` adds `oauth_clients.registration`,
`token_endpoint_auth_method`, `client_uri`, `metadata_expires_at`,
`operator_decision`, `decided_at`, `decided_by`, `delegations.revoke_reason`
and the index `delegations_client`.

Methods P2.3 added: `listClients`, `updateClientDocument`, `decideClient`,
`deleteUnusedClients`, `listForClient`, `revoke(id, reason)`,
`revokeIfActive(id, reason)` (the delegation when this call revoked it, else
`null` — what makes an audit entry written once), `activityOf(ids)` (last
token, latest live expiry), `findCode` and `findRefreshToken` (the row
whatever its state, with its delegation — what a replay is recognised with),
`purgeExpired`. P2.4 added `rotateSuccessorOf(previousHash, rotatedSince,
next)` — the reuse window: the live successor of a token rotated at or after
`rotatedSince` is rotated in turn, in one transaction; `null` otherwise.

The Phase 2 cycle-end pass made every grant and the operator's `disable` one
transaction:

- `redeemCode(codeHash, check, { refresh, access })` — spends the code, runs
  `check(spentCode, delegation)` (synchronous, pure: it returns the reason of
  a refusal or `null`), and writes the first pair. Outcomes: `issued`,
  `refused` (the code **is** spent; `reason` is the check's, or
  `delegation-revoked`), `replayed`, `expired`, `unknown`. A failed insert
  rolls back the consumption too and throws.
- `rotateRefreshToken(hash, next, access?)` and `rotateSuccessorOf(previous,
since, next, access?)` — with `access`, the access token of the renewal is
  written in the transaction of the rotation.
- `disableClient(id, decidedBy)` → `{ client, revoked }` — the decision and
  the revocation (reason `operator`) of every active delegation of the
  client, with their tokens.
- `createCode` and `createAccessToken` check that the delegation is active
  and insert in one transaction (on a synchronous driver the two statements
  could not interleave; on another they could).
- No method spends a code or writes a refresh token on its own: a code is
  spent and the first refresh token written by `redeemCode` only, a later one
  by a rotation.
- No method revokes one refresh token alone: a rotation replaces it, a
  revocation ends the family.

`DELEGATION_REVOKE_REASONS`: `user`, `client`, `operator`,
`refresh-token-replay`, `authorization-code-replay`.

The audit search scope (`store/repositories/audit.ts`) shows a user the
administrative entries whose object is one of **their** delegations.

## Pages

- **`/delegations`** (`APP_NAV` "Delegations"; `DelegationService.listFor`; the
  status shown for each mission is the derived one — the composition root hands
  the service `derivedMissionReads(store.missions, authority.grounds)`, so an
  orphaned mission reads `orphaned` here as on its own page, [authority](authority.md)):
  one card per delegation, most recent first — the client's name (as a
  claim), its client id, where its access goes, the scope, when it was
  granted and last renewed, its state, the missions it issued (with their
  derived status) and a **Revoke** button (`POST /delegations/<id>/revoke`, one click).
  States: `active` (a token is live), `idle` (the consent stands but no token
  is left: never redeemed, or unused past the refresh lifetime), `revoked`
  with the reason in words. Another user's delegation id answers
  `?problem=not-found`.
- **`/admin/oauth-clients`** (operator): every client with its status, who
  decided (an operator or the policy), its redirect URIs, how it registered;
  **Approve** and **Disable and revoke its delegations**
  (`POST /admin/oauth-clients/<id>`, `action=approve|disable`). The policy in
  force is stated at the top.

## Configuration

| YAML path                                         | Default             | Rule                                                         |
| ------------------------------------------------- | ------------------- | ------------------------------------------------------------ |
| `oauth.access_token_ttl`                          | `15m`               | duration, at most `1h`                                       |
| `oauth.refresh_token_ttl`                         | `30d`               | duration, longer than the access token's                     |
| `oauth.refresh_reuse_window_seconds`              | `30`                | integer 0 to 60; 0: every replay revokes                     |
| `oauth.client_registration.policy`                | `operator-approved` | `open`, `operator-approved`, `closed`                        |
| `oauth.client_registration.auto_approve_loopback` | `true`              | under `operator-approved` only                               |
| `oauth.client_registration.metadata_documents`    | `false`             | when true the instance fetches documents over outbound https |

Environment names in [configuration](configuration.md).

## How to use it

Connect an MCP client (Claude Code):

```bash
claude mcp add --transport http vaubaan-manage <public_url>/mcp/manage
# then, inside Claude Code: /mcp → vaubaan-manage → Authenticate
```

The browser opens on the instance: sign in, read the consent screen, click
Authorize. The Delegations page then lists the client.

By hand, with `curl` (a public client and a loopback redirect):

```bash
BASE=<public_url>
CLIENT=$(curl -s -X POST "$BASE/oauth/register" -H 'Content-Type: application/json' \
  -d '{"client_name":"curl","redirect_uris":["http://127.0.0.1:8976/cb"],"token_endpoint_auth_method":"none"}' \
  | jq -r .client_id)
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | basenc --base64url | tr -d '=')
echo "$BASE/oauth/authorize?response_type=code&client_id=$CLIENT&redirect_uri=http%3A%2F%2F127.0.0.1%3A8976%2Fcb&code_challenge=$CHALLENGE&code_challenge_method=S256&scope=mgmt&state=x"
# open that URL, consent, copy the `code` of the address the browser lands on, within 60 s:
curl -s -X POST "$BASE/oauth/token" -d grant_type=authorization_code -d client_id="$CLIENT" \
  -d code="<code>" -d code_verifier="$VERIFIER"
```

## How to debug

- **The client never opens the browser.** `curl -i -X POST <public_url>/mcp/manage`
  must answer `401` with `WWW-Authenticate: Bearer … resource_metadata="…"`,
  and that URL must answer JSON. Behind a proxy that strips `WWW-Authenticate`
  the client falls back to `/.well-known/oauth-protected-resource/mcp/manage`.
- **"Unknown application" page.** The `client_id` is not registered here (a
  client id from another instance, or one swept after 30 days unused): make
  the client forget its registration and connect again.
- **"Invalid authorization request" page.** The `redirect_uri` is not one the
  client registered. Compare with `SELECT uri FROM oauth_client_redirect_uris`.
- **"Waiting for an operator".** The client's redirect URIs are not all on
  the loopback interface, or `auto_approve_loopback` is false: approve it
  under Administration → OAuth clients.
- **`invalid_grant` at the first exchange.** The code is 60 seconds old, was
  already used, or the verifier does not match. The log line `oauth request
refused` carries the error code and the client id; the description in the
  response says which check failed.
- **A delegation revoked "by the gateway".** A refresh token (or a code) was
  presented twice outside the reuse window: two processes share the client's
  token store and one of them kept renewing with a token the other had
  replaced, or the token leaked. `delegated tokens issued` lines with
  `reuse_window: true` just before tell the first case. The audit entry `delegation-revoked` carries the reason; the log
  has `delegation revoked` at `warn`.
- **`server_error` (500) at the token endpoint.** A write failed and the grant
  was rolled back: the log has `oauth request failed unexpectedly` with the
  error. Nothing was spent — the client sends the same request again.
- **`slow_down` (429) at the token endpoint.** `Retry-After` says when. The
  per-address window is shared by every caller when no `trusted_proxies` is
  configured; a renewal loop of one client shows as `oauth request refused`
  lines with `error: slow_down` and one `client_id`.
- **An agent is refused 401 at the door with a token that has not expired.**
  Its client is no longer `approved`: the policy was tightened, an operator
  disabled it, or its metadata document added a non-loopback redirect URI.
  Administration → OAuth clients shows the status and who decided.
- **`wrong-credential-kind` at `/mcp/manage`.** The agent is configured with
  its mission token on the management URL; the hint names the right door.
- **A tool answers `draft-refused`.** `error.uncovered` lists, per
  connection, the risks outside the user's authority; `error.issues` every
  other reason (`unknown-risk`, `missing-budget`, `unresolvable-env`,
  `duplicate-provider`…). The same draft pasted in Missions → New mission →
  "Paste an agent's proposal" shows the same preview to the user.
- **A connection is missing from `list_my_connections`.** The user holds no
  authority on it (not an owner, no active share), it is revoked, or its
  plugin is experimental (`include_experimental`).
- **`mission-inactive` on a rotation.** `error.state` says which; for
  `orphaned`, `error.orphan` gives the cause and the uncovered risks.
- **A tool answers `Output validation error …`.** The answer departed from the
  schema the tool advertises, and the SDK replaced it — after the tool ran:
  for a mutation, read the state again (`list_my_missions`) before retrying.
  The log line `management tool answer does not match its advertised schema`
  names the tool and the fields. It is a defect of `output-schemas.ts`: the
  integration test should have caught it.
- **Which client issued a mission.** `SELECT m.name, c.client_id, c.name FROM
missions m JOIN delegations d ON d.id = m.delegation_id JOIN oauth_clients c
ON c.id = d.client_id`, or the `mission-issued` audit entry
  (`delegated_client_id`).
- Log component: `oauth-as`, and `management-door` for the gate and the
  tools (`tools/call` with `tool`, `kind`, `outcome`, `user_id`,
  `delegation_id`, `client_id`; `management act` for each mutation).

## Extension

- A new tool: a method on `ManagementTools`, an entry in `MANAGEMENT_TOOLS`,
  its name in `MANAGEMENT_TOOL_NAMES` and its schema in
  `MANAGEMENT_OUTPUT_SCHEMAS` (the table does not compile without one), with
  its success paths in `tests/integration/management/output-schemas.test.ts`
  (the last test of the file fails for a tool it never saw answer). If it needs something the ports do
  not give, the port's type changes first (`ports.ts`), then
  `compose/management.ts` — and `hard-deny.test.ts` must still pass. A
  mutation is classified in `tests/integration/audit/admin-mutations.test.ts`.
- A second scope or resource: `endpoints.ts` is the one file that assumes one
  of each — `MANAGEMENT_SCOPE` with `asksForManagement`,
  `staysWithinManagement`, `carriesManagementScope`, and
  `isManagementResource` with `foreignResource`; the delegation row already
  stores its scope string.
- A hosted deployment: tokens and consents are rows and `SessionStore`
  records already; `AuthorizationService.taking` (the set that makes
  `takePending` atomic) and `TokenService.lastPurgeAt` are marked
  `// single-process only`. `redeemCode` takes a synchronous `check` because
  the SQLite driver's transactions are synchronous; on Postgres the same
  signature runs inside a transaction with `SELECT … FOR UPDATE` on the code.
- `private_key_jwt` for metadata-document clients (the draft allows it) would
  go in `authenticateClient` and `parseClientDocument`.

## Tests

Unit, beside the code (`src/server/oauth-as/*.test.ts`): PKCE (the RFC 7636
vector, wrong and malformed verifiers, the challenge as its own verifier);
secrets (shapes, prefixes, never a mission token, digests); redirect URIs
(what registers, exact match and every near miss, the loopback port
exception and its limits); metadata documents (URL rules, the address filter
table, the lookup that fails on one private address, the document's rules,
cache lifetimes, name cleaning); the discovery documents, the execution
door's one, and the scope and resource rules by name; the consent screen
(content, escaping of hostile values, headers, nonce, Deny first); the client
registry (registration and its refusals, the three policies, policy evaluated
at every use, operator decisions and their audit, disabling revokes
delegations, **disabling interrupted by a store fault changes nothing**,
documents: cache, refetch, fail closed, rate limit); the
authorization service (page errors versus redirect errors, the consent:
single use, user-bound, expiry, concurrent answers, disabled client, audit
failure, **a code that cannot be minted revokes the delegation**); the token
service (code exchange, PKCE, **code single-use and
replay**, client binding, **refresh rotation**, **replay revokes the family
and is audited once**, **the reuse window**: the token rotated last inside the
window, its last second and the instant after, an older generation, a second
reuse, another client, a revoked delegation, a window of 0, simultaneous
renewals; **a grant is one transaction** — an insert that fails during a code
exchange, a renewal or a reuse-window renewal leaves the code unspent or the
presented token the live head, and the same request then succeeds, with a
window of 0 too; **renewals counted per delegation**, never spent by an
unknown or a foreign token, never in the way of a replay; scope and resource,
expiry, revocation, client authentication with form-encoded Basic
credentials, sweep); the delegation service and the
verifier (**revoke cascades**, another user's delegation, states, **the
client's status at every verification**: a tightened policy, an operator's
approval, a client marked disabled, redirect URIs that left the loopback;
`endDelegation`: the entry of each kind of actor, once).

The faults are real ones: a SQLite trigger that aborts the insert or the
update (`RAISE(ABORT, …)`) on the `:memory:` store, so what is asserted is
the rollback the driver performs, not a stub's.

The door's tools, beside the code (`src/server/management/`):
`tools.test.ts` — every act carries the delegating user and, for mutations,
the delegation; refusal before issuance with the uncovered list; **the
mission service decides last** (an issuance refused after the preview passed,
an unknown outcome, a rotation answered not-found or inactive after `get` saw
the mission active); the mutation budget; every refusal code against the
handbook's table; the views (exact restriction, env usability, presets
against the authority, masked token) **and that each is the mission module's
rule** (`expandPreset`, `isResolvable`, `explainOrphan` for every cause); the
descriptions state the rules of issuance; the schemas refuse unknown keys.
`door.test.ts` — a method that throws is `internal-error` and logged without
its cause reaching the agent; `GET` and `DELETE` of a stateless client are
405; an answer that departs from its schema is replaced by the SDK and
traced without a value; a matching answer passes with its extra keys.
`output-schemas.test.ts` — one schema per tool, an object at the root, loose
at every level; a refusal matches none. `hard-deny.test.ts` — types, imports,
tool table.

Integration (`tests/integration/management/`, the real root, the simulated
IdP, the official MCP client with a token obtained through the real flow):
`management-door.test.ts` — the seven tools listed; an owner's and a
beneficiary's authority; catalog; preview within and beyond; **issue within
the authority → creator, `issued_via`, token once, kit, audit naming user and
client, the token on `/mcp`**; **refusal beyond with the uncovered list**; a
share narrowed after consent; rotate, revoke, an orphaned mission (not
rotated, restored with the share, revocable), another user's mission; the
forbidden families neither listed nor callable; `wrong-credential-kind` for a
mission token and a session; both rate limits. `output-schemas.test.ts` —
every real answer of every tool against its advertised schema, and refusals
unaffected (see [Output schemas](#output-schemas-output-schemasts)).
`hard-deny.test.ts` — the object graph.

Integration (`tests/integration/oauth-as/`, the real root on the `:memory:`
store with the simulated IdP): `mcp-client-flow.test.ts` — the official
`@modelcontextprotocol/client` discovers, registers, is sent to consent, is
admitted, renews by itself, is sent back to the user after a revocation, and
is told `access_denied`; `credential-separation.test.ts` — the three
credentials at every surface that is not theirs; `http-surface.test.ts` —
each endpoint's answers, headers, limits, the policies over HTTP, the
operator's approval and disabling, metadata documents fetched only for a
signed-in user, no secret in the logs, the three discovery documents, the
per-instance registration limit, the per-client limit of a confidential
client (never spent by a wrong secret), a public client's renewals never
held back by callers that only know its id, the door re-reading the client's
status, a consent whose delegation cannot be recorded; `routes.test.ts` — the
table against the route files. `tests/integration/store/oauth-clients.test.ts`
— what migration `0006` added to the repository, and the audit scope.
`tests/integration/store/delegations.test.ts` — the repository, with
`redeemCode`, the rotations that carry an access token and `disableClient`
each proven atomic under a fault.

Structural: `tests/unit/server/auth/mutation-guard.test.ts` (the three human
mutations through the one guard, the three protocol endpoints session-blind),
`tests/unit/app/app-guard.test.ts` and `admin-guard.test.ts` (the two pages
and their routes), `tests/integration/audit/admin-mutations.test.ts` (every
public method of the module's classes classified; the mutations leave their
entry).

Browser (`tests/e2e/v5/delegate-agent.spec.ts`): consent in a real browser,
then the agent reads the authority, previews, issues, uses the mission token
on `/mcp`; the user sees the mission marked delegated on Missions, the
mission page and the Delegations card, revokes the delegation, keeps the
mission. A second test: the navigation shows Delegations, and an empty page
says how to authorize an agent.

Not automated: a run with Claude Code itself against a deployed instance —
see "How to use it".

## References

- Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §4.1 bis, §4.2, §6, §8, §10.
- ADR: [management-door-authorization-server](../decisions/management-door-authorization-server.md).
- MCP authorization specification, revision 2026-07-28; OAuth 2.1 (draft);
  RFC 7591, 7636, 7009, 8252, 8414, 8707, 9207, 9700, 9728; OAuth Client ID
  Metadata Document (draft).
