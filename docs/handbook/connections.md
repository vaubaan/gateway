---
title: Connections — connect flows, resources, credential refresh, provider apps
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - apps/gateway/src/server/connections/
  - apps/gateway/src/server/provider-apps/
  - apps/gateway/src/server/compose/shipped-plugins.ts
  - apps/gateway/src/server/store/repositories/connections.ts
  - apps/gateway/migrations/0004_connection_resource_curation.sql
  - apps/gateway/src/app/(app)/connections/
  - apps/gateway/src/app/(app)/layout.tsx
  - apps/gateway/src/app/admin/(guarded)/provider-apps/
  - apps/gateway/src/components/connections/
  - apps/gateway/src/components/shell/AppShell.tsx
  - apps/gateway/src/lib/connections/session.ts
  - apps/gateway/tests/integration/connections/
  - apps/gateway/tests/unit/server/connections/
---

# Connections — connect flows, resources, credential refresh, provider apps

How a user connects a provider through the company's own app, how the
credential is stored and refreshed, how the resources of a connection are
discovered and curated, and how the operator registers the provider apps
(spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §0 "Connection",
"Resource"; §2.3 connection states; §4.2 Connections and Administration;
§4.3; §6 anti-replay; §7.2). Decisions:
[connect-driver-and-resource-curation](../decisions/connect-driver-and-resource-curation.md),
[plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md)
D2 (the host runs the four flows and the standard refresh). Built on the
[plugin SDK](plugin-sdk.md) (`CredentialSpec`, `discoverResources`,
`experimental`), the [store](store.md) (`connections`,
`connection_resources`, `instance_config`), the
[configuration](configuration.md) root (`providers` block, `RateLimiter`,
`SessionStore`) and [authentication](authentication.md) (web session,
`guardMutation`: origin check, session, role).

## Layout

```
apps/gateway/src/server/provider-apps/      host-agnostic, never imports `next`
  fields.ts            appConfigFieldsOf(spec): which settings a provider's app needs
  service.ts           ProviderAppsService: file-or-store values, sealed secrets, host/plugin views
apps/gateway/src/server/connections/        host-agnostic, never imports `next`
  index.ts             createConnectionsModule(deps) → root.connections; barrel
  service.ts           ConnectionService: start/complete, discover, updateResource, revoke, views
  credentials.ts       CredentialBroker: resolve() / refresh() — the refresh persistence hook
  oauth2.ts            authorization URL, code exchange, refresh_token grant, OAuth2TokenError
  install-verification.ts  verifyInstallation(): binds an app installation to the authorizing user
  pending.ts           PendingConnectStore (single-use state), NoticeStore (one-time notices)
  credential-codec.ts  serializeSecret / parseSecret: CredentialSecret ⇄ the sealed text
  ssh-keypair.ts       generateEd25519KeyPair(): OpenSSH private key + authorized_keys line
  input.ts             field validation, resolveReturnTo, env label, editable metadata lists
  mapping.ts           connectionSummaryOf(), connectionOwnerOf(): record → shown shapes
  handlers.ts          Request → Response handlers of the six endpoints
  errors.ts            ConnectError (closed codes + UI sentences), ConnectionUnavailableError,
                       ProviderUnreachableError
  testing.ts           fixturePlugin(), one spec per kind, connectionsHarness() — tests only
apps/gateway/src/server/compose/shipped-plugins.ts   SHIPPED_PLUGINS, buildShippedRegistry()
apps/gateway/migrations/0004_connection_resource_curation.sql
apps/gateway/src/lib/connections/session.ts  Next glue: currentActor(), takeNotice()
apps/gateway/src/components/
  shell/AppShell.tsx                 the v5 bar; APP_NAV is the list of cardinal pages
  connections/parts.tsx              NoticeBanner, StateBadge, ExperimentalBadge, CredentialFieldInputs
  connections/RevokeConnection.tsx   client: type-to-confirm, then a plain form POST
apps/gateway/src/app/(app)/connections/
  page.tsx                           /connections
  new/page.tsx                       /connections/new            "Connect a provider"
  new/[provider]/page.tsx            /connections/new/<provider>  (?connection=<id> = reconnect)
  [id]/page.tsx                      /connections/<id>
  connect/[provider]/route.ts        POST /connections/connect/<provider>
  callback/[provider]/route.ts       GET  /connections/callback/<provider>
  [id]/discover/route.ts             POST /connections/<id>/discover
  [id]/revoke/route.ts               POST /connections/<id>/revoke
  [id]/resources/[resourceId]/route.ts  POST /connections/<id>/resources/<resourceId>
apps/gateway/src/app/admin/(guarded)/provider-apps/
  page.tsx                           /admin/provider-apps
  [provider]/route.ts                POST /admin/provider-apps/<provider>
```

Route handlers are one-line adapters over `root.connections.handlers`; pages
call `currentActor()` / `adminDecision()` and render. `currentActor()` answers
`null` for the bootstrap operator, and every Connections page then renders
`NeedsUser` (`@/components/auth/NeedsUser`): a connection belongs to an
identified user. Everything that decides
is under `server/` and is tested without Next.

## The provider list

`compose/shipped-plugins.ts` imports the plugins the image ships and builds
the registry (`buildShippedRegistry`, the default `RootDeps.buildRegistry`).
The connect picker, Admin → Provider apps, the store's catalog index and the
tool list all derive from that registry. Adding a provider = one import and
one entry in `SHIPPED_PLUGINS`, plus the dependency in
`apps/gateway/package.json` (from which `next.config.ts` derives
`transpilePackages`). `buildEmptyRegistry` remains for tests.

## Provider apps

`appConfigFieldsOf(spec)` (`provider-apps/fields.ts`):

| Credential kind | Fields the operator enters                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `oauth2`        | `client_id`; `client_secret` unless `clientAuthMethod: 'none'`; `appConfigFields`                          |
| `app-install`   | the plugin's `appConfigFields` (GitHub: `app_id`, `private_key`, `app_slug`, `client_id`, `client_secret`) |
| `api-key`       | none — each user pastes a key of their own                                                                 |
| `ssh-key`       | none — the instance generates the key pair                                                                 |

`ProviderAppsService(config.providers, store.config, registry)`:

- **Sources.** A `providers.<id>` block of the mounted configuration
  (`VAUBAAN_PROVIDER_<ID>_<FIELD>`) wins for the whole provider: `source:
'file'`, `isReadOnly(id)` true, `save()` refuses. The block is translated
  to the snake_case record plugins read by `fileAppConfig()`. Otherwise the
  values come from `instance_config` under `provider_apps.<id>.<field>`;
  secret fields are sealed (`config.setSecret`, associated data
  `instance_config:provider_apps.<id>.<field>`). A file block that lacks a
  required field is reported `incomplete` — it is never completed from the
  store.
- **`status(id)` / `list()`** → `ProviderAppStatus { needsApp, fields,
source, configured, missing, values (non-secret only), secretsSet,
installVerification }`. The secret values are never returned.
- **`save(id, input)`** validates every field at once (`ProviderAppError.problems`:
  required, `pattern`), keeps a stored secret when the input is blank,
  removes a blank optional field. **`clear(id)`** deletes the stored keys.
- **`hostAppConfig(id)`** — the full record, secrets included, for the
  host's own use (OAuth client authentication, `installUrl(appConfig)`);
  throws `ProviderAppNotConfigured` naming the missing fields.
- **`pluginAppConfig(id)`** — what a plugin receives as `ctx.appConfig`:
  the same record **without `client_secret`**, whatever the kind (the
  OAuth client of an `oauth2` provider, and the one an `app-install`
  provider uses to verify installations); an `app-install` plugin keeps
  every other field (it mints installation tokens from the private key);
  `{}` when no app exists.
- **`installVerification(id)`** → `'verified'` (the plugin's `app-install`
  spec declares `userVerification`), `'unverified-refused'` (it does not —
  the default: nobody can connect the provider), `'unverified-accepted'`
  (it does not and the operator accepted that), or `null` for the other
  kinds. **`setAcceptUnverifiedInstallations(id, accept)`** writes the
  operator's decision under
  `provider_app_flags.<id>.accept_unverified_installations` (`'true'` or
  absent). It is refused for a provider that verifies — the flag never
  weakens a verification that exists — and it is not a field of the app:
  it lives in the store whatever the source of the fields, and `clear(id)`
  removes it.

The page `/admin/provider-apps` shows one card per provider that needs an
app: state badge (`configured`, `not configured`, `incomplete: …`, `set by
the mounted configuration`), the URL to register at the provider
(`ConnectionService.callbackUrl(id)` = `<public_url>/connections/callback/<id>`
— OAuth redirect URI; for an installed app, the callback URL of its user
authorization when installations are verified, its setup URL otherwise),
the fields
(`CredentialFieldInputs`: secrets as password inputs, PEM-like secrets as a
textarea, never pre-filled; its required `idPrefix` binds each label to its
input and must be unique on the page, so each provider's list gets its own), Save, and Remove for store-sourced settings.
`POST /admin/provider-apps/<provider>` (`handlers.saveProviderApp`) goes
through `guardMutation(request, deps, 'operator')` (origin, session, admin
rule; the bootstrap operator may use it), answers 400 to a body that is not a
form, and writes an `AdminAuditEntry` `config-changed` on `instance-config` /
`provider-app:<id>` whose `before`/`after` carry the non-secret values, the
names of the secrets set and, for an installed app, `install_verification`.
Its `user_id` is `auditActorId(principal)`: the operator's user id, or
`BOOTSTRAP_ACTOR_ID` for the bootstrap operator (shown as
`BOOTSTRAP_ACTOR_LABEL` in the audit view's `actor.label`; handbook
[authentication](authentication.md)).

The handler itself only authorizes, checks that the provider is registered
(`registry.has`; an unknown id gets the `provider-unknown` notice) and reads
the settings before the change. A failure to read them (store,
configuration) is not reported as an unknown provider: it propagates. The
form's `action` then picks one of three helpers, each returning the new
status and the notice — `setInstallAcceptance` (`accept-unverified` /
`refuse-unverified`), `clearProviderApp` (`clear`), `storeProviderApp`
(no action) — and `auditProviderApp` writes the one `config-changed` entry
for all of them. The entry is written after the change is committed: when
that write fails, the failure is logged at `error` (`audit entry not written
for a saved configuration change`, with `actor` = `auditActorId(principal)`
and `provider`) and the operator still gets the notice of the saved change,
as for the IdP settings.

An installed app also shows how its installations are bound to the
connecting user: the badge `installations verified`, or — for a plugin
without `userVerification` — the badge `installations refused:
unverifiable` and a warning banner with its own form (outside
the fields' fieldset, so it works for a file-sourced provider too) whose
button posts `action=accept-unverified` / `action=refuse-unverified` to the
same endpoint. Accepting is audited (`config-changed`), logged at `warn`
and answered with a warning notice; the badge then reads `unverified
installations accepted`. No shipped plugin needs it
(`shipped-providers.test.ts` fails if one does).

## The connect driver

`ConnectionService.start(actor, providerId, input)` and
`complete(actor, providerId, query)`. `actor` is `{ user, groups }` from the
current `UserPrincipal` (`actorOf`); the bootstrap operator cannot connect.
Both pass the per-user rate limit first (`RateLimiter.take('connect:<userId>',
CONNECT_RATE_LIMIT = 10, CONNECT_RATE_WINDOW_MS = 60 s)` → `rate-limited`).

```
oauth2       start    oauthClient() from hostAppConfig ──none──▶ app-not-configured
                      pending.create({kind, providerId, userId, codeVerifier, redirectUri,
                                      returnTo, reconnectId})  → state   (TTL 10 min)
                      303 <authorizationUrl>?response_type=code&client_id&redirect_uri=
                          <public_url>/connections/callback/<id>&scope&state
                          [&code_challenge&code_challenge_method=S256] [&resource] [extras]
             complete pending.take(state, userId)  ──none / other provider──▶ state-invalid
                      ?error=…                      ──▶ provider-denied (state already consumed)
                      exchangeCode(): POST tokenUrl, grant_type=authorization_code, code,
                          redirect_uri, code_verifier, [resource]; client auth per clientAuthMethod
                      ──rejected──▶ token-exchange-failed   ──5xx / network──▶ provider-unreachable
                      finalize(discovery: best-effort)
app-install  start    no userVerification and not accepted ──▶ installation-unverifiable
                      installUrl(hostAppConfig) + ?state=<state>
             complete take(state); query[installationIdParam] must match ^[A-Za-z0-9_-]{1,64}$
                      ──absent / malformed──▶ provider-denied
                      bindInstallation(): see "Installation binding"
                      ──refused──▶ installation-not-verified / token-exchange-failed (audited)
                      ──5xx / network──▶ provider-unreachable
                      finalize(discovery: reject-auth-failure)
api-key      start    readCredentialFields(spec.fields, form)  ──▶ invalid-input
                      finalize(discovery: required)
ssh-key      start    readCredentialFields(); generateEd25519KeyPair('vaubaan-gateway')
                      finalize(discovery: deferred)   metadata.public_key shown on the detail page
```

- **Single-use state** (`pending.ts`). The `state` is 32 random bytes and is
  the key of the pending record in the root's `SessionStore`
  (`connect:<state>`). `take()` deletes the record whether or not the caller
  is its owner and returns it only to the user who started the flow, so a
  replayed, forged, expired or cross-session callback gets `state-invalid`,
  and a state minted for one provider does not complete another's callback.
  An in-process `taking` set makes get-then-delete atomic (`// single-process
only`; a hosted `SessionStore` needs an atomic get-and-delete).
- **Return URL** (`resolveReturnTo`). `return_to` is parsed with the WHATWG
  URL parser against `public_url` and accepted only when its origin is the
  public origin; the stored value is the path. Anything else is refused
  with `return-url-refused` (not silently defaulted). The redirect URI sent
  to the provider is always built from `config.publicUrl`, never from the
  request's host.
- **OAuth client** (`oauth2.ts`). `client_secret_basic` sends `Authorization:
Basic` with form-encoded id and secret (RFC 6749 §2.3.1),
  `client_secret_post` puts both in the body, `none` sends `client_id` only.
  `resourceIndicator` goes on the authorization request and on every token
  request. `extraAuthorizationParams` cannot override the parameters the
  host sets. The token response gives `accessToken`, `refreshToken`,
  `expiresAt` (from `expires_in`), `scopes` (space- or comma-delimited;
  the spec's scopes when absent). An `error` member under HTTP 200 is an
  error. `OAuth2TokenError.rejected` separates a dead grant (400/401/403 or
  an `invalid_grant`-class code) from a transient failure (5xx, network,
  15 s timeout). Messages carry the provider's `error` /
  `error_description`, never a credential.
- **`start`** resolves what every kind needs once (`FlowStart`: actor,
  plugin, display name, return path, reconnect target) and dispatches to one
  private method per kind: `startOAuth2`, `startAppInstall`,
  `connectWithApiKey`, `connectWithSshKey`. The two redirect flows build
  their pending record with `newPending`, the two form flows read their
  values with `readFormOrThrow`. **`complete`** takes the pending record and
  dispatches to `completeOAuth2` / `completeAppInstall`.
- **`finalize`** runs the first discovery with the secret still in memory
  (`firstDiscovery`), then writes (`persist`: create or reconnect, audited),
  then records the discovery's outcome. Discovery policy per kind:

  | Policy                | Kind          | A failed discovery…                                                                        |
  | --------------------- | ------------- | ------------------------------------------------------------------------------------------ |
  | `required`            | `api-key`     | refuses the connection (`credential-rejected` / `provider-unreachable`); nothing is stored |
  | `reject-auth-failure` | `app-install` | refuses it only on `UpstreamAuthError` (an installation the app cannot reach)              |
  | `best-effort`         | `oauth2`      | keeps the connection, records the error (the authorization code is spent)                  |
  | `deferred`            | `ssh-key`     | is not attempted: the public key is not installed yet                                      |

  The provider's own message is the `detail` of the error (Resend answers
  that a sending-only key cannot list domains; the user reads exactly that).

- **What is stored.** `connections.create({ provider, owner: {kind:'user'},
displayName, credential: serializeSecret(secret), credentialExpiresAt,
metadata })`. The credential text is the JSON `CredentialSecret`, sealed by
  the store with the connection id as associated data. `metadata_json`
  holds only clear facts: `credential_kind`, `fields` (the non-secret form
  values: team id, host, user…), `public_key` (ssh), `installation_id`,
  and `discovery { at, ok, count, error }`. Audit: `connection-created`.
- **Reconnect.** `start(…, { reconnectId })` (the page
  `/connections/new/<provider>?connection=<id>`) re-runs the flow of the
  same provider for a connection the actor owns and ends with
  `connections.reconnect()` — new credential, status `active`, same id, so
  missions keep working. Refused for a `revoked` connection
  (`connection-revoked`), for an `unowned` one (`connection-unowned`: spec
  §2.3, nobody reconnects it until an owner is reassigned) and for another
  provider (`provider-mismatch`). Ownership and status are checked at start
  and again when a redirect flow completes.
  Reconnecting an `ssh-key` connection generates a new pair. Audit:
  `connection-reconnected`.

`ConnectError` codes (`errors.ts`, sentences in `CONNECT_ERROR_MESSAGES`):
`provider-unknown`, `app-not-configured`, `invalid-input`,
`return-url-refused`, `rate-limited`, `state-invalid`, `provider-denied`,
`token-exchange-failed`, `installation-not-verified` (403),
`installation-unverifiable` (409), `credential-rejected`,
`provider-unreachable`, `not-found`, `connection-revoked`,
`connection-unowned`, `provider-mismatch`, `label-read-only`.
A connection of another owner is reported exactly like a missing one
(`not-found`).

### Installation binding (`app-install`)

A valid `state` proves who started the flow, not which installation they
may claim: the installation id of the callback is a query parameter the
browser controls. `ConnectionService.bindInstallation` therefore runs
before `finalize`, hence before the plugin is asked to mint a token for the
claimed id (ADR connect-driver-and-resource-curation, amendment of
2026-10-13).

**The plugin declares `userVerification`** (`AppInstallUserVerification`,
[plugin SDK](plugin-sdk.md); GitHub does). The provider's app is set to ask
the installing user to authorize it, so the callback carries an
authorization code next to the installation id.
`verifyInstallation(verification, client, { installationId, code }, io)`
(`install-verification.ts`):

1. `exchangeUnsolicitedCode()` (`oauth2.ts`) — `POST tokenUrl` with
   `grant_type=authorization_code`, the code and the app's `client_id` /
   `client_secret` per `clientAuthMethod`. No `redirect_uri` and no PKCE
   verifier: the provider started that authorization itself, the host sent
   neither.
2. `GET installationsUrl` with `Authorization: Bearer <user token>` and the
   spec's `installationsHeaders` (which can never replace `Authorization`),
   page by page when `pagination` is declared (`perPageParam`, `pageParam`
   from 1), reading `installationsListField` (or the body itself) and
   `installationIdField` of each item, compared as strings.
3. The id is in the list → resolved. A page shorter than `perPage` without
   it, or `MAX_INSTALLATION_PAGES` (20) full pages without it → refused.

The user token is a local of that function: it is not returned, stored,
logged or put in an error message, and the plugin never receives it (nor
the client secret). The connection's metadata records
`installation_verification: 'user-authorization'`.

| Outcome                                                                          | `ConnectError`              | Audited (`reason`)            |
| -------------------------------------------------------------------------------- | --------------------------- | ----------------------------- |
| no code in the callback (or `?error=` from the provider)                         | `installation-not-verified` | `no-authorization-code`       |
| token endpoint refuses the code (4xx, or an `error` under 200)                   | `token-exchange-failed`     | `authorization-code-rejected` |
| installations endpoint answers 401 / 403                                         | `installation-not-verified` | `installations-list-rejected` |
| the id is not in the list                                                        | `installation-not-verified` | `installation-not-listed`     |
| any other non-2xx, network, timeout (15 s), a body that is not the declared list | `provider-unreachable`      | no — the user retries         |

A refusal stores nothing, writes an `AdminAuditEntry` `connection-refused`
(object `connection` / the reconnect target, or `not-created:<provider>`;
`after: { provider, reason, installation_id, reconnect }`) and logs
`connection refused: installation not bound to the user` at `warn`. A
reconnection goes through the same check.

**The plugin declares none.** `start` and `complete` both refuse with
`installation-unverifiable` (the second is audited with
`verification-not-supported`: the operator may withdraw the acceptance
while a user is at the provider) unless
`providerApps.installVerification(id)` is `'unverified-accepted'`. Such a
provider is also `configured: false` on the picker. When accepted, the
connection is created as before P1.4b, with
`installation_verification: 'none'` in its metadata and a `warn` log line.

What the check proves: the account that authorized the app can reach the
installation (for GitHub, `GET /user/installations` lists the installations
the user has explicit read, write or admin access to through at least one
repository). It does not prove that this account administers it.

### Ownership

`owns(actor, connection)`: the user owner, or any group of
`actor.groups` — the groups of the principal as recomputed on this request
(spec §10 "authority recomputed from current membership"). `listFor` uses
`connections.listOwnedBy([user, ...groups])`. A connection is created
user-owned; `transfer` hands it to a group of the owner, `markOwnerlessUnowned`
turns it `unowned` when that group empties, and the operator's `reassign`
gives it an owner again — all three, with shares, are in
[authority](authority.md). The same `owns` check serves a user owner and a
group owner.

`mapping.ts` is the one place a `ConnectionRecord` becomes a shape shown
elsewhere: `connectionSummaryOf(record)` gives `{ id, provider,
display_name, status }`, and `connectionOwnerOf(store, record)` gives the
owner with its human name (the user's email or the group's name; `null`
when it no longer exists, each caller wording that case). `ownerLabel` of
the views uses it. The repository reads the `status` column through
`parseEnum`, so a value outside the union is an `InvariantError`, not a
silent cast.

## Connection states

| Transition            | Where                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| → `active`            | `connections.create` (connect), `connections.reconnect` (reconnect)                             |
| `active` → `expired`  | `connections.markExpired`, called by the broker when a refresh is rejected by the provider      |
| `active` → `unowned`  | `connections.markOwnerlessUnowned`, after a membership removal emptied the owner group          |
| `unowned` → `active`  | `connections.assignOwner` (the operator's reassignment)                                         |
| `unowned` → `expired` | `connections.markExpired`: a dead credential stops an unowned connection too                    |
| `expired` → `active`  | `connections.reconnect`                                                                         |
| → `revoked`           | `connections.revoke`: terminal, `revoked_at` set, `credential_blob` / `key_version` set to NULL |

Which statuses serve calls is decided in one place,
`isUnavailableConnectionStatus` of `@vaubaan/gateway-core`: `expired` and
`revoked` do not, `active` and `unowned` do (spec §2.3: the missions of an
unowned connection keep running). The broker and the repository both use
it:

| Status    | Broker `resolve` / `refresh` | `refreshCredential` | `reconnect`                    | `markExpired` |
| --------- | ---------------------------- | ------------------- | ------------------------------ | ------------- |
| `active`  | serves                       | written             | written                        | → `expired`   |
| `unowned` | serves                       | written, stays so   | refused (`connection-unowned`) | → `expired`   |
| `expired` | `ConnectionUnavailableError` | not written         | written, → `active`            | no effect     |
| `revoked` | `ConnectionUnavailableError` | not written         | refused (`connection-revoked`) | no effect     |

All three are conditional updates (`refreshCredential` and `markExpired`:
the serving statuses; `reconnect`: `active` or `expired`), so a refresh or a
late callback racing a revocation never brings a revoked connection back. An
`unowned` connection whose refresh is rejected becomes `expired` like any
other (ADR orphaned-missions-and-ownerless-connections §3); it stays in the
operator's list of ownerless connections, and its new owner reconnects it.

`setCredential` and `setStatus` are deprecated leftovers of P0.3 with no
production caller; they refuse (`InvariantError`) to take a connection out
of `revoked`. `setStatus` is what older test fixtures use to produce `unowned`;
`setCredential` is only called by the test that proves this refusal.
`ConnectionService.revoke` is idempotent and audited (`connection-revoked`).
It does not withdraw the grant at the provider; the notice says so.
Missions on an `expired` or `revoked` connection are refused by the
execution door (`connection-unavailable`; handbook
[execution-door](execution-door.md)), which reads the status through
`CredentialBroker.resolve` (`execution/upstream-stage.ts`).

## Credentials and refresh — `CredentialBroker`

`root.connections.credentials`. The one place a stored credential becomes
a `CredentialSecret`, and the refresh persistence hook for every caller
(discovery here, the upstream stage of the execution door):

```ts
const resolved = await root.connections.credentials.resolve(connectionId);
// { connection, plugin, credential (decrypted), appConfig (no OAuth client secret) }
try {
  await resolved.plugin.execute({ ...broker.contextOf(resolved), resources }, tool, args);
} catch (err) {
  if (!(err instanceof UpstreamAuthError)) throw err;
  const again = await root.connections.credentials.refresh(connectionId); // forced
  // retry once with `again`; a second UpstreamAuthError is final
}
```

- `resolve(id)` throws `ConnectionUnavailableError { connectionStatus }`
  when the connection is `expired` or `revoked` (`missing` when it or its
  plugin is gone); an `active` or `unowned` connection is served. An
  `oauth2` access token expiring within `REFRESH_SKEW_MS` (60 s)
  is refreshed first when a refresh path exists.
- `refresh(id)` is single-flight per connection (`refreshing` map, `//
single-process only`: rotating refresh tokens are single use, a hosted
  deployment needs a lock shared by the replicas). It re-reads the stored
  credential, then:
  - the plugin declares `refresh()` → it is called with the plugin context
    (non-standard flows only);
  - else `oauth2` + `refreshable` + a stored refresh token → `refreshGrant`
    with the company's client (`oauthClient` from `hostAppConfig`), the
    `resource` indicator, and rotation: a new `refresh_token` replaces the
    old one, an absent one keeps it;
  - else (api key, ssh key, oauth2 without refresh token) → rejected.
- Outcomes: success → `connections.refreshCredential` (sealed again, status
  untouched; `false` means the connection stopped serving meanwhile
  → `ConnectionUnavailableError`). `UpstreamAuthError` from the plugin or a
  `rejected` token error → `markExpired` + `UpstreamAuthError` whose
  message names the provider and its error. Anything else (5xx, network,
  missing app configuration, a bug) → `ProviderUnreachableError`, the
  status is left alone.

## Resources

`plugin.discoverResources(ctx)` runs at connect time (see the policy
table) and on the owner's "Refresh discovery"
(`ConnectionService.discover` → `POST /connections/<id>/discover`), with a
30 s timeout. On `UpstreamAuthError` the broker refreshes once and the
discovery is retried; a second rejection leaves the connection `expired`
and the provider's message in the outcome. The owner's refresh is audited
(`resources-discovered` on the connection: `ok`, `count`, `error`), whether
it succeeded or not. A failed discovery never throws:
it is recorded in `metadata.discovery` and shown; the known resources stay
as they were. Only a connection that is `revoked` (`connection-revoked`) or
not the actor's (`not-found`) is refused before the plugin is called. Resources of another provider or without a ref are ignored
with a warning; a plugin `env` that is not a valid label
(`ENV_LABEL_PATTERN`) is dropped.

`store.connections.syncDiscoveredResources(connectionId, resources)` is the
merge (one transaction; migration `0004` added the columns):

| Field                 | New ref                         | Known ref                                                             |
| --------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `id`                  | generated                       | kept                                                                  |
| `display_name`        | from the plugin                 | from the plugin **unless** `display_name_edited` (owner renamed it)   |
| `env`                 | the plugin's, or NULL           | the plugin's when it sets one; otherwise the owner's label, untouched |
| `env_source`          | `plugin` when the plugin set it | `plugin` when the plugin sets it, else `owner`                        |
| `metadata_json`       | from the plugin                 | replaced by the plugin's (provider facts: ids, status, region)        |
| `owner_metadata_json` | NULL                            | untouched                                                             |
| `hidden`              | 0                               | untouched                                                             |
| `stale_since`         | NULL                            | cleared                                                               |

A ref the discovery no longer returns is **not deleted**: `stale_since` is
set (kept at its first value by later discoveries) and cleared when the
ref comes back. `ConnectionResourceRecord.metadata` is the effective
metadata, `{ ...discovered, ...ownerMetadata }` — what `toPluginResource()`
hands to `classify` / `execute`. The destructive `replaceResources` of P0.3
(it deleted missing refs and cascaded to mission selections) is gone from the
repository: fixtures seed resources through `syncDiscoveredResources` too.

Owner edits (`ConnectionService.updateResource` → `POST
/connections/<id>/resources/<resourceId>`), all validated before the first
write, and audited: one `resource-edited` entry on the connection with the
resource's editable fields `before` and `after` (none when the save changed
nothing; handbook [audit](audit.md)):

- `display_name` — `setResourceDisplayName`; blank hands the name back to
  discovery;
- `env` — `parseEnvLabel` then `setResourceEnv`; **refused with
  `label-read-only` when `envSource` is `plugin`** (Stripe `test` / `live`);
  submitting the unchanged label is not a violation;
- `hidden` — `setResourceHidden` (the form marks its presence with
  `hidden_present`, since an unchecked checkbox sends nothing);
- `meta.<key>` — only keys whose discovered value is a list of strings
  (`editableMetadataKeys`: Resend's `internal_domains`,
  `allowlist_domains`, `allowlist_addresses`); parsed by `parseListValue`
  (lower-cased, de-duplicated, ≤ 200 entries) into `owner_metadata_json`.
  Scalar metadata stays read-only.

`hidden` and `stale_since` are flags on the record; `listResources`
returns every row. Consumers decide: mission issuance leaves hidden and
stale resources out of "all resources", lets a creator pick a hidden one
explicitly and refuses a stale one (handbook [missions](missions.md),
"Hidden and stale resources").

## Pages

- **`/connections`** — table: name (link), provider label with the
  `experimental` badge, state badge (`active` green, `expired` / `unowned`
  amber, `revoked` neutral), owner (email or `group <name>`), date. Button
  "Connect a provider". Beside the provider label, `<ValidationBadge>`
  shows the community validation status of the plugin version the instance
  runs (`root.telemetry.stats.statusFor(provider)`, one lookup per distinct
  provider); it renders nothing unless telemetry is sending and the
  collector has statistics for that version (handbook
  [telemetry](telemetry.md)).
- **`/connections/new`** — one card per provider that is connectable now
  (`ConnectableProvider.configured`: the company app is complete, or none
  is needed), with description, credential kind and the `experimental`
  badge; the others are named in one muted line. `?return_to=` is passed
  on.
- **`/connections/new/<provider>`** — the form: optional connection name,
  then a "Continue to …" button (redirect flows) or the declared fields
  (`field.<name>` inputs, secrets masked, the plugin's `help` under each).
  Experimental providers carry a warning banner.
- **`/connections/<id>`** — state (with the same `<ValidationBadge>`), owner, credential kind, the non-secret
  fields, last discovery; the public key card for `ssh-key`; the resources
  table (ref with `stale since` badge and a folded "Settings" block for the
  editable lists, display name input, environment input or `set by the
plugin` badge, hidden checkbox, Save — inputs reach their per-row form
  through the `form` attribute); "Refresh discovery", "Reconnect", and
  "Revoke" (`RevokeConnection`: type the connection name, then a form POST).
  An `unowned` connection has no "Reconnect" action (the server refuses it,
  `connection-unowned`); the page says so instead.
- **Shell.** `app/(app)/layout.tsx` renders `AppShell` for a web session
  (`currentPrincipal()`, a user or the bootstrap operator) and redirects
  anyone else to `/login`. `APP_NAV` in `AppShell.tsx` is the list of pages
  in the bar (Connections, Missions, Requests, Audit); operators also get the
  Administration link.
- **Notices.** A handler never puts a message in a URL: it stores a
  `Notice { tone, title, lines }` in the `NoticeStore` (`notice:<id>`,
  5 min, readable once, only by the web session it was written for) and
  redirects with `?notice=<id>`; the page calls `takeNotice()`.

Every mutation handler checks `isSameOrigin(headers, publicUrl)` then the
session (401 without one, 403 for the bootstrap principal on user
endpoints). The callback is a top-level GET without `Origin`; its
protection is the state bound to the user, and without a session it
redirects to `/login`.

## Tests

Unit, co-located (`src/server/connections/*.test.ts`,
`src/server/provider-apps/service.test.ts`), all on `openTestStore()` and
`mockFetch` through `connectionsHarness()`:

- `oauth2.test.ts` (16) — authorization URL, RFC 7636 vector, the three
  client authentication methods, resource indicator, error mapping,
  rotation, a PKCE exchange without a verifier refused before any request.
- `service.test.ts` (33) — the driver per credential kind against mocked
  provider endpoints: state replay, foreign user, crossed provider,
  foreign return URL, denial, failed exchange, rate limit, the
  installation binding (id in the user's list on a second page accepted
  and the user token kept nowhere; id not in the list, missing code,
  rejected code, denied list → refused, nothing stored, audited;
  unreachable provider not audited; reconnection verified; a spec without
  `userVerification` refused unless accepted, also when the acceptance is
  withdrawn mid-flow), app-install
  rejection, api-key rejection storing nothing, ssh key pair, ownership
  (user and group), reconnect (an `unowned` connection refused), revoke, the resource merge (owner label,
  name, hidden, list settings kept; stale; plugin-set label read-only),
  failed discovery, expiry on a rejected credential.
- `credentials.test.ts` (15) — resolve, skew refresh with rotation and
  persistence, an `unowned` connection served, refreshed and kept `unowned`
  (also when its refresh is rejected), `expired` / `revoked` refused, single
  flight, rejected → `expired`, unreachable → still
  `active`, no refresh path, revoke race, plugin `refresh()` override.
- `install-verification.test.ts` (5) — bare list and Basic client
  authentication, ids as numbers or strings, malformed items, a spec header
  cannot replace `Authorization`, the page cap, refusal versus unreachable,
  no message carries the token or the client secret.
- `mapping.test.ts` (3) — the summary, the owner's name, a vanished owner.
- `pending.test.ts` (7), `input.test.ts` (23), `codec-and-keypair.test.ts`
  (12, the generated key is parsed and used by `ssh2`),
  `shipped-providers.test.ts` (5, the real plugins through the driver; no
  shipped `app-install` plugin is unverifiable),
  `provider-apps/service.test.ts` (15).

Integration: `tests/integration/store/connections-shares.test.ts` (+2: the
merge rule and the credential state transitions at the repository) and
`tests/integration/connections/connect-flow.test.ts` (6) over `buildRoot`
with the `:memory:` store and the **real** encryptor: operator registers
the app → user connects → the blob and a dump of every table are scanned
for the access token, refresh token, client secret, API key and SSH
private key in clear → resources → owner edit survives a refresh → replay
refused → revoke → `revoked`, blob NULL, audit trail. The `app-install`
path: a foreign installation id and a callback without code are refused
and audited, the rightful user connects, and **the user token, the
authorization code, the client secret and the private key are in no table
and no log line**; an unverifiable plugin is refused until the operator
accepts it through the handler (403 for a user, refused for a verifying
provider, audited); an unknown provider is reported as unknown while a
failure to read the app settings propagates and writes nothing.
`tests/unit/server/connections/provider-app-handler.test.ts` (4): a saved
provider app, and an accepted unverified installation, whose audit entry
cannot be written still stand and are logged at `error` with the actor and
the provider (never the secret); the entry is written when the audit works;
a body that is not a form is 400 on `saveProviderApp`, `connect` and
`updateResource` and writes nothing. The guard of every mutating handler is
covered by `tests/unit/server/auth/mutation-guard.test.ts` (handbook
[authentication](authentication.md)).
`tests/integration/connections/repository-status.test.ts` (9): `revoked` is
terminal through `setCredential` and `setStatus` too, and an `unowned`
connection has its refreshed credential persisted, is not reconnected and
can still be revoked.

Not automated: a browser run against real providers
([e2e-tests](../tests/e2e-tests.md#connect-a-provider-p14), "Manual checks
by feature" → "Connect a provider (P1.4)").

## How to debug

- **A provider is missing from "Connect a provider"** — its company app is
  not complete. `/admin/provider-apps` shows `incomplete: <fields>`; with a
  `providers.<id>` block in the mounted configuration the page is
  read-only and the block must carry every required field.
- **`state-invalid` after consent** — the flow took more than 10 minutes,
  the callback was opened twice, the user's session changed between start
  and callback (the state is bound to the user id), or the web session
  store lost the row. Look for `connect:` rows in `web_sessions`.
- **`token-exchange-failed` with `redirect_uri_mismatch`** — the redirect
  URI registered at the provider is not exactly
  `<public_url>/connections/callback/<provider>` (shown on
  `/admin/provider-apps`).
- **`token-exchange-failed` with `invalid_client`** — wrong client secret,
  or the provider expects another `clientAuthMethod` than the plugin's
  spec declares.
- **`installation-not-verified` with "no user authorization"** — the
  provider's app does not request user authorization during installation
  (GitHub: the checkbox "Request user authorization (OAuth) during
  installation"), or it still redirects to a setup URL instead of the
  callback URL shown on `/admin/provider-apps`. The audit entry
  `connection-refused` has `reason: no-authorization-code`.
- **`installation-not-verified` for a legitimate user** — the account that
  authorized at the provider is not the one that can reach the
  installation (signed in to the provider as someone else), or the user
  reaches more than `MAX_INSTALLATION_PAGES × perPage` installations.
  `reason: installation-not-listed`.
- **`token-exchange-failed` on an installation** — wrong `client_id` /
  `client_secret` of the app (`incorrect_client_credentials`), or the code
  expired (`bad_verification_code`; GitHub codes live ten minutes).
- **A provider vanished from "Connect a provider" after an upgrade** — its
  app lacks the fields verification needs (`incomplete: client_id,
client_secret` on `/admin/provider-apps`), or its plugin cannot verify
  installations and nobody accepted that.
- **Connected but "resource discovery failed"** — the connection exists;
  the message is the plugin's. Fix the cause and use "Refresh discovery".
  The log line is `resource discovery failed` (component `connections`).
- **A connection turned `expired`** — log line `credential refresh
rejected` with `detail` (the provider's error) and `marked_expired`.
  Reconnect from the detail page; the id and the missions are kept.
- **Calls fail but the connection stays `active`** —
  `ProviderUnreachableError`: the token endpoint answered 5xx, timed out,
  or the provider app configuration was removed (`ProviderAppNotConfigured`
  names the fields).
- **An owner's label disappeared after a refresh** — it cannot through
  `syncDiscoveredResources`, the only resource sync of the repository; check
  whether the plugin started returning `env` (`env_source = 'plugin'` then
  wins).
- **`ssh-key`: discovery refused** — the public key shown on the detail
  page is not in `authorized_keys` of the login user, or the host key does
  not match the pinned fingerprint (the plugin's message says which).

## Extension

- **A new provider** — write the plugin, add it to `SHIPPED_PLUGINS` and
  to `apps/gateway/package.json`. No page, route or list changes: the
  forms derive from its `CredentialSpec`. If its app needs a field the
  mounted configuration cannot express, add it to `PROVIDER_APP_FIELDS`
  (`config/types.ts`); `shipped-providers.test.ts` fails until then.
- **A new `app-install` provider** — declare `userVerification` in its
  spec (token endpoint, installations endpoint, response shape) and list
  `client_id` / `client_secret` in `appConfigFields`; `definePlugin` checks
  both. The driver needs no change. A provider that has no such endpoint
  ships without the block and is connectable only once the operator accepts
  unverified installations.
- **A new credential kind** — an ADR first (it changes the plugin
  contract), then: the variant in `credential-codec.ts`, one private method
  of `ConnectionService` with its discovery policy and its one-line case in
  `start` (and in `complete` for a redirect flow),
  `appConfigFieldsOf`, the form branch in `new/[provider]/page.tsx`.
- **A non-standard refresh** — the plugin implements `refresh(ctx)`; the
  broker calls it instead of the generic grant and persists the result.
- **A hosted deployment** — replace the two `// single-process only`
  guards (`PendingConnectStore.taking`, `CredentialBroker.refreshing`)
  with an atomic get-and-delete and a shared lock; everything else already
  goes through the `SessionStore`, `RateLimiter` and repository ports.

## References

- Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §2.3, §4.2, §4.3,
  §6, §7.2.
- ADRs: [connect-driver-and-resource-curation](../decisions/connect-driver-and-resource-curation.md),
  [plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md),
  [oauth-app-install-per-provider](../decisions/oauth-app-install-per-provider.md)
  (v4; the method per provider survives, the per-provider routes do not).
- Tests: [integration-tests](../tests/integration-tests.md),
  [e2e-tests](../tests/e2e-tests.md).
