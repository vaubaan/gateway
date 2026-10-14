---
title: Authentication — OIDC sign-in, web session, bootstrap token, admin rule
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - apps/gateway/src/server/auth/
  - apps/gateway/src/server/users/
  - apps/gateway/src/server/store/repositories/web-sessions.ts
  - apps/gateway/src/server/store/repositories/users.ts
  - apps/gateway/src/server/oauth-as/delegations.ts
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/app/auth/
  - apps/gateway/src/app/logout/route.ts
  - apps/gateway/src/app/api/auth/
  - apps/gateway/src/app/api/admin/identity-provider/route.ts
  - apps/gateway/src/app/(public)/login/page.tsx
  - apps/gateway/src/app/(app)/page.tsx
  - apps/gateway/src/app/(public)/layout.tsx
  - apps/gateway/src/app/admin/
  - apps/gateway/src/components/auth/
  - apps/gateway/src/components/shell/AppShell.tsx
  - apps/gateway/migrations/0003_web_sessions.sql
  - apps/gateway/migrations/0009_user_sessions_ended_at.sql
  - apps/gateway/migrations/0011_users_keyed_by_issuer_and_subject.sql
  - apps/gateway/tests/integration/auth/
  - apps/gateway/tests/integration/store/users-issuer.test.ts
  - apps/gateway/tests/unit/app/admin-guard.test.ts
  - apps/gateway/tests/unit/server/auth/mutation-guard.test.ts
---

# Authentication — OIDC sign-in, web session, bootstrap token, admin rule

How a human gets a session on the instance (spec §0 "Operator", "User",
"Group", "IdP"; §4.2 Administration; §4.3; §6 "human authentication";
§7.1), how the operator bootstraps the identity provider, and how
"operator" is decided afterwards, and how an operator deactivates a user. ADRs
[oidc-relying-party-and-web-session](../decisions/oidc-relying-party-and-web-session.md),
[sign-in-hardening-host-cookies-group-overage](../decisions/sign-in-hardening-host-cookies-group-overage.md),
[users-keyed-by-issuer-and-subject](../decisions/users-keyed-by-issuer-and-subject.md)
and [operator-deactivates-a-user](../decisions/operator-deactivates-a-user.md).
Built on the [configuration](configuration.md) root (`InstanceConfig.idp`,
`admin`, `bootstrapToken`, the `SessionStore` port) and the
[store](store.md) repositories (`users`, `groups`, `config`, `audit`).

## Layout

```
apps/gateway/src/server/auth/            host-agnostic, never imports `next`
  index.ts            createAuthModule(deps) → root.auth; barrel
  relying-party.ts    openid-client v6 RP: discovery cache, PKCE/state/nonce, code grant, userinfo merge
  claims.ts           mapClaims(), parseGroupsClaim(), groupsMovedOutOfToken(), assertEmailDomainAllowed()
  admin-rule.ts       isOperator(), describeAdminRule()
  idp-settings.ts     IdpSettingsService: file-or-store IdP settings, secret sealed in instance_config
  bootstrap.ts        BootstrapService: constant-time verify, revoked flag in instance_config
  session-service.ts  SessionService over SessionStore: session + pending-login records, their type guards, cookies
  cookies.ts          __Host-vbn_session / __Host-vbn_login: HttpOnly, Secure, SameSite=Lax, Path=/
  origin.ts           isSameOrigin(headers, publicUrl) for every mutation
  guard.ts            guardMutation() / guardSession(): origin → session → role, for every handler; refusalResponse()
  login.ts            completeLogin(): unbound accounts bound to the issuer, deactivated user refused, users upsert, IdP group sync, bootstrap revocation; currentAuthority()
  authenticator.ts    Authenticator.authenticate(headers) → Principal; authorizeAdmin(); auditActorId()
  handlers.ts         Request → Response handlers of the five endpoints; adminSignInPage()
  errors.ts           LoginError (closed codes + UI sentences), IdpSettingsError
apps/gateway/src/server/users/           host-agnostic; built by the root as root.users
  index.ts            createUsersModule(deps) → { service, handlers }; barrel
  service.ts          UserAdminService: list(), deactivate(), reactivate()
  handlers.ts         Request → Response handlers of the two endpoints; USERS_PAGE
  errors.ts           UserAdminError (closed codes + UI sentences + HTTP status)
apps/gateway/src/server/store/repositories/
  web-sessions.ts     store.webSessions: the SessionStore port over table web_sessions, rows keyed by SHA-256(id)
  users.ts            store.users: getByIdentity(issuer, subject), bindUnboundTo(issuer), upsertFromIdp (never changes the status), markRemoved, reactivate; identityKeyOf()
apps/gateway/migrations/0003_web_sessions.sql
apps/gateway/migrations/0009_user_sessions_ended_at.sql    users.sessions_ended_at
apps/gateway/migrations/0011_users_keyed_by_issuer_and_subject.sql    users.issuer, users.subject, users.identity_key (unique)
apps/gateway/src/lib/auth/session.ts     Next glue: currentPrincipal(), requirePrincipal(), currentUser(), adminDecision(), requireOperator()
apps/gateway/src/app/
  (app)/page.tsx                         /  — the home ("Now"); a visitor with no session is sent to /login
  (public)/layout.tsx                    centred container of the pages reachable without a session
  (public)/login/page.tsx                /login — IdP button, account view, error codes
  auth/login/route.ts                    GET  /auth/login?return_to=
  auth/callback/route.ts                 GET  /auth/callback
  logout/route.ts                        POST /logout
  api/auth/bootstrap/route.ts            POST /api/auth/bootstrap
  api/admin/identity-provider/route.ts   POST /api/admin/identity-provider
  admin/bootstrap/page.tsx               /admin/bootstrap (outside the guard)
  admin/(guarded)/layout.tsx             the shell with the local navigation of Settings, or "You do not administer this gateway" — not the boundary
  admin/(guarded)/page.tsx               /admin
  admin/(guarded)/identity-provider/page.tsx
  admin/(guarded)/users/page.tsx         /admin/users
  admin/(guarded)/users/[id]/deactivate/route.ts   POST /admin/users/<id>/deactivate
  admin/(guarded)/users/[id]/reactivate/route.ts   POST /admin/users/<id>/reactivate
apps/gateway/src/components/auth/        AuthPage.tsx (AuthPage, AuthHeading: the frame of a page outside the shell), principal.ts (isOperatorPrincipal), NeedsUser.tsx, auth.module.css
```

The route handlers are one-line adapters over `root.auth.handlers` (and
`root.users.handlers` for the two under `/admin/users`); the pages
call `currentPrincipal()`, under `/admin` `requireOperator()`, and under
`(app)` `currentUser()` (an identified user; `null` for the bootstrap
operator, for whom the page renders `NeedsUser`) or `requirePrincipal()` (any
session: Activity, the reference, Settings), and render.
Everything that decides lives under `server/auth` and `server/users` and is
tested without Next.

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
'idp'`): membership of a local group, kept by an operator in Settings →
Teams (`/admin/groups`, [authority](authority.md)), never makes anyone an operator, and a
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
  the Sign-in page of Settings is read-only (`readOnly`), `save()` refuses.
- `store` — the operator saved the settings from `/admin/identity-provider`.
  Keys in `instance_config`: `idp.issuer`, `idp.client_id`,
  `idp.client_secret` (**sealed** by the `Encryptor`, associated data
  `instance_config:idp.client_secret`, `key_version` stamped),
  `idp.claims.{sub,email,groups}`, `idp.allowed_email_domains` (JSON array,
  lower-cased). `IDP_CONFIG_KEYS` names them.

`save()` validates everything at once (`IdpSettingsError.problems`): https
issuer without query/fragment (an `http://` issuer only with
`allowInsecureIssuer`, tests), non-empty client id, a client secret unless one
is already stored **for the same issuer** (the form never echoes it; blank
keeps it), three non-empty claim names, domains without `@`. When the issuer
differs from the stored one — compared after the URL parser has normalised
both — a blank secret is a problem (`client secret is required when the issuer
changes: …`): the stored secret is never sent to another identity provider's
token endpoint (ADR
[sign-in-hardening-host-cookies-group-overage](../decisions/sign-in-hardening-host-cookies-group-overage.md)).
The redirect URI to register at the IdP is
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

## A user is (issuer, subject)

OpenID Connect makes a subject unique within its issuer only, so the subject
alone does not name a user: the same subject signed by another identity
provider is somebody else, with an account of their own (ADR
[users-keyed-by-issuer-and-subject](../decisions/users-keyed-by-issuer-and-subject.md)).

- `IdentityClaims.issuer` is the `iss` of the validated ID token, exactly as
  issued. It is not a mappable claim (`idp.claims` has no key for it) and it
  is never the configured `idp.issuer`, which may differ from `iss` by a
  trailing slash. A token without it is `claims-missing`.
- The store keeps `users.issuer`, `users.subject` and `users.identity_key`
  (migration `0011`). `identity_key` carries the unique constraint and holds
  `<issuer> <subject>` (`identityKeyOf`: the issuer must be a URL without
  white space, so the first space splits the pair and two pairs never share a
  key; an empty subject is refused).
- `UsersRepo.getByIdentity(issuer, subject)` is the only lookup of a sign-in,
  and `upsertFromIdp` requires the issuer.
- An account created before the store recorded an issuer has `issuer` `NULL`
  and the key `unbound <subject>`, which no sign-in can match. The first
  sign-in the relying party validates binds **all** of them, in one
  transaction, to the issuer of that ID token (`UsersRepo.bindUnboundTo`,
  called by `completeLogin` before it looks the user up); `existing accounts
bound to the identity provider of this sign-in` is logged at `warn` with
  the issuer and the count. An account that would collide with one already
  bound to that issuer is left unbound, and so unreachable, rather than
  failing the sign-in. Once done the call changes nothing.

**Upgrade note.** After upgrading an instance that already has users, let
somebody sign in once **before** changing the identity provider. The existing
accounts are bound to whichever issuer signs in first: changing `idp.issuer`
in the same restart as the upgrade binds them to the new provider.

Pointing an instance at another identity provider afterwards gives everyone a
new account there; the earlier accounts keep their connections, shares and
missions and are reached by nobody. No tool moves an account to another
issuer.

## Sign-in flow

```
GET /auth/login?return_to=/x
  idp.current()  ──none──▶ 303 /login?error=idp-not-configured
  rp.start(): discovery (cached), PKCE S256 verifier+challenge, state, nonce
  sessions.createPending({state, nonce, codeVerifier, returnTo})   TTL 10 min
  303 <authorization_endpoint>?client_id&redirect_uri=<public_url>/auth/callback
      &scope=openid profile email [groups]&code_challenge&state&nonce
      Set-Cookie: __Host-vbn_login=<id>; Path=/; HttpOnly; Secure; SameSite=Lax

GET /auth/callback?code&state           (Lax cookie travels on this top-level GET)
  sessions.takePending(cookie)  ──none──▶ 303 /login?error=login-expired
  url = callbackUrl(public_url) + request's query string   ← never request.url
  rp.finish(url, {state, nonce, codeVerifier}):
      authorizationCodeGrant (ClientSecretPost, expectedState, expectedNonce, pkceCodeVerifier,
      idTokenExpected); claims = { ...userinfo, ...idToken } when userinfo_endpoint exists
  mapClaims(claims, settings.claims, {userinfoFailed})
      ← refuses groups that could not be read, email_verified: false, and a group overage
  assertEmailDomainAllowed()
  completeLogin(): users.bindUnboundTo(iss), users.getByIdentity(iss, sub) (not active →
      account-deactivated), users.upsertFromIdp (status read again → account-deactivated),
      membershipsChanging (watch), syncIdpGroups, settle, currentAuthority, bootstrap revoke
  sessions.destroy(cookie)             ← the session the browser already had, if any
  sessions.create({kind:'user', userId, login:{email, groups}})          TTL 8 h, absolute
  303 return_to   Set-Cookie: __Host-vbn_session=<id>; …   Set-Cookie: __Host-vbn_login=; Max-Age=0
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
  access token came back. Its failure is a warning in the log and
  `FinishedLogin.userinfoFailed`; it refuses the sign-in only when the groups
  were to come from it (next bullet). `mapClaims` reads the configured names;
  `groups` may be an array, a space/comma/semicolon delimited string, or
  absent (→ no group). `iss`, `sub` or `email` missing → `claims-missing`,
  naming each; the email is lower-cased;
  `name` becomes `displayName`. **`email_verified`**: an explicit negative
  (`false`, `0`, or the string `"false"` some IdPs send) → `email-not-verified`,
  whatever claim the email is mapped from; the sign-in stops there (no user
  row, no group sync, no bootstrap revocation). An absent claim is accepted:
  many IdPs never send it. Entra ID returns group **object ids**
  unless the app registration is configured to emit names; the admin rule
  then names the object id.
- **Groups that could not be read.** `mapClaims` is told whether the
  userinfo request failed (its third argument, `{ userinfoFailed }`) and
  throws `LoginError('groups-unavailable')` when it did **and** the
  configured groups claim is absent from
  the ID token: the groups are unknown, not empty, and syncing "no group"
  would take the user out of every IdP group (the connections those groups
  own, the shares made to them, the admin rule). The sign-in stops there (no
  user row, no group sync, no bootstrap revocation) and the login page says
  to try again. It is judged on evidence, not on a setting: an ID token that
  carries the claim, even as an empty list, signs in although userinfo is
  down; an IdP that answers userinfo without the claim sends no group, and
  signs in. A missing identity claim is reported first.
- **Group overage.** Entra ID leaves the groups out of a token once the user
  belongs to too many of them and sends a pointer instead. `mapClaims`
  refuses such a token with `groups-overage` (`groupsMovedOutOfToken`) rather
  than read it as "no group", which would replace the user's IdP memberships
  with nothing. It is judged on the configured groups claim: `_claim_names`
  is an object naming that claim, or — when the claim is Entra's `groups` —
  `hasgroups` is `true` (boolean or string). A partial list next to the
  pointer is refused too; a pointer for another claim, and a token with no
  groups and no pointer, are not an overage. The sign-in stops there (no user
  row, no group sync, no bootstrap revocation); the log line names the claim
  and the remedy (limit the claim to the groups assigned to the application,
  or map `idp.claims.groups` to a claim that is always complete). The
  instance does not follow the pointer (ADR
  [sign-in-hardening-host-cookies-group-overage](../decisions/sign-in-hardening-host-cookies-group-overage.md)).
- **A deactivated user does not sign in.** `completeLogin` reads the user by
  (issuer, subject) first; one whose status is not `active` is refused with
  `account-deactivated` before anything is written (no row refreshed, no
  group synced, no bootstrap revocation). `users.upsertFromIdp` refreshes
  email, display name and last sign-in only: it never changes the status, so
  the identity provider vouching for somebody does not bring them back (see
  "Deactivating a user"). The status is read again on the row the upsert
  returns: a user deactivated between the first read and the upsert is
  refused with the same code, before any group is synced.
- **Groups sync** (`syncIdpGroups` → `GroupsRepo.syncIdpMemberships(userId,
names)`): one store transaction creates the missing groups (source `idp`),
  adds the claimed memberships and removes the IdP-sourced ones the user no
  longer claims. A membership change is an authorization change, so it is
  applied whole or not at all: a failure leaves the previous memberships. A
  claimed name that already exists as a **local** group is skipped (returned
  in `skipped`, logged as a warning), never granted. Emptied IdP groups keep
  their row (they may own connections).
- **Membership settlement.** `completeLogin` calls the optional
  `LoginDeps.membershipsChanging(user)` before the group sync, and the
  function it returns once the memberships are replaced. The root wires
  `MembershipSettler.watch(user.id)` → `settle(user.id)` (handbook
  [authority](authority.md)): a connection left without owner turns
  `unowned`, and the user's missions that a lost membership orphaned, or a
  regained one grounds again, are audited. A failure of either call is
  logged at `error` (`could not settle the memberships changed by a
sign-in`) and does not fail the sign-in: every authority check reads the
  new memberships anyway.
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

| Key            | Record                                                                                       | TTL                | Cookie               |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------ | -------------------- |
| `session:<id>` | `{kind:'user', userId, login:{email, groups}, createdAt}` or `{kind:'bootstrap', createdAt}` | 8 h, absolute      | `__Host-vbn_session` |
| `login:<id>`   | `{state, nonce, codeVerifier, returnTo, createdAt}`                                          | 10 min, single use | `__Host-vbn_login`   |

Ids are 32 random bytes base64url; cookies are `Path=/; Max-Age=<ttl>;
HttpOnly; Secure; SameSite=Lax` (the public URL is always https), with no
`Domain` attribute. Both names (`SESSION_COOKIE`, `LOGIN_COOKIE`) carry the
`__Host-` prefix (`HOST_PREFIX`): a browser accepts such a cookie only when it
is `Secure`, on `Path=/`, without `Domain` and set by the host itself, so a
sibling subdomain cannot plant one. `serializeCookie` and `clearCookie` throw
a `RangeError` for a `__Host-` name on another path instead of emitting a
cookie the browser would drop (ADR
[sign-in-hardening-host-cookies-group-overage](../decisions/sign-in-hardening-host-cookies-group-overage.md)).
`readCookie` matches the name **exactly** — only the padding after the `;`
separator is dropped, never with `trim()`, which strips Unicode white space: a
browser applies the `__Host-` rules to the literal name, so
`\u00a0__Host-vbn_session` is to it an ordinary cookie a sibling subdomain may
set for the parent domain, and must not read as the session here. A name that
appears twice in the header reads as no cookie at all.
A cookie value that is not base64url is ignored. There is no sliding expiry: a
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
`removed`, when the session was created at or before the user's
`sessions_ended_at`, or when a bootstrap session outlives the token). The
port is keyed by a digest of the bearer and cannot list the sessions of one
user: a deactivation ends them through that instant on the user row, read at
the session's next request.

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
missions, requests, shares, groups, users, telemetry and OAuth
authorization-server modules:

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
handler of the nine human surfaces (`SURFACES`: auth, connections, missions,
requests, telemetry, shares, groups, users, oauth): a handler added without being classified (a
mutation with its role, or a read with the reason) fails it, and so does a
`route.ts` exporting `POST` / `PUT` / `PATCH` / `DELETE` that delegates to
anything but a classified mutation, an MCP door (execution, management) or
an OAuth protocol endpoint (`/oauth/token`, `/oauth/register`,
`/oauth/revoke`: they read no session, which the same test asserts —
handbook [management-door](management-door.md)).

## Who is behind a request

`Authenticator.authenticate(headers)` → `Principal | null`:

- `__Host-vbn_session` → bootstrap record → `{kind:'bootstrap', sessionId}` while
  the token is `active`; once it is revoked the session is deleted and `null`
  returned, on every surface (the decision is made where the principal is
  made, not by each caller);
- user record → `users.getById` (must be `active`, and the session must have
  been created after the user's `sessionsEndedAt`: the session of a `removed`
  user, and one opened at or before their last deactivation — also once they
  are active again — is deleted and `null` returned) → `currentAuthority()` →
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
- the guarded layout renders the Administration shell (`AdminShell`), the
  same 401 redirect and the note "You do not administer this gateway", which
  names the admin rule and is what a non-operator sees on a normal navigation.

`tests/unit/app/admin-guard.test.ts` discovers every `page.tsx` and
`route.ts` under `(guarded)`, so a page added without the guard fails it.

## Deactivating a user

The instance keeps no directory: a user exists once they have signed in, and
the identity provider decides who may sign in. An operator ends a user's
standing on the instance itself, without the IdP, from Settings → People
(`/admin/users`)
(ADR [operator-deactivates-a-user](../decisions/operator-deactivates-a-user.md)).
`UserAdminService` (`server/users/service.ts`, `root.users.service`) does not
authorize: its two handlers do (`guardMutation(…, 'operator')`), and pass the
actor (`auditActorId(principal)`, and the operator's own user id, `null` for
the bootstrap operator).

| Endpoint                            | Effect                                   |
| ----------------------------------- | ---------------------------------------- |
| `POST /admin/users/<id>/deactivate` | `UserAdminService.deactivate(actor, id)` |
| `POST /admin/users/<id>/reactivate` | `UserAdminService.reactivate(actor, id)` |

Both answer `303` to `/admin/users` with a one-time notice (what happened, or
the sentence of the refusal). `UserAdminError` codes: `not-found` (404),
`already-deactivated`, `not-deactivated` and `cannot-deactivate-self` (409).
An operator cannot deactivate their own account; the bootstrap operator can
deactivate anyone. A refused act writes nothing.

**`deactivate`**, in this order:

1. `MembershipSettler.watch(user.id)` is taken, then `users.markRemoved`:
   `status = 'removed'`, `removed_at` and `sessions_ended_at` = now. From
   this write on every authority check answers "holds nothing".
2. `groups.removeAllMemberships(user.id)`: the user leaves every group, local
   and IdP-sourced.
3. `DelegationService.revokeAllOf(user.id, …)` with the reason
   `user-deactivated`: every active delegation is revoked with its tokens,
   each with its own `delegation-revoked` entry in the operator's name
   (handbook [management-door](management-door.md)). Every delegation is
   tried whatever happened to the one before; the first failure is thrown
   once all were tried.
4. `MissionTeamService.revokeTokensOfDeactivated(actorId, user.id)`: the
   tokens the user generated as a **member** of other people's missions are
   revoked, each with a `mission-token-revoked` entry (reason
   `holder-deactivated`) in the operator's name. The execution door refuses
   them from step 1 already — it reads the holder's status on every call —
   and this makes it durable: reactivated, the user is still a member and
   generates a new token (handbook [missions](missions.md), "Members and
   tokens"). Their tokens on missions they **created** are left alone: those
   missions are orphaned by the derived rule and serve again, same tokens, on
   reactivation.
5. One `user-deactivated` entry (object type `user`): `before` carries
   `status: 'active'` and the email, `after` `status: 'removed'`,
   `groups_left`, `delegations_revoked` and `member_tokens_revoked`.
6. `watch.settle(actorId)`: connections nobody owns any more become
   `unowned`, and each mission of the user that read `active` gets a
   `mission-orphaned` entry (`creator-removed`) — handbook
   [authority](authority.md).

Steps 2 to 6 are each attempted whatever happened to the one before
(`attempt()` in `deactivate`): a delegation that cannot be revoked does not
keep the memberships, and an entry that cannot be written does not keep the
settlement. When a step failed, `user deactivated, but not everything they
held was closed` is logged at `error` with the number of failed steps, and
the first failure reaches the caller once all have run. Otherwise a `warn`
line `user deactivated` carries the counts. The result (`Deactivation`:
`user`, `groupsLeft`, `delegationsRevoked`, `memberTokensRevoked`,
`orphaned`, `unowned`) is what the notice says; the notice does not mention
the member tokens.

What each thing the user held becomes:

| Held                      | After deactivation                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| sign-in                   | refused with `account-deactivated`, before anything is written, although the IdP vouches                                                    |
| web sessions              | nobody at the next request (the row is deleted then); a session created at or before `sessions_ended_at` stays refused after a reactivation |
| delegations               | revoked, terminal (reason `user-deactivated`): the access token is refused on the management door, the refresh token at the token endpoint  |
| missions                  | nothing is written on them: they read `orphaned` by the derived rule and every call is `mission-inactive`                                   |
| group memberships         | removed                                                                                                                                     |
| connections owned alone   | `unowned` (a group they were the last member of, or a connection in their own name): the operator reassigns                                 |
| shares made to them       | kept; they grant nothing to a user who is not active, and no new share reaches them (`target-unknown`)                                      |
| open requests of missions | nobody can decide them; they expire on the normal delay                                                                                     |

**`reactivate`** first closes again whatever a deactivation one step of
which failed left open (`closeHeldBy`: the user's delegations, the tokens
they hold as a member, their group memberships — each a no-op when the
deactivation completed). A step that fails there stops the reactivation: the
user stays deactivated and the operator tries again. It then sets the status
back to `active` and clears `removed_at` (`users.reactivate`, which returns
`null` when the user is not `removed`), writes one `user-reactivated` entry
and settles the same way. It restores nothing else: `sessions_ended_at` stays, so a session opened before the
deactivation is not reopened; the missions whose authority still stands (a
share made to the user, a connection still theirs) serve again by the derived
rule, each with a `mission-restored` entry; IdP groups return at the next
sign-in; local groups, delegations and reassigned connections do not.

The comparison that ends a session is `session.createdAt <=
user.sessionsEndedAt` (`endedByDeactivation`, `authenticator.ts`; both are
ISO-8601 UTC instants of the same clock): a session opened in the very
millisecond of a deactivation is refused.

## Pages

- **`/login`** (where `/` sends a visitor with no session; a signed-in one
  stays on `/`, the home — `app/(app)/page.tsx`) — inside `AuthPage`
  ([web-app](web-app.md), "Pages outside the shell"): the title "Sign in to
  `<host>`", one sentence, and one button per configured IdP ("Continue with
  `<issuer host>`" → `GET /auth/login`). With no IdP it says "Sign-in is not
  set up yet" (`login-not-configured`), with the way to the bootstrap page
  while the token is active. A failed attempt shows the sentence of its code
  (`login-error`, `LOGIN_ERROR_MESSAGES`); an unknown code shows nothing.
  **A signed-in person has nothing to read here**: the page redirects them to
  the home ("Now"), and the sign-in its button starts returns there too
  (`return_to=/`) — one sign-in, then the home, with no card in between. The
  card "You are signed in" (`signed-in-as`: the display name or the email, the
  teams, what the person is here when it is more than a person, "Open the
  gateway" or "Set up sign-in", the sign-out form) is kept for the two cases
  where the home is not the answer: a failed attempt while a session exists
  (`/login?error=<code>`: the error is shown, the session is still open), and
  the install session of the bootstrap token, which owns nothing and has no
  home ("Set up sign-in" → `/admin`). The page checks nothing itself: the session is the
  authenticator's.
- **`/admin/bootstrap`** — "Set up this gateway", inside `AuthPage`: the
  token form (`POST /api/auth/bootstrap`, field `token`; the label says the
  expected shape, the hint where the value comes from), only while the state
  is `active`; otherwise a note (`bootstrap-closed`) says when the token was
  revoked (or that none exists) and points to `/login`. A refused token
  comes back as `?error=bootstrap-refused` (`bootstrap-error`); a visitor who
  already holds a
  bootstrap session is redirected to `/admin`. The page sits outside every
  layout and renders the build footer itself.
- **`/admin`** — **Setup**: a checklist (`Rows` with a `CheckMark` each) that
  says what a fresh install needs, what is done and what is left, each line
  read from the service that owns the fact: sign-in (`auth.idp.current()`),
  the public address (always done: it is the configuration's), company apps
  (`providerApps.list()`: "1/4" when some are missing, the missing ones named,
  and a "Register <service>" button that opens its form), administrators
  (who matches the rule today), telemetry (`telemetry.overview()`), and — only
  when they need someone — accounts without owner
  (`connections.service.listOwnerless()`) and apps waiting for approval
  (`oauth.clients.list()`). The heading says "n of m done" (`stepsDone`).
  Under it, **Administrators**: the rule in words with the emails it lists
  (`config.admin`), who it resolves to today (`isOperator` applied to
  `UserAdminService.list()`), what an administrator can and cannot do, and
  the state of the install token; and **This gateway**: the public address,
  the retention, the build. Both are read-only: the mounted configuration
  sets them.
  Administration is part of Settings: the application's shell and its global
  navigation, with the local navigation of Settings beside the page
  (`AdminShell`, `SettingsFrame` and `settingsNav` in `components/shell/`,
  handbook [web-app](web-app.md), "The shell"). Under "Administration" it lists
  Setup (`/admin`), Sign-in (`/admin/identity-provider`), Company apps
  (`/admin/provider-apps`, handbook [connections](connections.md)), People
  (`/admin/users`, below), Teams and Accounts without owner (`/admin/groups`,
  `/admin/connections`, handbook [authority](authority.md)), Telemetry
  (`/admin/telemetry`, handbook [telemetry](telemetry.md)) and Registered apps
  (`/admin/oauth-clients`, handbook [management-door](management-door.md)).
  A signed-in person who does not match the rule reads "You do not administer
  this gateway", with no navigation and the build footer.
- **`/admin/identity-provider`** — **Sign-in**: the settings form (`POST
/api/admin/identity-provider`: `issuer`, `client_id`, `client_secret`,
  `claim_sub`, `claim_email`, `claim_groups`, `allowed_email_domains`), each
  field saying its shape in its label; disabled when the file sets the IdP,
  with "set in the mounted configuration" beside the title. Problems come
  back as `?problem=…` and are listed in a note; `?saved=1` confirms. The
  redirect address to register at the provider is a copyable block. **Test
  the sign-in** runs the real sign-in with
  `return_to=/admin/identity-provider?tested=1` and the page then shows what
  the provider returned (email, teams, administrator yes/no) from the new
  session. Note that the tester's session replaces the install one: a tester
  who does not match the rule lands on the explanation above and signs out to
  return to the install token.
- **`/admin/users`** — **People**: everyone who has signed in, in sign-up
  order (`UserAdminService.list()`), one row each: the name with "· you ·
  admin" where it applies and the email under it, the teams, the last
  sign-in, and "deactivated <date>" on a quiet row. Row actions:
  **Deactivate**, asked first with everything it stops (`ConfirmSubmit`, then
  `POST /admin/users/<id>/deactivate`) — none on one's own row; **Reactivate**
  on a deactivated one. The notice of the last act is shown once at the top:
  the connected apps disconnected, the teams left, the missions stopped, and —
  as a warning — the accounts left without owner.

The pages of the administration are built from the design system
(`PageHeader`, `Section`, `DataTable`, `Rows`, `KeyValue`, `Callout`,
`ConfirmSubmit`) and share `components/settings/settings.module.css`; the
sign-in and bootstrap pages keep `components/auth/auth.module.css`.

## Tests

Unit, co-located under `src/server/auth/*.test.ts` (73): the guard (each
foreign-origin form refused before the session is read, same-origin Referer
accepted, 401 for nobody, the two roles, `guardSession` without the origin
step, the wording of `refusalResponse`); claim mapping (array, delimited string, absent, custom names, missing
claims named, the issuer required and not mappable, email lower-casing,
allowed domains; after a failed userinfo request, groups absent from the ID
token refused under the configured claim name, groups present in it — even
an empty list — accepted, a missing identity claim reported first, and
without a failure an absent claim read as no group; `email_verified` false
refused in its boolean and string forms and accepted when true or absent;
the group overage refused for `_claim_names` naming the configured claim, for
`hasgroups` as a boolean or a string and with a partial list next to the
pointer, a pointer for another claim and a token with no groups and no
pointer accepted); admin rule (group,
email, neither, both); origin check (match, mismatch, scheme, internal host,
Referer fallback, missing, `null`); cookies and `SessionService` (attributes,
both names under the `__Host-` prefix, a `__Host-` cookie on another path
refused, the name matched exactly — a look-alike a sibling subdomain can set
is not the session —, a name present twice read as no session, malformed
values, absolute expiry, pending login single use and TTL, a
stored record or pending sign-in of another shape read as none and deleted);
`BootstrapService` (exact token, absent, revoked durable, idempotent
revocation); `IdpSettingsService` (store round trip, sealed secret with its
associated data, blank secret keeps the stored one, the secret asked again
when the issuer changes, every problem at once,
http issuer only when allowed, one transaction (a failed write keeps the
previous settings whole), file wins and read-only); `safeReturnTo`. The
`store.webSessions` repository is covered by
`tests/integration/store/web-sessions.test.ts` (8: round trip, row keyed by
the digest and never the id, a clear-keyed row not read, TTL, sweep,
overwrite, invalid TTL, an unreadable value removed).

Unit, `tests/unit/app/admin-guard.test.ts` (63), over the real root on the
`:memory:` store with only `next/headers` replaced: `requireOperator()` with
no session (bootstrap page, then `/login` once an IdP exists), an unknown
cookie, a plain user (`notFound`), an operator, a bootstrap session before
and after the token is revoked (6); the pages and routes of the surface are
found (1); then, for each of the eight pages under `admin/(guarded)`, the
page calls `requireOperator()`, renders nothing for those three
non-operators and renders for an operator (5 each); and each of the eight
routes under it answers 401 / 403, and 401 to a revoked bootstrap session
(2 each).

Unit, `tests/unit/server/auth/mutation-guard.test.ts` (287), over the real
root on the `:memory:` store with seeded connections, a mission, an open
claim, a registered OAuth client, a delegation and an unanswered consent
screen: the completeness checks above (every handler classified; each of the
32 mutating `route.ts` files delegates to a classified mutation, an MCP door
or a protocol endpoint); the three OAuth protocol endpoints read no session
(an operator's cookie sent from another origin changes neither the answer
nor the store); then, for each of the thirty-two mutating handlers, the
rightful caller gets through (so the request is one that would be served),
and the request is refused with every table of the store unchanged for
another origin, no `Origin` and no `Referer`, a foreign `Referer` and an
opaque `Origin`; and, for the thirty that need a session (all but
`/logout` and `/api/auth/bootstrap`), for no session (401), a session of the
wrong role (a plain user on an operator endpoint, the bootstrap operator on
a user endpoint: 403) and a bootstrap session whose token was revoked (401;
only that session's row is removed).

Integration, `tests/integration/auth/oidc-login.test.ts` (22) over the real
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
operator, token still active); a sign-in whose groups the IdP moved out of
the token refused with `groups-overage`, the user's memberships kept and an
unknown user not created; a second sign-in ends the first session; an
IdP save whose audit entry cannot be written is logged at `error` and
stands; a non-form body → 400; userinfo claims merged under the ID token;
with userinfo down, a sign-in whose groups come from it refused with
`groups-unavailable` (memberships kept, nothing written) and one whose ID
token carries the groups accepted; after the operator points the instance at
another IdP the same subject is a new person, an account deactivated at one
issuer stays closed there and does not close the same subject elsewhere, and
the accounts from before the issuer was recorded are bound by the first
sign-in, all of them, once;
logout needs the origin check and deletes the row; sessions are rows of
`web_sessions` keyed by a digest.

Integration, `tests/integration/store/users-issuer.test.ts` (14), on the
store alone: the same subject at another issuer is another user, the key is
injective, an empty subject is refused; migration `0011` applied over rows of
an earlier schema keeps every row with its subject and no issuer, and an
unbound account matches no sign-in; `bindUnboundTo` binds all of them once,
a returning user finds their own account, and an account that would collide
with one already bound is left unbound.

Integration, `tests/integration/auth/deactivate-user.test.ts` (12) over the
real root with a user who holds one of everything (a web session, a
delegation with live tokens, a mission issued through it, a local-group
membership, a connection of their own): deactivation ends the session, has
the access token refused 401 on the management door and the refresh token
`invalid_grant` at the token endpoint, has the mission refused
`mission-inactive` at the execution door with nothing written on it, turns
the connection `unowned`, and audits each (`user-deactivated`,
`delegation-revoked`, `mission-orphaned`, no `mission-revoked`); the sign-in
of the deactivated user is refused `account-deactivated` although the IdP
vouches, and nothing is written; reactivation restores the mission that still
has grounds and nothing that was closed (the old session, the delegation, the
local group, the connection); the operator reassigns the deactivated owner's
connection;
a deactivation one step of which fails (the delegations cannot be revoked)
still closes everything else, writes its entry and the settlement, then
reports the failure; what it left open is closed before the user is active
again, and a reactivation that cannot close it does not happen;
an operator cannot deactivate themselves, an unknown or already
deactivated user and an active one to reactivate are refused with nothing
written; the bootstrap operator deactivates an operator; over HTTP the two
routes answer `303` to the Users page for an operator and refuse a plain
user, a foreign origin and no session.

Not automated: a browser run against a real IdP (Google, Entra ID,
Keycloak) — [e2e-tests](../tests/e2e-tests.md) describes the manual check.
