---
title: Connections — connect flows, resources, credential refresh, provider apps
status: current
date: 2026-10-13
last_synced: 2026-10-14
tracks:
  - apps/gateway/src/server/connections/
  - apps/gateway/src/server/provider-apps/
  - apps/gateway/src/server/compose/shipped-plugins.ts
  - apps/gateway/src/server/store/repositories/connections.ts
  - apps/gateway/migrations/0004_connection_resource_curation.sql
  - apps/gateway/src/app/(app)/accounts/
  - apps/gateway/src/app/(app)/connections/callback/
  - apps/gateway/src/app/(app)/layout.tsx
  - apps/gateway/src/app/admin/(guarded)/provider-apps/
  - apps/gateway/src/components/connections/
  - apps/gateway/src/components/settings/AppRegistration.tsx
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
  service.ts           ProviderAppsService: file-or-store values, sealed secrets, host/plugin views,
                       saveRegistered / registration (an app created from the page)
  registration.ts      AppRegistrationService: the manifest flow (start, pending, complete)
apps/gateway/src/server/connections/        host-agnostic, never imports `next`
  index.ts             createConnectionsModule(deps) → root.connections; barrel
  service.ts           ConnectionService: start/complete, discover, updateResource, revoke, transferTargets/transfer, listOwnerless/reassign, views
  credentials.ts       CredentialBroker: resolve() / refresh() — the refresh persistence hook
  oauth2.ts            authorization URL, code exchange, refresh_token grant, OAuth2TokenError
  install-verification.ts  verifyInstallation(): binds an app installation to the authorizing user
  pending.ts           PendingConnectStore (single-use state), NoticeStore (one-time notices)
  notice-redirect.ts   createNoticeRedirect(): 303 to a path of the instance with a one-time ?notice=<id> (shares, local groups, reassignment)
  credential-codec.ts  serializeSecret / parseSecret: CredentialSecret ⇄ the sealed text
  ssh-keypair.ts       generateEd25519KeyPair(): OpenSSH private key + authorized_keys line
  input.ts             field validation, resolveReturnTo, env label, editable metadata lists
  mapping.ts           connectionSummaryOf(), connectionOwnerOf(): record → shown shapes
  handlers.ts          Request → Response handlers of the eight endpoints (transfer and reassign: handbook authority)
  errors.ts            ConnectError (closed codes + UI sentences), ConnectionUnavailableError,
                       ProviderUnreachableError
  testing.ts           fixturePlugin(), one spec per kind, connectionsHarness() — tests only
apps/gateway/src/server/compose/shipped-plugins.ts   SHIPPED_PLUGINS, buildShippedRegistry()
apps/gateway/migrations/0004_connection_resource_curation.sql
apps/gateway/src/lib/connections/session.ts  Next glue: currentActor(), takeNotice()
apps/gateway/src/components/
  shell/AppShell.tsx                 the shell: AppShell (the side navigation) and AdminShell (the same, with the local navigation of Settings)
  connections/parts.tsx              NoticeBanner, AccountState, ExperimentalBadge, CredentialFieldInputs
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
  page.tsx                           /admin/provider-apps   "Company apps"
  [provider]/route.ts                POST /admin/provider-apps/<provider>
  [provider]/create/route.ts         POST /admin/provider-apps/<provider>/create   → handlers.startAppRegistration
  [provider]/confirm/page.tsx        /admin/provider-apps/<provider>/confirm?state=…   posts the manifest to the service
  [provider]/created/route.ts        GET  /admin/provider-apps/<provider>/created  → handlers.completeAppRegistration
apps/gateway/src/components/settings/AppRegistration.tsx   AppCreateForm, RegisteredAppFacts, permissionSummary
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
The connect picker, Settings → Company apps, the store's catalog index and the
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

The page `/admin/provider-apps` (**Company apps**, in Settings) lists one row
per provider that needs an app: the service and what is registered
("registered", with the tag "set in the mounted configuration" for a
file-sourced app; "not registered"; "Incomplete: … missing"), and a
"Register" or "Edit" link that opens the form of that service under its row
(`?app=<provider id>`). The form shows the URL to register at the provider
(`ConnectionService.callbackUrl(id)` = `<public_url>/connections/callback/<id>`
— OAuth redirect URI; for an installed app, the callback URL of its user
authorization when installations are verified, its setup URL otherwise),
the fields
(`CredentialFieldInputs`: secrets as password inputs, PEM-like secrets as a
textarea, never pre-filled; its required `idPrefix` binds each label to its
input and must be unique on the page, so each provider's list gets its own), Save, Remove for store-sourced settings, and Cancel.
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
connecting user: "· installations verified" after "registered", or — for a
plugin without `userVerification` — the mark "Cannot verify installations"
and a warning note with its own form (outside
the fields' fieldset, so it works for a file-sourced provider too) whose
button posts `action=accept-unverified` / `action=refuse-unverified` to the
same endpoint. Accepting is audited (`config-changed`), logged at `warn`
and answered with a warning notice; the mark then reads "Unverified installations
accepted". No shipped plugin needs it
(`shipped-providers.test.ts` fails if one does).

### Company apps created from the page (manifest flow)

ADR [company-app-created-from-a-manifest](../decisions/company-app-created-from-a-manifest.md).
An `app-install` spec may declare `manifestRegistration` (plugin SDK,
`AppManifestRegistration`): the permissions the app may request, each with
levels and the tools that need them (`AppPermission`; the SDK's
`app-permissions.ts` reads it), the registration address per owner, the
manifest builder, the code exchange and the reader of its answer. GitHub is
the one shipped plugin that declares it (`plugins/github/src/app-manifest.ts`).

`AppRegistrationService` (`root.connections.registration`), nothing in it
naming a provider:

- **`availability(id)`** → `null` (offer it), `not-supported` (no
  manifest), `read-only` (the configuration file sets the app) or
  `already-set` (any field is stored: replacing an app is the form's job).
- **`start(actor, id, choice)`** checks the owner (organisation login against
  `ownerLoginPattern`, or the personal account), the name (required, at most
  `nameMaxLength`) and the permissions (`checkPermissionChoice`: a level per
  permission or `none`, a mandatory one kept, an unknown name or level
  refused), builds the manifest (`url` = `public_url`, `callback_urls` = the
  connection callback, `redirect_url` =
  `<public_url>/admin/provider-apps/<id>/created`, the chosen
  `default_permissions`) and stores it in the `SessionStore` under
  `app-registration:<state>` with the web session id, the audit actor and
  the choice, for `REGISTRATION_TTL_MS` (15 minutes). The state is 32 random
  bytes, base64url. Refusals are `AppRegistrationError` with a closed code and
  plain sentences.
- **`pending(sessionId, id, state)`** — the confirm page reads the record back
  (same session, same provider) without consuming it: the form's `action` is
  `registrationUrl(owner)` with `?state=`, its one hidden field the manifest
  JSON.
- **`complete(sessionId, id, query)`** — the state is taken once (deleted
  whatever happens next; refused if absent, expired, of another session or
  provider), a missing code is `cancelled`, a code outside the plugin's
  grammar `code-invalid`; availability is checked again; the code is posted
  to `conversionUrl(code)` with `conversionHeaders` and no credential
  (`redirect: 'error'`); a failed status is `exchange-refused` (only the
  status is logged), no answer `exchange-failed`, an answer the plugin cannot
  read `answer-unreadable`. The app is then stored by
  **`ProviderAppsService.saveRegistered(id, appConfig, record)`**: the same
  validation and sealing as `save`, plus the record of what the page shows —
  name, slug, owner, link, the permissions the service answered, who and when
  — as JSON under `provider_apps.<id>.registered`, in one transaction, refused
  if any field is already stored. The webhook secret is not kept. One
  `config-changed` entry on `provider-app:<id>`: `before`/`after` as a form
  save, plus `created_from: 'manifest'`, `app_name`, `app_slug`, `owner`,
  `owner_kind`, `permissions_requested` — never a secret.
- **`registration(id)`** returns that record while the stored non-secret
  fields still equal those it was created with (an app replaced by hand
  drops it); `clear(id)` removes it with the fields.

On the page, the line of such a service opens on `AppCreateForm` while
`availability` is `null`: two plain sentences (it belongs to the owner, its
key stays here encrypted, the service asks to confirm), the owner, the name
(`Vaubaan <host>` by default), and one select per permission, the default
every highest level, a sensitive permission marked "Sensitive." with its
sentence, and what stops a level down ("Read only stops: …"; per condition,
"…, for a file under .github/workflows/"), read from the plugin's tool
titles. "Enter an app registered by hand" (`?by=hand`) opens the usual form,
which links back. `POST …/create` (`guardMutation`, operator) answers 303 to
the confirm page, or back to the line with a notice. The confirm page
(`requireOperator`) shows owner, name and permissions and the button
"Continue to <service>"; an unknown or expired state shows "This creation is
no longer waiting". `GET …/created` is a top-level GET from the service
(`guardSession`, operator; no session → `/login`, not an administrator →
the Company apps page): success and every failure come back to the line
as a one-time notice. A created app's line shows `RegisteredAppFacts` — the
name linking to the app at the service, the owner, the permissions — the
primary "Install it on your repositories" (`/accounts/new/<id>`: installing
is connecting an account), and the form behind "Edit its settings by hand".

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
`token-exchange-failed`, `installation-not-verified` (403),
`installation-unverifiable` (409), `credential-rejected`,
`provider-unreachable`, `not-found`, `connection-revoked`,
`connection-unowned`, `provider-mismatch`, `label-read-only`, and the four
of ownership (handbook [authority](authority.md)): `transfer-not-member`
(403), `not-ownerless` (409), `owner-unknown`, `owner-group-empty`.
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
granted — the OAuth authorization, the installed app, the API key — is
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
table) and on the owner's "Refresh"
(`ConnectionService.discover` → `POST /accounts/<id>/discover`), with a
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
    is connected (`howToConnect`: "sign in at Supabase", "install your
    company’s GitHub app", "paste: test-mode key and live-mode key"). A
    service whose company app is not registered is dashed and says who to
    ask; for an administrator the card leads to Company apps. The primary
    action of the page jumps to this region.
  - With no account and nothing shared the first region is one sentence
    (`EmptyState`) and the picker follows.
- **`/accounts/new`** — the same picker on a page of its own, for whoever
  arrives from the mission being written (`?return_to=` is passed on).
- **`/accounts/new/<provider>`** — the form, on the narrow measure: an
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
    missing); how many running missions name it. "Edit" opens the form of
    one resource under its row (`?resource=<id>`: name, environment unless
    the plugin sets it, hidden, the plugin's editable lists) which posts to
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

- `oauth2.test.ts` (28) — authorization URL, RFC 7636 vector, the three
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
  `shipped-providers.test.ts` (7, the real plugins through the driver; no
  shipped `app-install` plugin is unverifiable),
  `provider-apps/service.test.ts` (15), `provider-apps/registration.test.ts`
  (25: the manifest per permission choice and owner, invalid choices, the
  file and already-set refusals, the state single-use, expiring and bound to
  the session, a replay and a foreign session exchanging nothing, a cancelled
  return, a malformed code, a refused, unreachable or unreadable exchange
  storing nothing, an app entered by hand meanwhile, what is stored and
  sealed, the audit entry and the logs without a secret, the record dropped
  when the app is replaced by hand).

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

Not automated: a browser run against real providers
([e2e-tests](../tests/e2e-tests.md#manual-checks-by-feature), "Manual checks
by feature", the section on connecting).

## How to debug

- **A service cannot be picked under "Connect an account"** (its card is
  dashed and says who to ask) — its company app is not complete. Settings →
  Company apps (`/admin/provider-apps`) shows "Incomplete: <fields> missing"; with a
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
- **A service can no longer be picked under "Connect an account" after an
  upgrade** — its app lacks the fields verification needs ("Incomplete:
  client_id, client_secret missing" on `/admin/provider-apps`), or its plugin cannot verify
  installations and nobody accepted that.
- **"Connected, but looking for what it reaches failed"** — the connection
  exists; the second line of the notice is the plugin's message. Fix the cause
  and use "Refresh" on the page of the account.
  The log line is `resource discovery failed` (component `connections`).
- **A connection turned `expired`** — log line `credential refresh
rejected` with `detail` (the provider's error) and `marked_expired`.
  "Reconnect" on the page of the account; the id and the missions are kept.
- **Calls fail but the connection stays `active`** —
  `ProviderUnreachableError`: the token endpoint answered 5xx, timed out,
  or the provider app configuration was removed (`ProviderAppNotConfigured`
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
