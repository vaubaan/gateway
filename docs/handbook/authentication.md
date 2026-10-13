---
title: Authentication — OIDC sign-in, web session, bootstrap token, admin rule
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/auth/
  - apps/gateway/src/server/session/
  - apps/gateway/src/lib/auth/session.ts
  - apps/gateway/src/app/auth/
  - apps/gateway/src/app/logout/route.ts
  - apps/gateway/src/app/api/auth/
  - apps/gateway/src/app/api/admin/identity-provider/route.ts
  - apps/gateway/src/app/(public)/login/page.tsx
  - apps/gateway/src/app/admin/
  - apps/gateway/src/components/auth/
  - apps/gateway/migrations/0003_web_sessions.sql
  - apps/gateway/tests/integration/auth/
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
  session-service.ts  SessionService over SessionStore: session + pending-login records, cookies
  cookies.ts          vbn_session / vbn_login: HttpOnly, Secure, SameSite=Lax
  origin.ts           isSameOrigin(headers, publicUrl) for every mutation
  login.ts            completeLogin(): users upsert, IdP group sync, bootstrap revocation; currentAuthority()
  authenticator.ts    Authenticator.authenticate(headers) → Principal; authorizeAdmin()
  handlers.ts         Request → Response handlers of the five endpoints
  errors.ts           LoginError (closed codes + UI sentences), IdpSettingsError
apps/gateway/src/server/session/
  sqlite-session-store.ts  SqliteSessionStore implements SessionStore (table web_sessions)
apps/gateway/migrations/0003_web_sessions.sql
apps/gateway/src/lib/auth/session.ts     Next glue: currentPrincipal(), adminDecision() (headers())
apps/gateway/src/app/
  (public)/login/page.tsx                /login — default entry: IdP button, account view, error codes
  auth/login/route.ts                    GET  /auth/login?return_to=
  auth/callback/route.ts                 GET  /auth/callback
  logout/route.ts                        POST /logout
  api/auth/bootstrap/route.ts            POST /api/auth/bootstrap
  api/admin/identity-provider/route.ts   POST /api/admin/identity-provider
  admin/bootstrap/page.tsx               /admin/bootstrap (outside the guard)
  admin/(guarded)/layout.tsx             the Administration guard + shell
  admin/(guarded)/page.tsx               /admin
  admin/(guarded)/identity-provider/page.tsx
apps/gateway/src/components/auth/        PrincipalCard, OperatorBadge, SignOutButton, auth.module.css
```

The route handlers are one-line adapters over `root.auth.handlers`; the pages
call `currentPrincipal()` / `adminDecision()` and render. Everything that
decides lives under `server/auth` and is tested without Next.

## The three states of an instance

| State                        | How a human gets in                                         | Who is operator                                  |
| ---------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| No IdP configured            | `/admin/bootstrap` with the `bootstrap_token` of the config | whoever holds the bootstrap token                |
| IdP configured, token active | both: bootstrap token **or** IdP sign-in                    | bootstrap holder, and any user matching the rule |
| Token revoked (or absent)    | IdP sign-in only                                            | any user matching the **admin rule**             |

The transition happens on the **first IdP sign-in of a user matching the admin
rule**: `completeLogin()` writes `bootstrap.revoked_at` into `instance_config`
(`BootstrapService.revoke()`), the token is refused from then on even if it is
still present in the configuration, and open bootstrap sessions fail their next
`authorizeAdmin()` check. A non-operator signing in first does not revoke
anything (that would lock the instance). When the IdP is set in the mounted
configuration there is no token at all (`InstanceConfig.bootstrapToken` is
`null`, state `unavailable`).

The **admin rule** is `InstanceConfig.admin` (`admin.group` and/or
`admin.emails`, required by the loader): `isOperator({ email, groupNames },
rule)` is true for a member of the named IdP group or a listed email
(lower-cased compare). It is evaluated by `currentAuthority()` from the user's
rows in `group_members` on **every** `authenticate()`, never from the session
(spec §10 "authority recomputed from current membership"; integration test
"removed from the admin group, the next check fails").

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
page). The save is audited: `AdminAuditEntry` `config-changed` on
`instance-config` / `idp`, `user_id` = the operator's user id or the literal
`bootstrap`, `before`/`after` carry issuer and client id, never the secret.

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
  mapClaims(claims, settings.claims); assertEmailDomainAllowed()
  completeLogin(): users.upsertFromIdp, syncIdpGroups, currentAuthority, bootstrap revoke
  sessions.create({kind:'user', userId, login:{email, groups}})          TTL 8 h, absolute
  303 return_to   Set-Cookie: vbn_session=<id>; …   Set-Cookie: vbn_login=; Max-Age=0
```

- `return_to` is accepted only as a same-origin absolute path
  (`safeReturnTo`: starts with `/`, not `//`, not `/\`); default `/login`.
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
  `name` becomes `displayName`. Entra ID returns group **object ids**
  unless the app registration is configured to emit names; the admin rule
  then names the object id.
- **Groups sync** (`syncIdpGroups`): every claimed name is
  `groups.getOrCreate(name, 'idp')` + `addMember`; IdP-sourced groups the
  user was in but no longer claims lose the membership (`removeMember`); a
  claimed name that already exists as a **local** group is skipped with a
  warning, never granted. Emptied IdP groups keep their row (they may own
  connections).
- **Errors** reach the browser as closed codes in `/login?error=<code>`
  (`LOGIN_ERROR_CODES`, sentences in `LOGIN_ERROR_MESSAGES`); the detail
  (IdP error, failing claim name) is logged with `warn`. State or nonce
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
session ends 8 hours after sign-in whatever the activity.

**Implementation of the port** (`server/session/sqlite-session-store.ts`):
`SqliteSessionStore` over `web_sessions(id, value_json, expires_at)`
(migration `0003`), portable SQL, ISO-8601 text expiry, expired rows swept on
every write and ignored on read. The root builds it over the store's
connection (`new SqliteSessionStore({ db: store.db })`) unless
`RootDeps.sessions` injects another implementation (Redis for a hosted
deployment, `MemorySessionStore` in unit tests). Sessions therefore survive a
restart and are revoked by deleting the row (`destroyById`, done when a
user turns `removed` or a bootstrap session outlives the token).

**Origin check.** Every mutation (`/logout`, `/api/auth/bootstrap`,
`/api/admin/identity-provider`) passes `isSameOrigin(headers, publicUrl)`:
`Origin` must equal `public_url`'s origin, `Referer`'s origin is the
fallback, neither → 403 `origin-mismatch`. The forms are plain HTML
`method="post"` forms, so browsers always send `Origin`. No `proxy.ts`
(Next middleware) is needed: the check is in the handler, where the public
origin is known from the configuration rather than from forwarded headers.

## Who is behind a request

`Authenticator.authenticate(headers)` → `Principal | null`:

- `vbn_session` → bootstrap record → `{kind:'bootstrap', sessionId}`;
- user record → `users.getById` (must be `active`; a `removed` user's
  session is deleted and `null` returned) → `currentAuthority()` →
  `{kind:'user', user, groups, isOperator, login, sessionId}`.

`authorizeAdmin(principal)` → `{ok, principal}` or `{ok:false, status: 401 |
403, reason}`: no principal → 401; bootstrap principal → ok while the token
is `active`, otherwise the session is deleted and 401; user → ok when
`isOperator`, else 403. The guarded layout turns 401 into a redirect
(`/admin/bootstrap` while bootstrap is active and no IdP is configured,
`/login` otherwise) and 403 into a "Not an operator" page that names the
admin rule; the JSON handlers answer 401/403 bodies.

## Pages

- **`/login`** (default entry; the v4 Supabase page is replaced) — one
  button per configured IdP ("Continue with `<issuer host>`" → `GET
/auth/login`), or "No identity provider is configured yet" with a link to
  the bootstrap page while the token is active. Signed in, it shows the
  `PrincipalCard`: email, groups, the **operator marker** (`OperatorBadge`:
  `Operator` / `User` / `Bootstrap operator`), the Connections link for a
  signed-in user, the Administration link for operators, and the sign-out
  form. The pages under `app/(app)/` get the v5 bar (`AppShell`) from the
  same principal (handbook [connections](connections.md), "Pages").
- **`/admin/bootstrap`** — the token form (`POST /api/auth/bootstrap`,
  field `token`), only while the state is `active`; otherwise says when it
  was revoked (or that none exists) and points to `/login`.
- **`/admin`** — issuer, source (file or Admin page), admin rule, bootstrap
  state, build. The Administration bar links Identity provider and
  Provider apps (`/admin/provider-apps`, handbook
  [connections](connections.md)).
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

Unit, co-located under `src/server/auth/*.test.ts` and `src/server/session/`
(40): claim mapping (array, delimited string, absent, custom names, missing
claims named, email lower-casing, allowed domains); admin rule (group,
email, neither, both); origin check (match, mismatch, scheme, internal host,
Referer fallback, missing, `null`); cookies and `SessionService` (attributes,
malformed values, absolute expiry, pending login single use and TTL);
`BootstrapService` (exact token, absent, revoked durable, idempotent
revocation); `IdpSettingsService` (store round trip, sealed secret with its
associated data, blank secret keeps the stored one, every problem at once,
http issuer only when allowed, file wins and read-only); `safeReturnTo`;
`SqliteSessionStore` (round trip, TTL, sweep, overwrite, invalid TTL,
durability across handles).

Integration, `tests/integration/auth/oidc-login.test.ts` (12) over the real
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
email outside the allowed domains and missing claims refused; userinfo
claims merged under the ID token; logout needs the origin check and deletes
the row; sessions are rows of `web_sessions`.

Not automated: a browser run against a real IdP (Google, Entra ID,
Keycloak) — [e2e-tests](../tests/e2e-tests.md) describes the manual check.
