---
title: Management door — authorization server, delegated tokens, admission
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/oauth-as/
  - apps/gateway/src/server/store/repositories/delegations.ts
  - apps/gateway/migrations/0006_oauth_client_decisions.sql
  - apps/gateway/src/app/oauth/
  - apps/gateway/src/app/.well-known/oauth-authorization-server/route.ts
  - apps/gateway/src/app/.well-known/oauth-protected-resource/mcp/manage/route.ts
  - apps/gateway/src/app/mcp/manage/route.ts
  - apps/gateway/src/app/(app)/delegations/
  - apps/gateway/src/app/admin/(guarded)/oauth-clients/
  - apps/gateway/tests/integration/oauth-as/
  - apps/gateway/tests/integration/store/oauth-clients.test.ts
---

# Management door — authorization server, delegated tokens, admission

How an agent comes to act **on behalf of a user** (spec §0 "Delegation",
§4.1 bis, §6 "separation of the three credentials", "short, traceable
delegated tokens"): the instance is an OAuth authorization server for one
resource, the management MCP door `/mcp/manage`. ADR
[management-door-authorization-server](../decisions/management-door-authorization-server.md).
Built on [authentication](authentication.md) (the human session, the mutation
guard), the [store](store.md) (`store.delegations`), the
[configuration](configuration.md) (`oauth.*`, the `SessionStore` and
`RateLimiter` ports) and the [audit](audit.md).

**This page covers the authorization-server half** (feature P2.3): discovery,
clients, consent, tokens, revocation, the admission gate of the door, the
Delegations page. **The door's tools** — reading connections and missions,
previewing, issuing, rotating, revoking — are feature P2.4; until then the
door behind the gate is a placeholder that lists no tool
(`placeholder-door.ts`).

## Layout

```
apps/gateway/src/server/oauth-as/        host-agnostic, never imports `next`
  index.ts                    createOAuthAsModule() → root.oauth; createManagementDoorModule() → root.management
  endpoints.ts                paths, the scope `mgmt`, issuer and resource URLs, RFC 8414 / RFC 9728 documents
  secrets.ts                  mint (256-bit, prefixed), SHA-256 digest, shape checks, constant-time match
  pkce.ts                     S256 only: challenge / verifier syntax, constant-time verification
  redirect-uri.ts             what may be registered (loopback, https, app scheme), exact match + loopback port
  client-metadata-document.ts client ids that are https URLs: URL rules, public-address-only fetch, document validation
  clients.ts                  ClientRegistry: dynamic registration, document clients, registration policy, operator decisions
  authorization.ts            AuthorizationService: client + redirect URI, request validation, pending consent, the answer
  token-service.ts            TokenService: client authentication, code grant, refresh rotation, replay, revocation, sweep
  delegations.ts              DelegationService: a user's delegations with client and missions; revoke
  verifier.ts                 DelegatedTokenVerifier: resolve(bearer) / verifyAccessToken(token)
  management-gate.ts          ManagementGate.admit(request): the resource-server check of /mcp/manage
  placeholder-door.ts         the MCP server with no tool behind the gate (replaced by P2.4)
  pages.ts                    the consent screen and the message pages, as self-contained HTML
  handlers.ts                 Request → Response handlers of the nine endpoints
  errors.ts                   OAuthProtocolError, AuthorizationPageError, AuthorizationRedirectError
  testing.ts                  openOAuthRig(): the services on the :memory: store (tests only)
apps/gateway/src/app/
  .well-known/oauth-authorization-server/route.ts          GET   RFC 8414
  .well-known/oauth-protected-resource/mcp/manage/route.ts GET   RFC 9728 (the path-less one is the execution door's)
  oauth/register/route.ts            POST  dynamic client registration
  oauth/authorize/route.ts           GET   authorization request → sign-in → consent screen
  oauth/authorize/decision/route.ts  POST  the user's answer
  oauth/token/route.ts               POST  code and refresh grants
  oauth/revoke/route.ts              POST  RFC 7009
  mcp/manage/route.ts                the management door (gate + placeholder)
  (app)/delegations/page.tsx                 /delegations
  (app)/delegations/[id]/revoke/route.ts     POST  one-click revoke
  admin/(guarded)/oauth-clients/page.tsx     /admin/oauth-clients
  admin/(guarded)/oauth-clients/[id]/route.ts POST  approve / disable
```

Every route file is a one-line adapter over `root.oauth.handlers.*` or
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
`response_types_supported: [code]`, `grant_types_supported:
[authorization_code, refresh_token]`, `code_challenge_methods_supported:
[S256]`, `token_endpoint_auth_methods_supported: [none, client_secret_basic,
client_secret_post]`, `scopes_supported: [mgmt]`,
`authorization_response_iss_parameter_supported: true`,
`client_id_metadata_document_supported` (the configuration), and
`registration_endpoint` unless the policy is `closed`.

There are two RFC 9728 documents. `/.well-known/oauth-protected-resource`
(P1.6) describes the **execution** door and lists no authorization server;
`/.well-known/oauth-protected-resource/mcp/manage` describes the management
door. A client looks at the path-aware one first, and the door's challenge
names it explicitly.

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
  private, link-local, carrier-grade NAT, unique-local, multicast,
  documentation, NAT64, IPv4-mapped); the peer actually connected to is
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

Only an `approved` client reaches a consent screen or gets anything from the
token endpoint (`unauthorized_client`). `ClientRegistry.decide(actor, id,
decision)` — Administration → OAuth clients — records the decision and writes
`oauth-client-approved` or `oauth-client-disabled` (object `oauth-client`).
**Disabling revokes every delegation the client holds**, each with its own
`delegation-revoked` entry (reason `operator`) that the delegating user finds
in their audit.

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
         └─ if the entry cannot be written: the delegation is revoked, no code is issued
createCode(digest, redirect_uri, code_challenge, S256, expires in 60 s)
303 <redirect_uri>?code=…&state=…&iss=<issuer>
```

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
used); a client that is not `approved` → `unauthorized_client`.

**`authorization_code`** (`exchangeCode`):

- the code is looked up by digest; unknown → `invalid_grant`;
- **already consumed → replay**: the delegation is revoked
  (`authorization-code-replay`), `invalid_grant`;
- `consumeCode` is the single atomic use; a concurrent second exchange loses
  and is treated as a replay; an expired code is plain `invalid_grant`;
- from here the code is spent, whatever fails next: the delegation's client
  must be the authenticated one; `redirect_uri`, when sent, must equal the one
  of the authorization request; `verifyS256(code_verifier, code_challenge)`;
  the user must still be active;
- a refresh token and an access token are issued.

**`refresh_token`** (`refresh`): the presented token is looked up by digest
whatever its state.

- **Already rotated (`replaced_by_id` set) → replay**, whoever presents it:
  the delegation and every token under it are revoked
  (`refresh-token-replay`), `invalid_grant`. A dead token tried again later
  writes nothing more.
- Another client's token: `invalid_grant`, nothing revoked.
- `rotateRefreshToken` revokes the presented token and links it to its
  successor in one transaction; a concurrent renewal that loses is a replay.
- `scope`, when sent, may only be `mgmt`; `resource` must be the door.
- Access tokens issued before a rotation live out their 15 minutes.

**Revoked families are audited once** (`revokeFamily`): the store's
`revokeIfActive` answers only to the call that actually revoked, and that call
writes `delegation-revoked` in the name of the delegating user, with the
reason and the client (`delegated_client_id`), and logs it at `warn`.

**`POST /oauth/revoke`** (RFC 7009): the client authenticates like above; a
refresh token of that client ends its delegation (reason `client`, audited); an
access token is revoked alone; anything else changes nothing. Always `200`.

**Sweep.** At most once an hour, an issuance deletes codes and tokens expired
for more than a day (`DelegationsRepo.purgeExpired`). A rotated refresh token
is kept as long as its successor lives, so its replay is still recognised.

### Error responses

JSON `{ error, error_description }`, `Cache-Control: no-store`. Codes used:
`invalid_request`, `invalid_client` (401), `invalid_grant`,
`unauthorized_client`, `unsupported_grant_type`, `invalid_scope`,
`invalid_target` (RFC 8707), `invalid_redirect_uri`, `invalid_client_metadata`,
`access_denied` (403, registration closed), `slow_down` (429 with
`Retry-After`), `server_error`. A description never contains a token, a code
or a secret.

## Two families of endpoints (`handlers.ts`)

|                  | Protocol endpoints                                         | Human endpoints                                           |
| ---------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| Which            | metadata, `register`, `token`, `revoke`                    | `authorize`, `decide`, `revokeDelegation`, `decideClient` |
| Called by        | OAuth clients                                              | the user's browser                                        |
| Authenticated by | what the request carries (code, refresh token, client)     | the web session                                           |
| Cookie           | **never read**                                             | read                                                      |
| Origin           | any (`Access-Control-Allow-Origin: *`, preflight answered) | mutations through `guardMutation` (origin, session, role) |
| Rate limit       | per client address, through the `RateLimiter` port         | —                                                         |

Rate limits (`handlers.ts` constants): `token` and `revoke` 60 per minute per
address (`oauth:token:ip:<ip>`) and, for `token`, 120 per minute per
authenticated client; `register` 20 per 10 minutes per address and 300 per
hour for the instance. The address is the trusted-proxy rule's
(`clientIpResolver`); with no `trusted_proxies` configured every caller shares
one window. `tests/unit/server/auth/mutation-guard.test.ts` classifies the
three mutating protocol endpoints apart (`PROTOCOL_ENDPOINTS`) and asserts
that an operator's cookie from a foreign origin changes nothing in their
answer.

## Admission to the door (`management-gate.ts`, `verifier.ts`)

`DelegatedTokenVerifier.resolve(bearer)` → `DelegationContext | null`
(`delegation_id`, `user_id`, public `client_id`, `scopes`, `expires_at`): the
token must have the access-token shape, a live row, an active delegation and
an **active user**. It reads the store at every call: no cache.
`verifyAccessToken(token)` is the same answer in the MCP SDK's
`OAuthTokenVerifier` contract (`AuthInfo` with the delegation under
`extra['vaubaan.delegation']`, or an `invalid_token` `OAuthError`).

The same verifier is wired into the **execution** door as its
`DelegatedTokenResolver` (`compose/root.ts`), which is how `/mcp` refuses a
delegated token by kind rather than as an unknown bearer.

`ManagementGate.admit(request)` → `{ delegation, client } | Response`:

| Presented                                                                      | Answer                                                                                      |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| a browser `Origin` other than the instance                                     | 403                                                                                         |
| nothing                                                                        | 401, `WWW-Authenticate: Bearer realm, resource_metadata, scope` (no `error`: RFC 6750 §3.1) |
| a live delegated access token                                                  | admitted                                                                                    |
| a mission token (identified by the execution door's throttled `TokenVerifier`) | 403 `wrong-credential-kind` (`presented: mission-token`), no challenge                      |
| a web session, as a cookie with no bearer or as the bearer                     | 403 `wrong-credential-kind` (`presented: human-session`), no challenge                      |
| anything else (unknown, expired, revoked, a refresh token, a look-alike)       | 401 with the challenge and `error="invalid_token"`                                          |

The refusal bodies are the execution door's (`refusalToRpcError`,
`rpcError`). A string that merely has the shape of a mission token is an
unknown bearer: a kind is only named for a credential that was identified.

**For P2.4.** Keep `root.management.gate`; replace
`ManagementDoorPlaceholder` with the real door, and pass
`{ delegation: { id: delegation.delegation_id, clientId: delegation.client_id } }`
to `MissionService.issue` so that the mission records `delegation_id` and the
audit entry carries `delegated_client_id`.

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
`purgeExpired`.

`DELEGATION_REVOKE_REASONS`: `user`, `client`, `operator`,
`refresh-token-replay`, `authorization-code-replay`.

The audit search scope (`store/repositories/audit.ts`) shows a user the
administrative entries whose object is one of **their** delegations.

## Pages

- **`/delegations`** (`APP_NAV` "Delegations"; `DelegationService.listFor`):
  one card per delegation, most recent first — the client's name (as a
  claim), its client id, where its access goes, the scope, when it was
  granted and last renewed, its state, the missions it issued (empty until
  P2.4) and a **Revoke** button (`POST /delegations/<id>/revoke`, one click).
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
  presented twice: two processes share the client's token store, or the token
  leaked. The audit entry `delegation-revoked` carries the reason; the log
  has `delegation revoked` at `warn`.
- **`wrong-credential-kind` at `/mcp/manage`.** The agent is configured with
  its mission token on the management URL; the hint names the right door.
- Log component: `oauth-as` (and `management-door` for the gate).

## Extension

- A second scope or resource: `MANAGEMENT_SCOPE` and `isManagementResource`
  are the two places that assume one of each; the delegation row already
  stores its scope string.
- A hosted deployment: tokens and consents are rows and `SessionStore`
  records already; `AuthorizationService.takePending` and
  `TokenService.lastPurgeAt` are marked `// single-process only`.
- `private_key_jwt` for metadata-document clients (the draft allows it) would
  go in `authenticateClient` and `parseClientDocument`.

## Tests

Unit, beside the code (`src/server/oauth-as/*.test.ts`): PKCE (the RFC 7636
vector, wrong and malformed verifiers, the challenge as its own verifier);
secrets (shapes, prefixes, never a mission token, digests); redirect URIs
(what registers, exact match and every near miss, the loopback port
exception and its limits); metadata documents (URL rules, the address filter
table, the lookup that fails on one private address, the document's rules,
cache lifetimes, name cleaning); the discovery documents; the consent screen
(content, escaping of hostile values, headers, nonce, Deny first); the client
registry (registration and its refusals, the three policies, policy evaluated
at every use, operator decisions and their audit, disabling revokes
delegations, documents: cache, refetch, fail closed, rate limit); the
authorization service (page errors versus redirect errors, the consent:
single use, user-bound, expiry, concurrent answers, disabled client, audit
failure); the token service (code exchange, PKCE, **code single-use and
replay**, client binding, **refresh rotation**, **replay revokes the family
and is audited once**, concurrent renewals, scope and resource, expiry,
revocation, client authentication, sweep); the delegation service and the
verifier (**revoke cascades**, another user's delegation, states).

Integration (`tests/integration/oauth-as/`, the real root on the `:memory:`
store with the simulated IdP): `mcp-client-flow.test.ts` — the official
`@modelcontextprotocol/client` discovers, registers, is sent to consent, is
admitted, renews by itself, is sent back to the user after a revocation, and
is told `access_denied`; `credential-separation.test.ts` — the three
credentials at every surface that is not theirs; `http-surface.test.ts` —
each endpoint's answers, headers, limits, the policies over HTTP, the
operator's approval and disabling, metadata documents fetched only for a
signed-in user, no secret in the logs; `routes.test.ts` — the table against
the route files. `tests/integration/store/oauth-clients.test.ts` — what
migration `0006` added to the repository, and the audit scope.

Structural: `tests/unit/server/auth/mutation-guard.test.ts` (the three human
mutations through the one guard, the three protocol endpoints session-blind),
`tests/unit/app/app-guard.test.ts` and `admin-guard.test.ts` (the two pages
and their routes), `tests/integration/audit/admin-mutations.test.ts` (every
public method of the module's classes classified; the mutations leave their
entry).

Not automated: a run with Claude Code itself against a deployed instance —
see "How to use it".

## References

- Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §4.1 bis, §4.2, §6, §8, §10.
- ADR: [management-door-authorization-server](../decisions/management-door-authorization-server.md).
- MCP authorization specification, revision 2026-07-28; OAuth 2.1 (draft);
  RFC 7591, 7636, 7009, 8252, 8414, 8707, 9207, 9700, 9728; OAuth Client ID
  Metadata Document (draft).
