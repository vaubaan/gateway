---
title: Authentication — OIDC sign-in, web session, bootstrap token, admin rule
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/auth/
  - apps/gateway/src/server/store/repositories/web-sessions.ts
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/app/auth/
  - apps/gateway/src/app/logout/route.ts
  - apps/gateway/src/app/api/auth/
  - apps/gateway/src/app/api/admin/identity-provider/route.ts
  - apps/gateway/src/app/(public)/login/page.tsx
  - apps/gateway/src/app/page.tsx
  - apps/gateway/src/app/(public)/layout.tsx
  - apps/gateway/src/app/admin/
  - apps/gateway/src/components/auth/
  - apps/gateway/migrations/0003_web_sessions.sql
  - apps/gateway/tests/integration/auth/
  - apps/gateway/tests/unit/app/admin-guard.test.ts
  - apps/gateway/tests/unit/server/auth/mutation-guard.test.ts
---

# Authentication — OIDC sign-in, web session, bootstrap token, admin rule

How a human gets a session on the instance (spec §0 "Operator", "User",
"Group", "IdP"; §4.2 Administration; §4.3; §6 "human authentication";
§7.1), how the operator bootstraps the identity provider, and how
"operator" is decided afterwards. ADR
[oidc-relying-party-and-web-session](../decisions/oidc-relying-party-and-web-session.md).
Built on the [configuration](configuration.md) root (`InstanceConfig.idp`,
`admin`, `bootstrapToken`, the `SessionStore` port) and the
[store](store.md) repositories (`users`, `groups`, `config`, `audit`).

## Layout

```
apps/gateway/src/server/auth/            host-agnostic, never imports `next`
  index.ts            createAuthModule(deps) → root.auth; barrel
  relying-party.ts    openid-client v6 RP: discovery cache, PKCE/state/nonce, code grant, userinfo merge
  claims.ts           mapClaims(), parseGroupsClaim(), assertEmailDomainAllowed()
  admin-rule.ts       isOperator(), describeAdminRule()
  idp-settings.ts     IdpSettingsService: file-or-store IdP settings, secret sealed in instance_config
  bootstrap.ts        BootstrapService: constant-time verify, revoked flag in instance_config
  session-service.ts  SessionService over SessionStore: session + pending-login records, their type guards, cookies
  cookies.ts          vbn_session / vbn_login: HttpOnly, Secure, SameSite=Lax
  origin.ts           isSameOrigin(headers, publicUrl) for every mutation
  guard.ts            guardMutation() / guardSession(): origin → session → role, for every handler; refusalResponse()
  login.ts            completeLogin(): users upsert, IdP group sync, bootstrap revocation; currentAuthority()
  authenticator.ts    Authenticator.authenticate(headers) → Principal; authorizeAdmin(); auditActorId()
  handlers.ts         Request → Response handlers of the five endpoints; adminSignInPage()
  errors.ts           LoginError (closed codes + UI sentences), IdpSettingsError
apps/gateway/src/server/store/repositories/
  web-sessions.ts     store.webSessions: the SessionStore port over table web_sessions, rows keyed by SHA-256(id)
apps/gateway/migrations/0003_web_sessions.sql
apps/gateway/src/lib/auth/session.ts     Next glue: currentPrincipal(), adminDecision(), requireOperator()
apps/gateway/src/app/
  page.tsx                               /  — redirect: /missions with a session, /login without
  (public)/layout.tsx                    centred container of the pages reachable without a session
  (public)/login/page.tsx                /login — IdP button, account view, error codes
  auth/login/route.ts                    GET  /auth/login?return_to=
  auth/callback/route.ts                 GET  /auth/callback
  logout/route.ts                        POST /logout
  api/auth/bootstrap/route.ts            POST /api/auth/bootstrap
  api/admin/identity-provider/route.ts   POST /api/admin/identity-provider
  admin/bootstrap/page.tsx               /admin/bootstrap (outside the guard)
  admin/(guarded)/layout.tsx             the Administration shell (bar, "Not an operator" page) — not the boundary
  admin/(guarded)/page.tsx               /admin
  admin/(guarded)/identity-provider/page.tsx
apps/gateway/src/components/auth/        PrincipalCard, OperatorBadge, SignOutButton, auth.module.css
```

The route handlers are one-line adapters over `root.auth.handlers`; the pages
call `currentPrincipal()` or, under `/admin`, `requireOperator()`, and render.
Everything that decides lives under `server/auth` and is tested without Next.

## The three states of an instance

| State                        | How a human gets in                                         | Who is operator                                  |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| No IdP configured            | `/admin/bootstrap` with the `bootstrap_token` of the config | whoever holds the bootstrap token                |
| IdP configured, token active | both: bootstrap token **or** IdP sign-in                    | bootstrap holder, and any user matching the rule |
| Token revoked (or absent)    | IdP sign-in only                                            | any user matching the **admin rule**             |

The transition happens on the **first IdP sign-in of a user matching the admin
rule**: `completeLogin()` writes `bootstrap.revoked_at` into `instance_config`
(`BootstrapService.revoke()`) and an administrative audit entry
(`config-changed` on `instance-config` / `bootstrap`, in that user's name); the
token is refused from then on even if it is still present in the configuration, and open bootstrap sessions stop being
a principal at their next `authenticate()`, on every surface. A non-operator signing in first does not revoke
anything (that would lock the instance). When the IdP is set in the mounted
configuration the token is optional: without one,
`InstanceConfig.bootstrapToken` is `null` and the state is `unavailable`; one
given next to the IdP is kept and stays `active` until the first operator
sign-in.

The **admin rule** is `InstanceConfig.admin` (`admin.group` and/or
`admin.emails`, required by the loader): `isOperator({ email, groupNames },
rule)` is true for a member of the named IdP group or a listed email
(lower-cased compare). Only groups the IdP claimed count (`groups.source =
'idp'`): membership of a local group, kept by an operator in Administration →
Groups ([authority](authority.md)), never makes anyone an operator, and a
local group cannot take the rule's name. It is evaluated by
`currentAuthority()` from the user's
rows in `group_members` on **every** `authenticate()`, never from the session
(spec §10 "authority recomputed from current membership"; integration test
"removed from the admin group, the next check fails").

**`admin.emails` rests on the email claim.** It is only as strong as the
IdP's control of that attribute: use it with an IdP whose directory owns the
address (the user cannot edit it, a foreign tenant cannot assert it).
`admin.group` is the stronger rule, since group membership is granted by the
directory's administrators. As a floor, a sign-in whose claims say
`email_verified: false` is refused before anything is written (see "Claims"
below), so an address the IdP itself calls unproven never decides operator
status nor passes the domain filter.

## Identity provider settings

`IdpSettingsService.current()` returns the effective `IdpConfig` and its
`source`:

- `file` — `InstanceConfig.idp` is set (`idp.*` / `VAUBAAN_IDP_*`). It wins;
  the Admin page is read-only (`readOnly`), `save()` refuses.
- `store` — the operator saved the settings from `/admin/identity-provider`.
  Keys in `instance_config`: `idp.issuer`, `idp.client_id`,
  `idp.client_secret` (**sealed** by the `Encryptor`, associated data
  `instance_config:idp.client_secret`, `key_version` stamped),
  `idp.claims.{sub,email,groups}`, `idp.allowed_email_domains` (JSON array,
  lower-cased). `IDP_CONFIG_KEYS` names them.

`save()` validates everything at once (`IdpSettingsError.problems`): https
issuer without query/fragment (an `http://` issuer only with
`allowInsecureIssuer`, tests), non-empty client id, a client secret unless one
is already stored (the form never echoes it; blank keeps it), three non-empty
claim names, domains without `@`. The redirect URI to register at the IdP is
`<public_url>/auth/callback` (`relyingParties.redirectUri`, shown on the
page). The seven keys are written by one `ConfigRepo.apply()` call, in one
transaction: a failure leaves the previous settings whole, never the issuer
of one IdP with the client secret or the claim mapping of another. The save is audited: `AdminAuditEntry` `config-changed` on
`instance-config` / `idp`, `user_id` = `auditActorId(principal)`
(`authenticator.ts`): the operator's user id, or `BOOTSTRAP_ACTOR_ID`
(`bootstrap`, `packages/gateway-core/src/audit.ts`) for the bootstrap
operator, whom the audit view then names `BOOTSTRAP_ACTOR_LABEL`
("Bootstrap operator") in `actor.label`. `before` (`null` on the first
save) and `after` carry the same view: issuer, client id, claim mapping and
allowed email domains — never the secret. The entry is written after the
settings are committed; if that write fails, the save stands and the handler
logs `audit entry not written for a saved configuration change` at `error`
with the actor and the object, so the gap is visible.

## Sign-in flow

```
GET /auth/login?return_to=/x
  idp.current()  ──none──▶ 303 /login?error=idp-not-configured
  rp.start(): discovery (cached), PKCE S256 verifier+challenge, state, nonce
  sessions.createPending({state, nonce, codeVerifier, returnTo})   TTL 10 min
  303 <authorization_endpoint>?client_id&redirect_uri=<public_url>/auth/callback
      &scope=openid profile email [groups]&code_challenge&state&nonce
      Set-Cookie: vbn_login=<id>; HttpOnly; Secure; SameSite=Lax

GET /auth/callback?code&state           (Lax cookie travels on this top-level GET)
  sessions.takePending(cookie)  ──none──▶ 303 /login?error=login-expired
  url = callbackUrl(public_url) + request's query string   ← never request.url
  rp.finish(url, {state, nonce, codeVerifier}):
      authorizationCodeGrant (ClientSecretPost, expectedState, expectedNonce, pkceCodeVerifier,
      idTokenExpected); claims = { ...userinfo, ...idToken } when userinfo_endpoint exists
  mapClaims(claims, settings.claims)   ← refuses email_verified: false
  assertEmailDomainAllowed()
  completeLogin(): users.upsertFromIdp, syncIdpGroups, currentAuthority, bootstrap revoke
  sessions.destroy(cookie)             ← the session the browser already had, if any
  sessions.create({kind:'user', userId, login:{email, groups}})          TTL 8 h, absolute
  303 return_to   Set-Cookie: vbn_session=<id>; …   Set-Cookie: vbn_login=; Max-Age=0
```

- `return_to` is accepted only as a path of this instance (`safeReturnTo`:
  starts with `/` and resolves, through the URL parser, to the origin of
  `public_url` — the shared `resolveReturnTo` of `server/http/return-to.ts`);
  default `/login`. It is validated when stored and again where it becomes
  the `Location`.
- **Callback URL.** `authorizationCodeGrant` validates the response against
  `currentUrl`. Behind the TLS terminator `request.url` shows the internal
  host, so `handlers.loginCallback` rebuilds it from `config.publicUrl` and
  only copies the query string (integration test "builds the callback URL
  from public_url, not from the host the process sees").
- **Scopes.** `openid profile email`, plus `groups` when
  `scopes_supported` advertises it (Okta, Keycloak with the mapper); Google
  refuses unknown scopes, so it is never requested blindly.
- **Claims.** The ID token wins over userinfo (signed, nonce-bound);
  userinfo is fetched when the server has a `userinfo_endpoint` and an
  access token came back, and its failure is a warning in the log, not a
  refusal. `mapClaims` reads the configured names; `groups` may be an
  array, a space/comma/semicolon delimited string, or absent (→ no group).
  `sub` and `email` missing → `claims-missing`; the email is lower-cased;
  `name` becomes `displayName`. **`email_verified`**: an explicit negative
  (`false`, or the string `"false"` some IdPs send) → `email-not-verified`,
  whatever claim the email is mapped from; the sign-in stops there (no user
  row, no group sync, no bootstrap revocation). An absent claim is accepted:
  many IdPs never send it. Entra ID returns group **object ids**
  unless the app registration is configured to emit names; the admin rule
  then names the object id.
- **Groups sync** (`syncIdpGroups` → `GroupsRepo.syncIdpMemberships(userId,
names)`): one store transaction creates the missing groups (source `idp`),
  adds the claimed memberships and removes the IdP-sourced ones the user no
  longer claims. A membership change is an authorization change, so it is
  applied whole or not at all: a failure leaves the previous memberships. A
  claimed name that already exists as a **local** group is skipped (returned
  in `skipped`, logged as a warning), never granted. Emptied IdP groups keep
  their row (they may own connections).
- **Errors** reach the browser as closed codes (`LOGIN_ERROR_CODES`,
  sentences in `LOGIN_ERROR_MESSAGES`): `/login?error=<code>` for the OIDC
  flow, `/admin/bootstrap?error=bootstrap-refused|bootstrap-unavailable` for
  the token form. A `POST` whose body is not a form is answered 400
  `invalid-request`. The detail (IdP error, failing claim name) is logged with
  `warn`; an unexpected failure is logged with `error` and shown as
  `idp-error`. State or nonce
  check failures from `openid-client` (`OAUTH_INVALID_RESPONSE`,
  `OAUTH_JWT_CLAIM_COMPARISON_FAILED` naming `"state"`/`"nonce"`, found
  through the `cause` chain) map to `state-mismatch`; an `error=` on the
  callback to `idp-error`; discovery failures to `discovery-failed`.
- **Discovery cache.** `createRelyingPartyFactory` keeps one
  `Configuration` promise per (issuer, client id, client secret) and drops
  it on failure (`// single-process only` as a cache: replicas rediscover
  for themselves). `RootDeps.oidc` injects `fetch` (`customFetch`, also
  the hook for a corporate proxy) and `allowInsecureIssuer` for tests.
  Clock tolerance for ID-token validation: 60 s.

No IdP token is stored: the session carries the user id and the claims seen
at sign-in for display (`login.email`, `login.groups`, shown by the "Test
login" result and the account card). RP-initiated logout at the IdP is not
performed; `/logout` ends the instance session only.

## Web session

`SessionService` over the root's `SessionStore` port, two record kinds under
distinct key prefixes in the same store:

| Key            | Record                                                                                       | TTL                | Cookie        |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------ | ------------- |
| `session:<id>` | `{kind:'user', userId, login:{email, groups}, createdAt}` or `{kind:'bootstrap', createdAt}` | 8 h, absolute      | `vbn_session` |
| `login:<id>`   | `{state, nonce, codeVerifier, returnTo, createdAt}`                                          | 10 min, single use | `vbn_login`   |

Ids are 32 random bytes base64url; cookies are `Path=/; Max-Age=<ttl>;
HttpOnly; Secure; SameSite=Lax` (the public URL is always https). A cookie
value that is not base64url is ignored. There is no sliding expiry: a
session ends 8 hours after sign-in whatever the activity. A sign-in (IdP or
bootstrap token) deletes the session the browser presented before it issues
the new one.

**Records are guarded, not cast.** The port returns `unknown`;
`isWebSessionRecord` and `isPendingLogin` (`session-service.ts`) prove the
shape before the record is used. A value of another shape (written by another
build, or damaged) is deleted and reads as no session.

**Implementation of the port** (`server/store/repositories/web-sessions.ts`):
the store repository `store.webSessions` over `web_sessions(id, value_json,
expires_at)` (migration `0003`), portable SQL, ISO-8601 text expiry, expired
rows swept on every write and ignored on read. **The `id` column holds the
SHA-256 (hex) of the key, never the key**: the cookie value is a bearer, and
like every other bearer of the schema only its digest is stored, so a copy of
the database file or a backup is not a set of live sessions (the ids carry
256 bits of entropy; a plain digest is enough). The digest covers every user
of the port, the connect flows' `connect:` and `notice:` keys included. Rows
written before this rule (key in clear) are unreachable and are swept when
they expire. The root uses `store.webSessions` unless `RootDeps.sessions`
injects another implementation (Redis for a hosted deployment,
`MemorySessionStore` in unit tests). Sessions therefore survive a restart and
are revoked by deleting the row (`destroyById`, done when a user turns
`removed` or a bootstrap session outlives the token).

**Origin check.** Every mutation (`/logout`, `/api/auth/bootstrap`,
`/api/admin/identity-provider`) passes `isSameOrigin(headers, publicUrl)`:
`Origin` must equal `public_url`'s origin, `Referer`'s origin is the
fallback, neither → 403 `origin-mismatch`. The forms are plain HTML
`method="post"` forms, so browsers always send `Origin`. No `proxy.ts`
(Next middleware) is needed: the check is in the handler, where the public
origin is known from the configuration rather than from forwarded headers.

**One guard for every mutation.** `guardMutation(request, deps, 'user' |
'operator')` (`guard.ts`) is the single implementation of the order and of
the checks, used by the handlers of this module and of the connections,
missions and requests modules:

1. origin (`isSameOrigin`) → `origin-mismatch`; the session of a foreign
   origin is not even read;
2. `authenticate()` → `no-session` (a session of a revoked bootstrap token or
   of a removed user is nobody, see below);
3. the role → `not-a-user` for `'user'` (the bootstrap operator owns
   nothing), `not-an-operator` for `'operator'` (`authorizeAdmin`).

It returns `{ ok: true, principal }` — a `UserPrincipal` for `'user'` — or
`{ ok: false, reason, status }`. The guard does not shape the answer: each
surface keeps its own (`refusalResponse(refusal, wording)` builds the JSON
body `{ error, message | reason }` with the surface's sentences;
`OPERATOR_REFUSALS` is the Administration wording; `/r/<id>` answers with a
redirect or a page). `guardSession` is steps 2 and 3 alone, for the reads
(`GET /api/requests`, `GET /r/<id>`, the connect callback). `/logout` and
`/api/auth/bootstrap` need no session and check the origin only.

`tests/unit/server/auth/mutation-guard.test.ts` holds the table of every
handler of the four modules: a handler added without being classified (a
mutation with its role, or a read with the reason) fails it, and so does a
`route.ts` exporting `POST` / `PUT` / `PATCH` / `DELETE` that delegates to
anything but a classified mutation or the execution door.

## Who is behind a request

`Authenticator.authenticate(headers)` → `Principal | null`:

- `vbn_session` → bootstrap record → `{kind:'bootstrap', sessionId}` while
  the token is `active`; once it is revoked the session is deleted and `null`
  returned, on every surface (the decision is made where the principal is
  made, not by each caller);
- user record → `users.getById` (must be `active`; a `removed` user's
  session is deleted and `null` returned) → `currentAuthority()` →
  `{kind:'user', user, groups, isOperator, login, sessionId}`.

`authorizeAdmin(principal)` → `{ok, principal}` or `{ok:false, status: 401 |
403, reason}`: no principal → 401; bootstrap principal → ok (`authenticate()`
only returns one while the token is `active`); user → ok when `isOperator`,
else 403.

**Every page and route under `/admin` authorizes itself.** A layout is not an
authorization boundary in the App Router: a request can have a page segment
rendered without its layout. So:

- each page under `app/admin/(guarded)/` calls `requireOperator()`
  (`lib/auth/session.ts`) before it reads anything from the root. It returns
  `{ root, principal }` to an operator; with no session (a revoked bootstrap
  session included) it redirects to `adminSignInPage()` — `/admin/bootstrap`
  while the token is active and no IdP is configured, `/login` otherwise; for
  a signed-in non-operator it calls `notFound()`;
- each route handler under it authorizes in its host-agnostic handler
  (`guardMutation(…, 'operator')`) and answers 401/403 JSON bodies;
- the guarded layout keeps the navigation bar, the same 401 redirect and the
  "Not an operator" page that names the admin rule, which is what a
  non-operator sees on a normal navigation.

`tests/unit/app/admin-guard.test.ts` discovers every `page.tsx` and
`route.ts` under `(guarded)`, so a page added without the guard fails it.

## Pages

- **`/login`** (where `/` sends a visitor with no session; a signed-in one
  goes to `/missions` — `app/page.tsx`) — one
  button per configured IdP ("Continue with `<issuer host>`" → `GET
/auth/login`), or "No identity provider is configured yet" with a link to
  the bootstrap page while the token is active. Signed in, it shows the
  `PrincipalCard`: email, groups, the **operator marker** (`OperatorBadge`:
  `Operator` / `User` / `BOOTSTRAP_ACTOR_LABEL`, "Bootstrap operator"), the Connections link for a
  signed-in user, the Administration link for operators, and the sign-out
  form. The pages under `app/(app)/` get the application bar (`AppShell`) from the
  same principal (handbook [connections](connections.md), "Pages").
- **`/admin/bootstrap`** — the token form (`POST /api/auth/bootstrap`,
  field `token`), only while the state is `active`; otherwise says when it
  was revoked (or that none exists) and points to `/login`. A refused token
  comes back as `?error=bootstrap-refused`; a visitor who already holds a
  bootstrap session is redirected to `/admin`.
- **`/admin`** — issuer, source (file or Admin page), admin rule, bootstrap
  state, build. The Administration bar links Identity provider and
  Provider apps (`/admin/provider-apps`, handbook
  [connections](connections.md)) and Telemetry (`/admin/telemetry`, handbook
  [telemetry](telemetry.md)).
- **`/admin/identity-provider`** — the settings form (`POST
/api/admin/identity-provider`: `issuer`, `client_id`, `client_secret`,
  `claim_sub`, `claim_email`, `claim_groups`, `allowed_email_domains`),
  disabled when the file sets the IdP; problems come back as
  `?problem=…` and are listed; `?saved=1` confirms. The **Test login** card
  runs the real sign-in with `return_to=/admin/identity-provider?tested=1`
  and the page then shows the claims received (email, groups badges,
  operator yes/no) from the new session. Note that the tester's session
  replaces the bootstrap one: a non-operator tester lands on the 403 page
  and signs out to return to bootstrap.

Styling uses the style-guide tokens through the UI primitives (`Card`,
`Button`, `Field`, `Input`, `Badge`, `Banner`, `Stack`) and
`components/auth/auth.module.css`.

## Tests

Unit, co-located under `src/server/auth/*.test.ts` (57): the guard (each
foreign-origin form refused before the session is read, same-origin Referer
accepted, 401 for nobody, the two roles, `guardSession` without the origin
step, the wording of `refusalResponse`); claim mapping (array, delimited string, absent, custom names, missing
claims named, email lower-casing, allowed domains, `email_verified` false
refused in its boolean and string forms and accepted when true or absent); admin rule (group,
email, neither, both); origin check (match, mismatch, scheme, internal host,
Referer fallback, missing, `null`); cookies and `SessionService` (attributes,
malformed values, absolute expiry, pending login single use and TTL, a
stored record or pending sign-in of another shape read as none and deleted);
`BootstrapService` (exact token, absent, revoked durable, idempotent
revocation); `IdpSettingsService` (store round trip, sealed secret with its
associated data, blank secret keeps the stored one, every problem at once,
http issuer only when allowed, one transaction (a failed write keeps the
previous settings whole), file wins and read-only); `safeReturnTo`. The
`store.webSessions` repository is covered by
`tests/integration/store/web-sessions.test.ts` (8: round trip, row keyed by
the digest and never the id, a clear-keyed row not read, TTL, sweep,
overwrite, invalid TTL, an unreadable value removed).

Unit, `tests/unit/app/admin-guard.test.ts` (24), over the real root on the
`:memory:` store with only `next/headers` replaced: `requireOperator()` with
no session (bootstrap page, then `/login` once an IdP exists), an unknown
cookie, a plain user (`notFound`), an operator, a bootstrap session before
and after the token is revoked; then, for every page under
`admin/(guarded)`, the page function itself renders nothing for those three
non-operators and renders for an operator; and every route under it answers
401 / 403.

Unit, `tests/unit/server/auth/mutation-guard.test.ts` (113), over the real
root on the `:memory:` store with seeded connections, a mission and an open
claim: the completeness checks above; then, for each of the thirteen
mutating handlers, the rightful caller gets through (so the request is one
that would be served), and the request is refused with every table of the
store unchanged for another origin, no `Origin` and no `Referer`, a foreign
`Referer`, an opaque `Origin`, no session (401), a session of the wrong role
(a plain user on an operator endpoint, the bootstrap operator on a user
endpoint: 403) and a bootstrap session whose token was revoked (401; only
that session's row is removed).

Integration, `tests/integration/auth/oidc-login.test.ts` (16) over the real
root on the `:memory:` store and the in-process `FakeIdp` (`fake-idp.ts`:
discovery, JWKS, token and userinfo endpoints answered through
`customFetch`, ES256 ID tokens signed with `node:crypto`, PKCE verified,
`authorize()` plays the consenting browser): first sign-in creates the user
and its `idp` groups and the operator marker follows the rule; re-login with
changed groups rewrites memberships and leaves local groups alone; a claim
colliding with a local group is ignored; **structural**: removed from the
admin group, the next `authenticate()` says `isOperator: false`; non-admin →
403 on `authorizeAdmin` and on the settings handler; the bootstrap token
opens `/admin`, configures the IdP through the form (secret sealed, audit
entry without the secret), is not revoked by a non-operator sign-in, is
revoked by the first operator sign-in, then refused for new attempts and
existing sessions; the callback URL is built from `public_url` even when the
request arrives on `127.0.0.1:3000`; tampered state → `state-mismatch`,
missing pending login → `login-expired`, IdP `access_denied` → `idp-error`;
email outside the allowed domains and missing claims refused; an email the
IdP marks unverified refused even when it is on the admin list (no user, no
operator, token still active); a second sign-in ends the first session; an
IdP save whose audit entry cannot be written is logged at `error` and
stands; a non-form body → 400; userinfo claims merged under the ID token;
logout needs the origin check and deletes the row; sessions are rows of
`web_sessions` keyed by a digest.

Not automated: a browser run against a real IdP (Google, Entra ID,
Keycloak) — [e2e-tests](../tests/e2e-tests.md) describes the manual check.
