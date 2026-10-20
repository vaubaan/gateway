---
title: Connections — connect flows, resources, credential refresh, OAuth clients
status: current
date: 2026-10-13
last_synced: 2026-10-20
tracks:
  - apps/gateway/src/server/connections/
  - apps/gateway/src/server/provider-apps/
  - apps/gateway/src/server/compose/shipped-plugins.ts
  - apps/gateway/src/server/store/repositories/connections.ts
  - apps/gateway/migrations/0004_connection_resource_curation.sql
  - apps/gateway/migrations/0017_connection_default_env.sql
  - apps/gateway/src/server/store/resource-env.ts
  - apps/gateway/src/app/(app)/accounts/
  - apps/gateway/src/app/(app)/connections/callback/
  - apps/gateway/src/app/(app)/layout.tsx
  - apps/gateway/src/app/admin/(guarded)/provider-apps/
  - apps/gateway/src/components/connections/
  - apps/gateway/src/app/(app)/reference/[id]/page.tsx
  - apps/gateway/src/components/shell/AppShell.tsx
  - apps/gateway/src/lib/connections/session.ts
  - apps/gateway/tests/integration/connections/
  - apps/gateway/tests/unit/server/connections/
---

# Connections — connect flows, resources, credential refresh, OAuth clients

How a user connects a provider — one way per service, the simplest the
service offers —, how the credential is stored and refreshed, how the
resources of a connection are discovered and curated, and how an
administrator declares the OAuth client of a service that signs people in
(spec [vaubaan-gateway](../spec/vaubaan-gateway.md) §0 "Connection",
"Resource"; §2.3 connection states; §4.2 Connections and Administration;
§4.3; §6 anti-replay; §7.2). Decisions:
[connect-driver-and-resource-curation](../decisions/connect-driver-and-resource-curation.md),
[plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md)
D2 (the host runs the flows and the standard refresh),
[one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md)
(one place to authorize a service; a token pasted by hand wherever the
service offers one, OAuth only where it offers none; the GitHub App, the
installation verification, the manifest flow and the second way of
connecting of earlier builds are described there). Built on the
[plugin SDK](plugin-sdk.md) (`CredentialSpec`, `discoverResources`,
`experimental`), the [store](store.md) (`connections`,
`connection_resources`, `instance_config`), the
[configuration](configuration.md) root (`providers` block, `RateLimiter`,
`SessionStore`) and [authentication](authentication.md) (web session,
`guardMutation`: origin check, session, role).

## Layout

```
apps/gateway/src/server/provider-apps/      host-agnostic, never imports `next`
  fields.ts            appConfigFieldsOf(spec): which settings the OAuth client of a service needs
  service.ts           ProviderAppsService: file-or-store values, sealed secrets, host/plugin views
apps/gateway/src/server/connections/        host-agnostic, never imports `next`
  index.ts             createConnectionsModule(deps) → root.connections; barrel
  service.ts           ConnectionService: start/complete, discover, discoverAfterCall, updateResource, revoke, transferTargets/transfer, listOwnerless/reassign, views
  discovery-after-call.ts  DiscoveryAfterCall: the discovery the gateway runs after a call that created a resource
  credentials.ts       CredentialBroker: resolve() / refresh() — the refresh persistence hook
  oauth2.ts            authorization URL, code exchange, refresh_token grant, OAuth2TokenError
  pending.ts           PendingConnectStore (single-use state), NoticeStore (one-time notices)
  notice-redirect.ts   createNoticeRedirect(): 303 to a path of the instance with a one-time ?notice=<id> (shares, local groups, reassignment)
  credential-codec.ts  serializeSecret / parseSecret: CredentialSecret ⇄ the sealed text
  ssh-keypair.ts       generateEd25519KeyPair(): OpenSSH private key + authorized_keys line
  input.ts             field validation, resolveReturnTo, env label, editable metadata lists
  mapping.ts           connectionSummaryOf(), connectionOwnerOf(): record → shown shapes
  handlers.ts          Request → Response handlers of the nine endpoints (transfer and reassign: handbook authority)
  errors.ts            ConnectError (closed codes + UI sentences), ConnectionUnavailableError,
                       ProviderUnreachableError
  testing.ts           fixturePlugin(), one spec per kind, connectionsHarness() — tests only
apps/gateway/src/server/compose/shipped-plugins.ts   SHIPPED_PLUGINS, buildShippedRegistry()
apps/gateway/migrations/0004_connection_resource_curation.sql
apps/gateway/src/lib/connections/session.ts  Next glue: currentActor(), takeNotice()
apps/gateway/src/components/
  shell/AppShell.tsx                 the shell: AppShell (the side navigation) and AdminShell (the same, with the local navigation of Settings)
  connections/parts.tsx              NoticeBanner, AccountState, ExperimentalBadge, CredentialFieldInputs
  connections/TokenGuide.tsx         steps 1 and 2 of a token connection: where to create it, the permissions to tick
  connections/OAuthClientForm.tsx    the OAuth client of a service, declared on its connect page by an administrator
  connections/RevokeConnection.tsx   client: type-to-confirm, then a plain form POST
apps/gateway/src/app/(app)/accounts/
  page.tsx                           /accounts
  new/page.tsx                       /accounts/new            "Connect an account"
  new/[provider]/page.tsx            /accounts/new/<provider>  (?connection=<id> = reconnect)
  [id]/page.tsx                      /accounts/<id>
  connect/[provider]/route.ts        POST /accounts/connect/<provider>
  [id]/discover/route.ts             POST /accounts/<id>/discover
  [id]/revoke/route.ts               POST /accounts/<id>/revoke
  [id]/resources/[resourceId]/route.ts  POST /accounts/<id>/resources/<resourceId>
  [id]/transfer/route.ts             POST /accounts/<id>/transfer          (handbook authority)
  [id]/account-view.tsx              loadAccount + AccountView: the page of one account, shared with the dialog
  [id]/account-actions.tsx           RemoveAccess, TransferOwnership (client)
  [id]/share/page.tsx                /accounts/<id>/share                  "Give access", a dialog over the account page (handbook authority)
  [id]/share/give-access-dialog.tsx  the dialog (client)
  [id]/shares/route.ts               POST /accounts/<id>/shares            → root.shares.handlers.share
  [id]/shares/[shareId]/revoke/route.ts  POST /accounts/<id>/shares/<shareId>/revoke → root.shares.handlers.revoke
apps/gateway/src/app/admin/(guarded)/connections/
  page.tsx                           /admin/connections   "Accounts without owner" (handbook authority)
  [id]/reassign/route.ts             POST /admin/connections/<id>/reassign    → connections.handlers.reassign (handbook authority)
apps/gateway/src/app/admin/(guarded)/provider-apps/
  [provider]/route.ts                POST /admin/provider-apps/<provider>   → handlers.saveProviderApp (no page: the form is on the connect page)
```

Route handlers are one-line adapters over `root.connections.handlers` (the
two share routes over `root.shares.handlers`); pages
call `currentActor()` / `requireOperator()` and render. `currentActor()` answers
`null` for the bootstrap operator, and every page under `/accounts` then renders
`NeedsUser` (`@/components/auth/NeedsUser`): a connection belongs to an
identified user. Everything that decides
is under `server/` and is tested without Next.

## The provider list

`compose/shipped-plugins.ts` imports the plugins the image ships and builds
the registry (`buildShippedRegistry`, the default `RootDeps.buildRegistry`).
The connect picker, the setup checklist, the store's catalog index and the
tool list all derive from that registry. Adding a provider = one import and
one entry in `SHIPPED_PLUGINS`, plus the dependency in
`apps/gateway/package.json` (from which `next.config.ts` derives
`transpilePackages`). `buildEmptyRegistry` remains for tests.

## The OAuth client of a service

A service that signs people in through its own authorization (`oauth2`)
needs the company's OAuth client declared once before anyone connects; a
service that takes a key needs nothing from an administrator.
`appConfigFieldsOf(spec)` (`provider-apps/fields.ts`):

| Credential kind | Fields the administrator enters                                                   |
| --------------- | --------------------------------------------------------------------------------- |
| `oauth2`        | `client_id`; `client_secret` unless `clientAuthMethod: 'none'`; `appConfigFields` |
| `api-key`       | none — each user pastes a key of their own                                        |
| `ssh-key`       | none — the instance generates the key pair                                        |

`needsProviderApp(spec)` is true when that list is not empty. Gmail is the
one shipped plugin that needs it.

`ProviderAppsService(config.providers, store.config, registry)`:

- **Sources.** A `providers.<id>` block of the mounted configuration
  (`VAUBAAN_PROVIDER_<ID>_CLIENT_ID`, `VAUBAAN_PROVIDER_<ID>_CLIENT_SECRET[_FILE]`)
  wins for the whole provider: `source: 'file'`, `isReadOnly(id)` true,
  `save()` refuses. The block is translated to the snake_case record plugins
  read by `fileAppConfig()`. Otherwise the values come from `instance_config`
  under `provider_apps.<id>.<field>`; secret fields are sealed
  (`config.setSecret`, associated data
  `instance_config:provider_apps.<id>.<field>`). A file block that lacks a
  required field is reported incomplete — it is never completed from the
  store.
- **`status(id)` / `list()`** → `ProviderAppStatus { providerId, displayName,
experimental, credentialKind, needsApp, fields, source, configured, missing,
values (non-secret only), secretsSet }`. The secret values are never
  returned.
- **`save(id, input)`** validates every field at once (`ProviderAppError.problems`:
  required, `pattern`), keeps a stored secret when the input is blank,
  removes a blank optional field; refused for a provider that needs no
  client. **`clear(id)`** deletes the stored keys of the provider.
- **`hostAppConfig(id)`** — the full record, secrets included, for the
  host's own use (OAuth client authentication, the declarative revocation);
  throws `ProviderAppNotConfigured` naming the missing fields.
- **`pluginAppConfig(id)`** — what a plugin receives as `ctx.appConfig`:
  the same record **without `client_secret`** (ADR
  plugin-contract-and-credential-spec D2: a plugin never sees the OAuth
  client secret); `{}` for a plugin that declares no OAuth client.

**Where it is declared.** On the service's own connect page,
`/accounts/new/<id>` (`connectPagePath(id)`), for an administrator
(`OAuthClientForm`): while the client is not declared the page shows, under
"Declare the OAuth client of <service>" (`data-testid="oauth-client-missing"`),
the redirect address to register at the service
(`ConnectionService.callbackUrl(id)` = `<public_url>/connections/callback/<id>`),
the fields (`CredentialFieldInputs`: secrets as password inputs, never
pre-filled; `idPrefix` `provider-app-<id>`), Save and, for store-sourced
settings, Remove; once declared, the same form sits behind the disclosure
"The OAuth client of <service>" (`data-testid="oauth-client-settings"`)
under the connect form. Anyone else reads a callout with the same test id:
an administrator declares it once, on this page. A file-sourced provider
shows the form disabled with `CONFIG_WORDS.fileReadOnly`. Settings → Setup
and the home's first-run checklist count the services whose client is
missing (`SetupView.company_apps = { registered, missing: { id, name }[] }`,
`now/setup.ts`) and link "Declare <service>" to that page; the picker leads
an administrator there too.

`POST /admin/provider-apps/<provider>` (`providerAppActionPath(id)`,
`handlers.saveProviderApp`) goes through
`guardMutation(request, deps, 'operator')` (origin, session, admin rule; the
bootstrap operator may use it), answers 400 to a body that is not a form,
reads the status before the change, applies the form's `action` —
`clear` (`CLEAR_PROVIDER_APP_ACTION`, `clearProviderApp`: refused when the
file sets the provider) or none (`storeProviderApp`: the `field.<name>`
values) — and writes one `AdminAuditEntry` `config-changed` on
`instance-config` / `provider-app:<id>` whose `before`/`after` carry the
non-secret values and the names of the secrets set (`auditView`). Its
`user_id` is `auditActorId(principal)`: the operator's user id, or
`BOOTSTRAP_ACTOR_ID` for the bootstrap operator (handbook
[authentication](authentication.md)). The entry is written after the change
is committed: when that write fails, the failure is logged at `error`
(`audit entry not written for a saved configuration change`, with `actor`
and `provider`) and the operator still gets the notice. The handler checks
that the provider is registered (`registry.has`; an unknown id gets the
`provider-unknown` notice on `/accounts/new`); a failure to read the
settings (store, configuration) propagates. Success and every refusal come
back to the connect page as a one-time notice.

## One way per service

A plugin declares its one way of connecting in `credential` (ADR
[one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md)):
the simplest the service offers — a key a person makes by hand (`api-key`)
whenever the service has one, `oauth2` only where it has none (Gmail),
`ssh-key` for a host. The host never looks for a second way.

- **What is offered.** `ConnectionService.describe` builds one
  `ConnectableProvider` per plugin: `kind`, `usesApp` (true for `oauth2`),
  `configured` (the OAuth client is declared, or none is needed), the form
  `fields`, `createUrl`, `label` (what the person creates, in the service's
  words) and the `guide` with each permission's tools as `{ name, title }`
  (`toolLabel`: the plugin's `toolTitles`, else the name).
- **What is run.** `start` runs the plugin's `credential`; `complete`
  completes a pending `oauth2` flow only. A reconnection runs the same way,
  whatever kind the stored credential has.
- **A token is checked before it is stored.** `connectWithApiKey` calls the
  spec's `verify` (`verifyPasted`): who it acts as and its expiry. An
  `UpstreamAuthError` or an answer the plugin could not read refuses with
  `credential-rejected`; a network failure is `provider-unreachable`; an
  expiry already past is refused with the date. Then the `required` first
  discovery. Stored in clear: `metadata.account`, `metadata.expires_at`,
  `credential_expires_at`; the token is sealed with the credential.
- **An account connected a way the plugin no longer offers** (the GitHub
  App, the OAuth apps of Supabase and Railway of earlier builds: its
  `metadata.credential_kind` is not the plugin's) keeps its id and its
  missions, but the execution door refuses every call on it before the
  budget (`toolUnavailableOn`, handbook [execution-door](execution-door.md):
  "this account was connected a way <service> no longer offers on this
  gateway") and `callableTools` leaves its tools out of `tools/list`, until
  its owner reconnects it from Accounts; reconnecting drops the old way's
  metadata (installation id, token account) except `discovery`. The gateway
  withdraws nothing at the provider for such an account: `canWithdraw`
  answers false for a kind the plugin does not declare, and `providerGrantOf`
  says where to remove the grant by hand.
- **Refresh and revocation.** A plugin's `refresh` override and the generic
  `refresh_token` grant serve an `oauth2` credential only: a 401 on a token
  expires the account at once. `canWithdraw(plugin, kind)`: the plugin's
  `revoke` hook, or an `oauth2` `revocation`, for the kind the plugin
  declares; a token is never withdrawn by the gateway and `providerGrantOf`
  reads `plugin.manualRevocation` (where to delete it).

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
api-key      start    readCredentialFields(spec.fields, form)  ──▶ invalid-input
                      verifyPasted(): spec.verify  ──rejected──▶ credential-rejected  ──network──▶ provider-unreachable
                      finalize(discovery: required)
ssh-key      start    readCredentialFields(); generateEd25519KeyPair('vaubaan-gateway')
                      finalize(discovery: deferred)   metadata.public_key shown on the page of the account
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
  private method per kind: `startOAuth2`, `connectWithApiKey`,
  `connectWithSshKey`. The redirect flow builds its pending record with
  `newPending`, the two form flows read their values with `readFormOrThrow`.
  **`complete`** takes the pending record and runs `completeOAuth2` when
  the plugin's way is `oauth2`; anything else is `state-invalid`.
- **`finalize`** runs the first discovery with the secret still in memory
  (`firstDiscovery`), then writes (`persist`: create or reconnect, audited),
  then records the discovery's outcome. Discovery policy per kind:

  | Policy                | Kind      | A failed discovery…                                                                        |
  | --------------------- | --------- | ------------------------------------------------------------------------------------------ |
  | `required`            | `api-key` | refuses the connection (`credential-rejected` / `provider-unreachable`); nothing is stored |
  | `best-effort`         | `oauth2`  | keeps the connection, records the error (the authorization code is spent)                  |
  | `deferred`            | `ssh-key` | is not attempted: the public key is not installed yet                                      |
  | `reject-auth-failure` | —         | refuses only on `UpstreamAuthError`; no shipped kind uses it since the GitHub App left     |

  The `detail` of the error is the provider's status in the gateway's own
  words (`providerFailureReason`, `connections/failure-reason.ts`: "the
  provider rejected the credential (HTTP 401)"), never the provider's text: a
  provider's error body can echo the credential it was given, and the detail is
  shown, logged and stored (`discovery.error`, audit). The calling agent still
  receives the provider's message on a tool call (ADR
  [provider-error-text-stays-with-the-agent](../decisions/provider-error-text-stays-with-the-agent.md)).

- **What is stored.** `connections.create({ provider, owner: {kind:'user'},
displayName, credential: serializeSecret(secret), credentialExpiresAt,
metadata })`. The credential text is the JSON `CredentialSecret`, sealed by
  the store with the connection id as associated data. `metadata_json`
  holds only clear facts: `credential_kind`, `fields` (the non-secret form
  values: team id, host, user…), `public_key` (ssh), `account` and
  `expires_at` (a checked token), and `discovery { at, ok, count, error }`. Audit: `connection-created`.
- **Reconnect.** `start(…, { reconnectId })` (the page
  `/accounts/new/<provider>?connection=<id>`) re-runs the flow of the
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
`token-exchange-failed`, `credential-rejected`,
`provider-unreachable`, `not-found`, `connection-revoked`,
`connection-unowned`, `provider-mismatch`, `label-read-only`, and the four
of ownership (handbook [authority](authority.md)): `transfer-not-member`
(403), `not-ownerless` (409), `owner-unknown`, `owner-group-empty`.
A connection of another owner is reported exactly like a missing one
(`not-found`).

### Created by the v4 importer (`importPastedKey`, `importSshKey`)

Two entries of `ConnectionService` serve only the operator's v4 import
(handbook [import-from-v4](import-from-v4.md), ADR
[import-from-v4-one-shot-importer](../decisions/import-from-v4-one-shot-importer.md)).
`importPastedKey(actor, providerId, { displayName, fields, importedFrom })`
runs the `api-key` path of the form (`connectPasted`: field check, the
plugin's `verify`, first discovery **required**, seal, `connection-created`).
`importSshKey(actor, { providerId, fields, keyPair, importedFrom })` stores an
existing key pair (`importEd25519PrivateKey` converts a PKCS#8 or OpenSSH
ed25519 key to the OpenSSH container) instead of generating one, and runs the
first discovery at once — the key is already installed, so the probe checks
the pinned host key and the pair, and a failure stores nothing. Both keep
`imported_from = { system, org, source }` in the connection's metadata,
which is how a second import run recognises them, and skip the connect rate
limit (the command is not a web request).

### Ownership

`owns(actor, connection)`: the user owner, or any group of
`actor.groups` — the groups of the principal as recomputed on this request
(spec §10 "authority recomputed from current membership"). `listFor` uses
`connections.listOwnedBy([user, ...groups])`. A connection is created
user-owned; `transfer` hands it to a group of the owner, `markOwnerlessUnowned`
turns it `unowned` when that group empties or when its owner user is
deactivated by an operator ([authentication](authentication.md),
"Deactivating a user"), and the operator's `reassign`
gives it an owner again — all three, with shares, are in
[authority](authority.md). The same `owns` check serves a user owner and a
group owner.

`ownerActRefusal(connection)` (`service.ts`) states once why a connection
takes no owner act — share, transfer, reconnect: `connection-revoked`,
`connection-unowned`, or `null` when it does. The service's refusals, the
shares service and the pages (through `transferTargets` and
`ShareContext.unshareable`) read it there. `reassignTargets()` is the
matching reading for the operator's form: the groups `reassign` would accept
as the new owner, the ones that have a member.

`reassign` holds its rule at the write. The operator only reassigns a
connection that has no owner left (spec §2.3), and that is decided by
`ConnectionsRepo.assignOwnerlessTo(id, owner)` inside one
`BEGIN IMMEDIATE` transaction: the connection must be ownerless at that
instant (`unowned`, or not revoked with an owner group that has no member or
an owner user who is not `active` — the predicate of `listOwnerless`, which
`looksOwnerless` mirrors in the service), a new owner group must have a member at
that instant, and only then is the owner written. It answers
`{ outcome: 'assigned', previous, connection }`, `not-ownerless` or
`owner-group-empty`; the service maps the last two to the `ConnectError` of
the same code. The reads the service makes before it (`getById`,
`looksOwnerless`, `resolveNewOwner`) only choose which refusal is named
first: a member who joins the owner group of an expired connection, or the
last member who leaves the new group, while the service awaits is seen by
the write, and nothing is written. The `before` of the
`connection-reassigned` entry is the owner and the status read inside that
transaction.

`revoke`, `transfer` and `reassign` watch the missions of the connection
across the act (`grounds.watchConnection` → `settle`) and settle in a
`finally`: when the audit entry of the act itself cannot be written, the
method still rejects, but the `mission-orphaned` / `mission-restored`
entries of the missions that changed are written first — the act is
committed by then, and the audit must say why those missions stopped
serving.

`mapping.ts` is the one place a `ConnectionRecord` becomes a shape shown
elsewhere: `connectionSummaryOf(record)` gives `{ id, provider,
display_name, status }`, and `connectionOwnerOf(store, record)` gives the
owner with its human name (the user's email or the group's name; `null`
when it no longer exists, each caller wording that case). `ownerLabel` of
the views uses it. The repository reads the `status` column through
`parseEnum`, so a value outside the union is an `InvariantError`, not a
silent cast.

## Connection states

| Transition            | Where                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| → `active`            | `connections.create` (connect), `connections.reconnect` (reconnect)                                                              |
| `active` → `expired`  | `connections.markExpired`, called by the broker when a refresh is rejected by the provider                                       |
| `active` → `unowned`  | `connections.markOwnerlessUnowned`, after a membership removal emptied the owner group or an operator deactivated the owner user |
| `unowned` → `active`  | `connections.assignOwnerlessTo` (the operator's reassignment; refuses a connection that has an owner)                            |
| `unowned` → `expired` | `connections.markExpired`: a dead credential stops an unowned connection too                                                     |
| `expired` → `active`  | `connections.reconnect`                                                                                                          |
| → `revoked`           | `connections.revoke`: terminal, `revoked_at` set, `credential_blob` / `key_version` set to NULL                                  |

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

The repository has no generic status or credential setter: every writer
names its transition (`reconnect`, `refreshCredential`, `markExpired`,
`markOwnerlessUnowned`, `assignOwnerlessTo`, `revoke`). A test that needs an
`unowned` connection goes through `makeUnowned(store, id)` of
`store/testing.ts`, which does what production does: an owner group without
member, then `markOwnerlessUnowned()`. The other way in — a connection whose
owner user was deactivated — is covered by
`tests/integration/auth/deactivate-user.test.ts`.
`ConnectionService.revoke` is idempotent and audited (`connection-revoked`);
it watches the missions of the connection across the act
(`grounds.watchConnection` → `settle`, handbook [authority](authority.md)).
It also withdraws the grant at the provider when the provider documents
how — see "The grant at the provider" below.
Missions that carry a `revoked` connection are `orphaned` from then on and
stay so: the execution door derives it on every request
(`MissionGrounds.inspect`, cause `connection-revoked`) and refuses every
call of the mission with `mission-inactive`. Calls on an `expired`
connection are refused with `connection-unavailable` (handbook
[execution-door](execution-door.md)) by the upstream stage, which reads the
status through `CredentialBroker.resolve` (`execution/upstream-stage.ts`).

### The grant at the provider (`credentials.ts`, `oauth2.ts`, `provider-grant.ts`)

Revoking a connection erases its credential here. The access the provider
granted — the OAuth authorization, the API key — is
another object, and it lives at the provider (spec §2.3; ADR
[provider-side-revocation-on-connection-revoke](../decisions/provider-side-revocation-on-connection-revoke.md)).

**Order.** `revoke` reads the stored credential
(`CredentialBroker.forRevocation`: as it is, no refresh, whatever the
status — an `expired` connection still holds the refresh token the
provider wants), **revokes the connection in the store**, and only then
calls `CredentialBroker.withdrawAtProvider`. The local revocation never
waits for the provider and never depends on its answer; the call is bounded
by `REVOCATION_REQUEST_TIMEOUT_MS` (10 s, plus a second of grace that cuts a
plugin `revoke` ignoring its signal) and never throws.

**How the provider is asked** — the plugin says, the host does:

| The plugin declares                                                            | Who sends                | Request                                                                                                                                |
| ------------------------------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `revoke(ctx)` on the contract                                                  | the plugin               | whatever its provider needs; it resolves when the provider confirmed and throws otherwise. Takes precedence. No shipped plugin has one |
| `credential.revocation: { url, format: 'token-form' }` (`oauth2`)              | the host (`revokeGrant`) | `POST url`, form-encoded `token=<refresh token, else access token>`, no client authentication                                          |
| `credential.revocation: { url, format: 'client-credentials-json' }` (`oauth2`) | the host                 | `POST url`, JSON `{ client_id, client_secret, refresh_token }`; nothing is sent without a stored refresh token                         |
| nothing                                                                        | nobody                   | —                                                                                                                                      |

The host sends the declarative shapes itself because one of them carries
the company's OAuth client secret, which a plugin never receives. Redirects
are refused (`redirect: 'error'`): the token goes to the declared endpoint
or nowhere. `canWithdraw(plugin)` is the one rule that says whether a
plugin has a way.

**Outcome** — `ProviderGrantOutcome`, stored in `connections.provider_grant`
(migration `0012`, written once by `recordProviderGrant`, only on a revoked
row that holds none) and written in the `connection-revoked` entry as
`after.provider_grant`:

| Outcome   | When                                                                                                                                       | What the person is told                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `revoked` | the plugin's `revoke` resolved, or the endpoint answered 2xx                                                                               | "Access withdrawn at <provider>": nothing left to remove                                       |
| `manual`  | the plugin declares no way, or the stored credential holds no token the endpoint accepts                                                   | "Still granted at <provider>", then the plugin's `manualRevocation` sentence: what to do, once |
| `failed`  | there is a way and it did not confirm: any other status, unreachable, too slow, a `revoke` that threw, a credential that could not be read | "Access NOT withdrawn at <provider>": it may still stand; then the same sentence, once         |
| `NULL`    | a connection revoked by a build that asked nothing                                                                                         | read as `manual`                                                                               |

The wording is one module, `provider-grant.ts` (`providerGrantForecast`
before the act, `providerGrantReport` after): the dialog, the notice of the
redirect (tone `warning` whenever something is left to do — the revocation
itself succeeded) and the banner of the revoked connection's page say the
same thing. What to do at the provider is said once: the plugin's sentence,
never a second "remove it by hand" around it; and the page that shows the
notice of the act does not repeat it in its own banner (it comes back on the
next visit). Log lines: `provider grant withdrawn` (`info`), `provider grant
not withdrawn` (`warn`, with the upstream status, never a token).

Which shipped provider does what:
[providers, "Revoking a connection"](providers/README.md#revoking-a-connection-what-happens-at-the-provider).

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
table), on the owner's "Refresh"
(`ConnectionService.discover` → `POST /accounts/<id>/discover`) and after a
call through the execution door that created a resource
(`ConnectionService.discoverAfterCall`, below), with a
30 s timeout. The last two share `rediscover`. On `UpstreamAuthError` the broker refreshes once and the
discovery is retried; a second rejection leaves the connection `expired`
and the provider's message in the outcome. The owner's refresh is audited
(`resources-discovered` on the connection: `ok`, `count`, `error`,
`cause: 'by-owner'`), whether it succeeded or not. A failed discovery never throws:
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
hands to `classify` / `execute`. The destructive `replaceResources` of the first store
(it deleted missing refs and cascaded to mission selections) is gone from the
repository: fixtures seed resources through `syncDiscoveredResources` too.

Owner edits (`ConnectionService.updateResource` → `POST
/accounts/<id>/resources/<resourceId>`), all validated before the first
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

### Discovery after a creating call

ADR [discovery-runs-after-a-creating-call](../decisions/discovery-runs-after-a-creating-call.md).
A plugin lists in `resourceCreatingTools` the tools whose success creates
something its discovery returns ([plugin SDK](plugin-sdk.md)): `fly__create_app`,
`railway__create-project`, `resend__create_domain`, `resend__create_segment`,
`upstash_redis__create_database`. The execution door hands every allowed call
it answered to `root.connections.discoveryAfterCall.afterCall(ctx, { tool,
connectionId, result })` ([execution door](execution-door.md), "After the
answer"); `DiscoveryAfterCall` (`discovery-after-call.ts`):

- **schedules** a discovery of the call's connection only when the tool is in
  its plugin's `resourceCreatingTools`, the result is not `isError` (a call the
  plugin declined) and the connection is the mission's connection of that
  provider. A refused, rejected or failed call never reaches it.
- **defers** the start (`setTimeout(…, 0)`): the agent's answer leaves first.
- **coalesces** per connection: one discovery in flight, at most one queued (the
  latest cause wins). `// single-process only`, like the broker's refresh lock.
- **looks again** after `DISCOVERY_AFTER_CALL_RETRY_DELAYS_MS` (2 s, then 10 s)
  when the discovery failed or added no ref, then gives up.
- **audits once** per scheduled discovery, on the last attempt's outcome:
  `resources-discovered` with `after: { ok, count, error, cause: 'after-a-call',
mission_id, tool, added, attempts }`; the actor is the member holding the
  call's key, or the mission's creator for a named key.
- **never throws**: an error is logged (`resource discovery after a creating
call failed`, with `connection_id`, `tool`, `mission_id`, `error_class` —
  never the arguments); success logs `resource discovery after a creating call`
  with `ok`, `added`, `attempts`.
- **stops** with the root (`root.close()` → `stop()`): the queued discovery is
  dropped, a retry wait is cut short, the one in flight is awaited.

`ConnectionService.discoverAfterCall(connectionId, cause)` skips a connection
that is gone, `revoked` or `expired` (`null`), counts the live refs before and
after, and runs `rediscover` — the same broker refresh, merge and
`metadata.discovery` record as the owner's "Refresh" — with
`metadata.discovery.afterCall = { missionId, tool }`. It audits nothing;
`auditDiscoveryAfterCall` writes the entry. The account page reads the record:
"Last checked … · after a call of `fly__create_app`", "Found … , after a call
of …".

### Default environment of a connection

ADR [connection-default-environment-label](../decisions/connection-default-environment-label.md).
`connections.default_env` (migration `0017`, `ConnectionRecord.defaultEnv`)
is a label the owner chose for every resource of the connection that has
none of its own — for an account whose resources appear continuously (a Fly
organization, a Railway workspace) and are all one environment.

- **One place resolves it.** Every resource read of the repository
  (`listResources`, `getResource`, the answer of `syncDiscoveredResources`)
  joins the connection (`RESOURCE_READ`) and maps the row through
  `effectiveResourceEnv` (`store/resource-env.ts`): the resource's own label
  (owner or plugin) wins; else the default, with
  `envSource: 'connection-default'`; else `null` (`envSource` `owner`).
  `ConnectionResourceRecord.env` is therefore the **effective** label, and
  every reader — issuance and its notices, the execution door's resolver,
  `list_my_connections`, the account pages, the share notes — reads it.
  `connection_resources.env` keeps the resource's own label: the default is
  never written there (`RESOURCE_ENV_SOURCES` lists the stored values only;
  `ResourceEnvSource` adds `connection-default`), so clearing the default
  hands every inheriting resource back its unlabelled state, and a new ref
  found by discovery inherits it at once.
- **The owner's act.** `ConnectionService.setDefaultEnv(actor, id, raw)` →
  `POST /accounts/<id>/default-env` (`handlers.setDefaultEnv`, a user
  mutation behind `guardMutation` like the other owner edits). `raw` goes
  through `parseEnvLabel`; blank is "none". A label must be one of
  `defaultEnvChoices(provider)` = `catalogEnvsOf(plugin.catalog)` (the
  environments of the catalog's env-scoped risks, `missions/catalog-view.ts`),
  else `invalid-input`; a revoked connection → `connection-revoked`; not the
  actor's → `not-found`. A change writes one `connection-default-env-set`
  entry on the connection, `before` / `after` `{ default_env }`; an
  unchanged value writes nothing.
- **Owner edits of a resource** compare with its own label
  (`ownResourceEnv`), not the effective one: naming the default's label on
  a resource that inherits it pins it as the resource's own, and the
  `resource-edited` entry carries the own label (`env`).

## Pages

The pages say **account** for a connection, **service** for a provider,
**access** for a share and **disconnect** for a revocation (spec
[style-guide](../spec/style-guide.md) §2); the routes, the handlers, the
stored states and the audit keep the protocol's names. Words and sentence
patterns are in `lib/vocabulary.ts` (`ACCOUNT_PAGES`, `ACCOUNT_ACTIONS`,
`ACCOUNT_WORDS`, `ACCOUNT_STATES`, `ownedBy`, `besidesOwners`, `shortDate`).

- **`/accounts`** (`accounts/page.tsx`) — three regions.
  - **Yours** (`ConnectionService.listFor`): one row per account the person
    owns, alone or through a team. Five columns: the account (the mark of
    its service, its name as a link, "GitHub · you own it with Platform"),
    what it reaches ("4 resources · 1 without an environment label", the
    second part only where a permission depends on a label and the plugin
    does not read the environment from the call), who has access ("3 besides
    owners", "only you"), the missions that run on it ("5 · 1 at its limit ·
    1 stopped", from `MissionService.onConnection`), and when it was last
    checked — replaced by the state when it is an exception (`AccountState`:
    "Needs reconnecting", "Needs an owner", "disconnected") or by "Check
    failed". A disconnected account is a quiet row.
  - **Shared with you** (`ShareService.received`, one row per account, the
    accesses to it added up): what the person may allow ("12 of 17", a link
    that unfolds the exact list under the row — `?access=<connection id>`,
    `PermissionList`), who gave it and when, the person's own running
    missions on it, its state. This region is what `/shares` was: that path
    answers with a permanent redirect. It is left out when nothing was
    shared.
  - **Connect an account**: `ServicePicker`, a grid of `PickCard`s from
    `ConnectionService.providers()` — the mark, the name and how the account
    is connected (`howToConnect`: "sign in at Gmail", "paste: fine-grained
    personal access token", "a key pair made here, installed on the host").
    A service whose OAuth client is not declared is dashed and says who to
    ask; for an administrator the card leads to the service's connect page,
    where the client is declared. The primary action of the page jumps to
    this region.
  - With no account and nothing shared the first region is one sentence
    (`EmptyState`) and the picker follows.
- **`/accounts/new`** — the same picker on a page of its own, for whoever
  arrives from the mission being written (`?return_to=` is passed on).
- **`/accounts/new/<provider>`** — the one place to authorize the service:
  the plugin's way, nothing to choose. A way with a `guide` is three steps
  (`FormStep`): **1** "Create the token at <service>" (the plugin's steps,
  the link to its token page, the expiry to choose or "gives these tokens
  no expiry"), **2** "Permissions to tick" — one row per permission name
  (`permissionLines`: "read and write" when any of its tools writes, "for"
  the titles of the tools it serves; left out when the token carries no
  permission choice — **3** "Paste it here", the form, then two sentences:
  what the gateway does with the token and why a shared service account is
  fine. The words are `TOKEN_CONNECT` (`lib/vocabulary.ts`); the steps and
  permissions are the plugin's. An `oauth2` service whose client is not
  declared shows the OAuth client section to an administrator and a callout
  to anyone else ("The OAuth client of a service" above). For the other
  ways the form is as follows, on the narrow measure: an
  optional name, then a "Continue to …" button (redirect flows) or the
  declared fields (`CredentialFieldInputs`: `field.<name>` inputs, secrets
  masked). **A field says its shape before the person types**: the label
  carries what `shapeOfPattern(field.pattern)` reads from the plugin's
  pattern ("starts with sk*test* or rk*test*", "20 characters or more",
  "digits only"; nothing when the pattern has another form), the plugin's
  `placeholder` is in the field and its `help` under it, and a field that
  may stay empty says "optional". **A form the server refused comes back as
  it was typed**: the handler stores, with the notice, the name and the
  non-secret values (`echoOfForm`, `input.ts` → `Notice.form`), and which
  field is wrong (`FieldValues.invalid`: `required`, `too-long`, `format`);
  the page fills the fields again, marks the one in error (`aria-invalid`,
  the red line) and says under it what is wrong with the shape repeated
  (`fieldErrorWords`: "This does not have the expected shape: it starts with
  sk*test* or rk*test*. A secret is never kept: type it again."). **A secret
  is never echoed**: a field declared `secret` is left out of `Notice.form`
  whatever it held, so a key exists nowhere between the two requests. The
  redirect back to the form keeps `?connection=` and `?return_to=`. The how-to is folded by default
  (`Disclosure`, remembered per kind of credential). `?connection=<id>`
  turns the page into "Reconnect".
- **`/accounts/<id>`** (`accounts/[id]/page.tsx` → `account-view.tsx`:
  `loadAccount`, `AccountView`) — for an owner; anyone else reads "not
  found".
  - **Header**: the mark, the name, the state when it is an exception, and
    one line: the service, who owns it ("owned by the Platform team (Bob,
    you)"), when it was connected and last checked. Actions: "Show details"
    (`DetailScope` `account:details`: service with the link to its
    reference, kind of credential, the non-secret fields, the last check;
    and the "Given by" and "Since" columns of the first table), "Reconnect",
    and the primary "Give access" — the last two only while
    `ShareContext.unshareable` is `null`.
  - **Notes**: needs reconnecting, no owner, the last check failed, and for
    a disconnected account one note that says it and what became of the
    access at the service (`providerGrantReport`). The note of the act
    itself carries the same sentence: on the visit that follows the
    disconnection it is said once, by the notice.
  - **Who has access** (`ShareService.holders`): the owner first ("all 15"),
    then each access — who (a person, or a team with how many people; "no
    sign-in since 20 Sep", "deactivated"), what they may allow ("12 of 15 ·
    read only", a link that unfolds the explicit list, `?access=<share id>`),
    how many of their missions run on the account. Row actions: "Transfer
    ownership" on the owner's row when `transferTargets` lists a team
    (`TransferOwnership`, a dialog with the team and the consequence), "Edit"
    and "Remove" on an access (`RemoveAccess`: `ConfirmSubmit`, which states
    how many missions stop).
  - **Resources**: the ref in mono, its name when it differs, "hidden from
    new missions", "no longer found since …"; the environment label where
    the service has environments (`EnvTag`, dashed "no label" when one is
    missing, "from the account's default" beside a label the resource
    inherits); how many running missions name it. Above the table, when the
    catalog knows environments and the account is not disconnected,
    "Default environment for unlabelled resources" (`DefaultEnvForm`: none
    or one of `defaultEnvChoices`) posts to `POST /accounts/<id>/default-env`.
    "Edit" opens the form of
    one resource under its row (`?resource=<id>`: name, environment unless
    the plugin sets it — the resource's own label, empty when it inherits
    the default —, hidden, the plugin's editable lists) which posts to
    `POST /accounts/<id>/resources/<resourceId>`. "Refresh" posts to
    `…/discover`. Ten rows, then "All N".
  - **Missions using this account** (`MissionService.onConnection`): each
    mission that runs or stopped for want of an owner — its name (a link
    when the person may open it), who created it, the resources it names,
    how many permissions, "Limit reached" or "Needs an owner" with the cause
    and **Close** (`CloseOrphanedMission`); the ones that ended are behind
    "Show the N that ended".
  - **Disconnect**, as the last line: `RevokeConnection`, a typed
    confirmation that says how many missions stop and what happens at the
    service (`providerGrantForecast`).
  - An SSH account shows its public key in a copyable block above the lists.
  - A token account: the expiry the service gave is on the header's line
    ("expires 15 Jan"), a warning appears `TOKEN_EXPIRY_NOTICE_DAYS` (14)
    ahead, and "Show details" adds "Token: acts as acme-bot · expires …".
- **`/accounts/<id>/share`** — "Give access", a dialog over the same page
  (handbook [authority](authority.md)).
- **Notices.** A handler never puts a message in a URL: it stores a
  `Notice { tone, title, lines, form? }` in the `NoticeStore` (`notice:<id>`,
  5 min, readable once, only by the web session it was written for) and
  redirects with `?notice=<id>`; the page calls `takeNotice()` and renders
  `NoticeBanner` (a `Callout`). The sentences are written in the handlers
  (`handlers.ts`, `errors.ts`, `provider-grant.ts`) in the words of the
  interface.

Two read-only queries feed these pages, both for an owner only:
`MissionService.onConnection(user, connectionId)` (every mission that carries
the connection, with its derived state, the resources of this connection it
names and how many accepted risks belong to this provider; nothing to anyone
else) and `ShareService.holders(actor, connectionId)` (the owner and every
active share with the people behind each). ADR
[owner-reads-missions-and-holders-of-a-connection](../decisions/owner-reads-missions-and-holders-of-a-connection.md).

Every mutation handler checks `isSameOrigin(headers, publicUrl)` then the
session (401 without one, 403 for the bootstrap principal on user
endpoints). The callback is a top-level GET without `Origin`; its
protection is the state bound to the user, and without a session it
redirects to `/login`.

## Tests

Unit, co-located (`src/server/connections/*.test.ts`,
`src/server/provider-apps/service.test.ts`), all on `openTestStore()` and
`mockFetch` through `connectionsHarness()`:

- `oauth2.test.ts` — authorization URL, RFC 7636 vector, the three
  client authentication methods, resource indicator, error mapping,
  rotation, a PKCE exchange without a verifier refused before any request.
- `service.test.ts` — the driver per credential kind against mocked
  provider endpoints: state replay, foreign user, crossed provider,
  foreign return URL, denial, failed exchange, rate limit, api-key
  rejection storing nothing, ssh key pair, ownership (user and group),
  reconnect (an `unowned` connection refused), revoke, the resource merge
  (owner label, name, hidden, list settings kept; stale; plugin-set label
  read-only), the default environment (catalog labels only, owner only,
  audited once, plugin label kept, pinning the default's label, cleared,
  refused when revoked), failed discovery, expiry on a rejected credential.
- `credentials.test.ts` — resolve, skew refresh with rotation and
  persistence, an `unowned` connection served, refreshed and kept `unowned`
  (also when its refresh is rejected), `expired` / `revoked` refused, single
  flight, rejected → `expired`, unreachable → still
  `active`, no refresh path, revoke race, plugin `refresh()` override.
- `token-connections.test.ts` — a token service offered at once with its
  guide and nothing to declare, a pasted token checked and stored with its
  account and expiry and never shown, a rejected or expired token storing
  nothing, an account made a way the plugin no longer offers reconnected
  with a token on the same id (and withdrawn nowhere), a token never
  refreshed, a token revocation asking nothing.
- `mapping.test.ts` — the summary, the owner's name, a vanished owner.
- `pending.test.ts`, `input.test.ts`, `codec-and-keypair.test.ts` (the
  generated key is parsed and used by `ssh2`; a stored `app-install`
  credential of an earlier build is an unknown kind),
  `shipped-providers.test.ts` (the real plugins through the driver: one way
  per service, a key offered at once, Gmail the one `oauth2` way, every
  guided token way with a label, a link, steps and a check; the grant
  withdrawn for Gmail only; a valid authorization redirect for every
  `oauth2` plugin), `provider-apps/service.test.ts` (fields per kind, the
  sources, sealed secrets, one transaction per save, every problem at once,
  the client secret kept from the plugin, the file winning and read-only,
  clear per provider).

Integration: `tests/integration/store/connections-shares.test.ts` (+3: the
default environment read on every resource and never stored, the
merge rule and the credential state transitions at the repository) and
`tests/integration/connections/connect-flow.test.ts` over `buildRoot`
with the `:memory:` store and the **real** encryptor: an administrator
declares the OAuth client → user connects → the blob and a dump of every
table are scanned for the access token, refresh token, client secret, API
key and SSH private key in clear → resources → owner edit survives a
refresh → replay refused → revoke → `revoked`, blob NULL, audit trail; an
unknown provider is reported as unknown while a failure to read the client
settings propagates and writes nothing.
`tests/unit/server/connections/provider-app-handler.test.ts`: a saved
OAuth client whose audit entry cannot be written still stands and is logged
at `error` with the actor and the provider (never the secret); the entry is
written when the audit works; a body that is not a form is 400 on
`saveProviderApp`, `connect` and `updateResource` and writes nothing. The
guard of every mutating handler is covered by
`tests/unit/server/auth/mutation-guard.test.ts` (handbook
[authentication](authentication.md)).
`tests/integration/connections/repository-status.test.ts` (6): `revoked` is
terminal for every credential and status writer (`reconnect`,
`refreshCredential`, `markExpired`, a transfer; revoking again keeps the first
date), and an `unowned` connection has its refreshed credential persisted, is
not reconnected and can still be revoked.
`tests/integration/connections/reassign-and-settle.test.ts` (5), on the real
root: a reassignment is refused `not-ownerless` when a member joined the
owner group of an expired connection between the service's check and its
write, and `owner-group-empty` when the new owner group lost its last member
meanwhile (nothing written, no entry); the `before` of
`connection-reassigned` is what the write read; `assignOwnerlessTo` writes
nothing on an owned or a revoked connection; a revocation whose own audit
entry fails still writes `mission-orphaned`. Transfer, `unowned` and the
ordinary reassignment are in `tests/integration/authority/ownership.test.ts`
(handbook [authority](authority.md)).

`tests/integration/connections/token-connect.test.ts`, on the real root
with the real GitHub plugin and GitHub mocked: a classic token refused
before GitHub is asked, a fine-grained one checked and sealed (not in any
table), a mission calls `github__list_branches` with it, a 401 expires the
account, revoking asks GitHub nothing.

Not automated: a browser run against real providers
([e2e-tests](../tests/e2e-tests.md#manual-checks-by-feature), "Manual checks
by feature", the section on connecting).

## How to debug

- **A service cannot be picked under "Connect an account"** (its card is
  dashed and says who to ask) — its OAuth client is not declared or not
  complete. Its connect page (`/accounts/new/<id>`) shows the form to an
  administrator; with a `providers.<id>` block in the mounted configuration
  the form is read-only and the block must carry every required field.
- **`state-invalid` after consent** — the flow took more than 10 minutes,
  the callback was opened twice, the user's session changed between start
  and callback (the state is bound to the user id), or the web session
  store lost the row. Look for `connect:` rows in `web_sessions`.
- **`token-exchange-failed` with `redirect_uri_mismatch`** — the redirect
  URI registered at the provider is not exactly
  `<public_url>/connections/callback/<provider>` (shown on the service's
  connect page).
- **`token-exchange-failed` with `invalid_client`** — wrong client secret,
  or the provider expects another `clientAuthMethod` than the plugin's
  spec declares.
- **A resource an agent created is not listed** — check that its tool is in the
  plugin's `resourceCreatingTools` (`resource-creating-tools.test.ts` pins the
  table), then the log lines `resource discovery after a creating call` (`added:
0` after three attempts: the provider did not list it yet — "Refresh" later)
  or `… failed` (`error_class`). A resource created outside the gateway is found
  by "Refresh" only.
- **"Connected, but looking for what it reaches failed"** — the connection
  exists; the second line of the notice is the provider's status in the
  gateway's words (the provider's own text is shown nowhere). Fix the cause
  and use "Refresh" on the page of the account.
  The log line is `resource discovery failed` (component `connections`).
- **A connection turned `expired`** — log line `credential refresh
rejected` with `failure` (the status in the gateway's words, never the
  provider's text) and `marked_expired`.
  "Reconnect" on the page of the account; the id and the missions are kept.
- **Calls fail but the connection stays `active`** —
  `ProviderUnreachableError`: the token endpoint answered 5xx, timed out,
  or the OAuth client of the service was removed (`ProviderAppNotConfigured`
  names the fields).
- **An owner's label disappeared after a refresh** — it cannot through
  `syncDiscoveredResources`, the only resource sync of the repository; check
  whether the plugin started returning `env` (`env_source = 'plugin'` then
  wins).
- **`ssh-key`: discovery refused** — the public key shown on the page of the
  account is not in `authorized_keys` of the login user, or the host key does
  not match the pinned fingerprint (the plugin's message says which).

## Extension

- **A new provider** — write the plugin, add it to `SHIPPED_PLUGINS` and
  to `apps/gateway/package.json`. No page, route or list changes: the
  forms derive from its `CredentialSpec`. Declare the simplest way the
  service offers: an `api-key` spec with its `label`, `createUrl`, `guide`
  (every tool served by a permission; `definePlugin` checks) and `verify`
  whenever a person can make a key at the service; `oauth2` only when it
  offers none. If an OAuth client needs a field the mounted configuration
  cannot express, add it to `PROVIDER_APP_FIELDS` (`config/types.ts`);
  `shipped-providers.test.ts` fails until then.
- **A new credential kind** — an ADR first (it changes the plugin
  contract), then: the variant in `credential-codec.ts`, one private method
  of `ConnectionService` with its discovery policy and its one-line case in
  `start` (and in `complete` for a redirect flow),
  `appConfigFieldsOf`, the form branch in `new/[provider]/page.tsx`.
  A kind that leaves the contract needs no migration: a stored credential of
  that kind is refused at the execution door until the account is
  reconnected.
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
  [one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md).
- Tests: [integration-tests](../tests/integration-tests.md),
  [e2e-tests](../tests/e2e-tests.md).
