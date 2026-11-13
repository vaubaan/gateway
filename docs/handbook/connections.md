---
title: Connections
tracks:
  - apps/gateway/src/server/connections/
  - apps/gateway/src/server/compose/shipped-plugins.ts
  - apps/gateway/src/server/store/repositories/connections.ts
  - apps/gateway/src/server/store/resource-env.ts
  - apps/gateway/src/app/(app)/accounts/
  - apps/gateway/src/app/(app)/connections/callback/
  - apps/gateway/src/components/connections/
  - apps/gateway/src/server/plugins/connect-files.ts
  - apps/gateway/src/app/(app)/reference/[id]/connect/
  - apps/gateway/tests/integration/connections/
last_reviewed: 2026-11-13
---

# Connections — handbook

Connecting a provider account, storing and refreshing its credential,
discovering and curating its resources. Spec:
[vaubaan-gateway](../spec/vaubaan-gateway.md) §0, §2.3, §4.2, §7.2; ADRs
[connect-driver-and-resource-curation](../decisions/connect-driver-and-resource-curation.md),
[one-place-to-authorize-services-token-first](../decisions/one-place-to-authorize-services-token-first.md),
[oauth-client-registered-by-the-gateway](../decisions/oauth-client-registered-by-the-gateway.md).

## Start here

- [`service.ts`](../../apps/gateway/src/server/connections/service.ts) — `ConnectionService`: the connect driver per credential kind, discovery, owner edits, revoke, transfer, reassign.
- [`credentials.ts`](../../apps/gateway/src/server/connections/credentials.ts) — `CredentialBroker`: the one place a stored credential is decrypted, refreshed, or withdrawn at the provider.
- [`oauth2-clients.ts`](../../apps/gateway/src/server/connections/oauth2-clients.ts), [`oauth-broker.ts`](../../apps/gateway/src/server/connections/oauth-broker.ts) — the two client sources of an `oauth2` plugin (registered by the gateway, or a broker's: [oauth-broker-contract](oauth-broker-contract.md)).
- [`shipped-plugins.ts`](../../apps/gateway/src/server/compose/shipped-plugins.ts) — the one provider list; picker, catalog index and tool list derive from it.
- [`discovery-after-call.ts`](../../apps/gateway/src/server/connections/discovery-after-call.ts) — discovery after a creating call (ADR [created-resources-join-the-mission](../decisions/created-resources-join-the-mission.md)).
- [`future-resources.ts`](../../apps/gateway/src/server/connections/future-resources.ts), [`hourly-discovery.ts`](../../apps/gateway/src/server/connections/hourly-discovery.ts) — what a discovery or a relabel does to the missions' future resources, and the hourly discovery (ADR [resource-set-is-one-environment-with-optional-future-resources](../decisions/resource-set-is-one-environment-with-optional-future-resources.md); the rule is in [missions](missions.md)).

## Invariants

- **Connect state** (`pending.ts`): 32 random bytes, consumed once whoever presents it, returned only to the session of the user who started it, for that provider only; anything else is `state-invalid`. The redirect URI is built from `public_url`, never the request host; a foreign `return_to` is refused (`return-url-refused`), never defaulted.
- **A token way is guided entirely by its plugin** (`TokenGuideView` in `service.ts`, rendered by `components/connections/TokenGuide.tsx`): how wide to grant and why, the steps with their menu path (highlighted chips, words of the frame in `TOKEN_CONNECT`) and their screenshot (`GuideStepView.figure`: URL, alt, provenance line from the SDK's `screenshotAttribution`), the token page, the permissions, the expiry kind, the documentation. The page writes nothing about a service; `definePlugin` refuses a token way without its guide or `verify`, and `tests/unit/structural/token-guides.test.ts` holds the shipped ones to it (ADR one-place-to-authorize-services-token-first, amended 2026-10-31: granted wide, narrowed by each mission).
- **A key in several shapes** (`CredentialAlternative`, Vercel: Team or One project): the radio (`alternative`, in step 1, bound to the form by `form="connect-form"`) and every alternative's steps and fields are rendered; `accounts.module.css` hides the panels (`data-alternative-panel`) of the alternatives not chosen with `:has` (at most four), and the browser holds none of their fields required. The server is the rule (`readCredentialForm` in `input.ts`): only the shared fields and the chosen alternative's are read and kept; no choice (the v4 import) → the only alternative whose fields hold a value, else `invalid-input`. The choice is not stored; the plugin reads it back from its fields.
- **A token is checked before it is stored**: a rejected one stores nothing. A failed first discovery refuses an `api-key` connection, is recorded for `oauth2` (the code is spent), is not attempted for `ssh-key`.
- **No message in a URL**: outcomes travel as an opaque `?notice=<id>`, readable once, only by the web session it was written for. A refused form is echoed back, **never a `secret` field**.
- **A provider's error text is never logged or stored** at connect or refresh (it can echo the credential): only its status in the gateway's words. The agent still gets it on a tool call (ADR [provider-error-text-stays-with-the-agent](../decisions/provider-error-text-stays-with-the-agent.md)). A plugin-worded `CredentialRefusal` is kept. **One exception, the connect page**: the `UpstreamAuthError` sentence of `verify` or of the first discovery reaches the person connecting, masked of every value of the credential they pasted (`providerFailureReason(err, secret)`), never a recorded discovery failure.
- **What a token holds**: a `verify` that returns `granted` (permission names as in `guide.permissions`) is kept in `metadata.granted`; `ConnectionView.token_lacks` is the guide's permissions it lacks (`token-permissions.ts`, names compared case-insensitively), `null` when the service did not say, and the account page names them with their tools.
- **A plugin never receives an OAuth client secret or a brokered refresh token**: the host sends the requests that carry them. The broker keeps no token: the refresh token (opaque, sealed by the broker to this instance) is stored as `BrokerGrant { broker, refreshToken }` beside the secret and left out by `parseSecret`.
- **Status writers are conditional updates, each naming its transition**: a refresh or late callback racing a revocation never revives a connection. `revoked` is terminal and nulls the credential. Which statuses serve calls is one function, `isUnavailableConnectionStatus` (`active` and `unowned` serve).
- **Revoke in the store first, then withdraw at the provider** (bounded, never throws): the local revocation never waits on the provider.
- **A connection of another owner reads exactly like a missing one** (`not-found`).
- **Views are snake_case, records camelCase**: `ConnectionView` and `ConnectionDetail` cross into pages and the management door (`provider_label`, `way_retired`, `token_expires_at`, `owner_label`, `default_env_choices`…); the `connection` they carry is the store's camelCase `ConnectionRecord`.
- **The effective environment label is computed on read** (`resource-env.ts`: own label, else the connection default); the default is never written to a resource row, so clearing it un-labels inheriting resources.
- **Every write that adds resources or moves a label settles the missions.** `storeDiscovery` (connect, Refresh, after a call, hourly, "check now"), `updateResource` (an owner's label), `setDefaultEnv` and `CreatedResources.record` take a `FutureResources.snapshot` before the write and `settle` after it, in the name of the human who acted, or `DISCOVERY_ACTOR_ID` (`discovery`) for the gateway's own discoveries. A write through the store alone (tests, the importer) moves nothing. `settle` never throws.
- **Discovery runs every hour** for the connections a running mission's set with `future` on depends on (`MissionsRepo.connectionsWithFutureSets`), one after the other, the first run one hour after boot, never two runs at once. Not audited itself (the joins are); a failure is recorded on the connection and logged by connection only.
- **"Check now"** (`POST /api/missions/<id>/resources/check`, `{ connection_id }`, `ConnectionService.checkForMission`): the mission's creator or an owner of the connection; anyone else, or a connection the mission does not carry, is `not-found` (404). Rate-limited per user (`CHECK_NOW_RATE_LIMIT`), audited `resources-discovered` with `cause: check-now`. Answers the discovery record, `last_checked_at` and what joined or left THIS mission, by set.
- **"Last checked"** is `metadata.discovery.at` (`lastDiscoveryAt`), written by every discovery whatever its outcome; the mission detail and the door's mission view carry it per connection (`last_checked_at`).

## Traps

- `expiry: person-types` (Supabase, Fly, Upstash): the person picked a date the service never says back, so the account page reads "no expiry known" and cannot warn; only `provider-reports` ways (GitHub, Cloudflare, Vercel) get the 14-day notice. `CredentialCheck.granted` is not stored yet.
- A `verify` failure the plugin did not word as a `CredentialRefusal` reaches the person as "the provider rejected the credential (HTTP 401)" (`failure-reason.ts`): a plugin names every cause it can.
- `reassign` decides "ownerless now, new owner group has a member" **inside** the write transaction (`assignOwnerlessTo`); the service's earlier reads only choose which refusal is named.
- `revoke`, `transfer` and `reassign` write `mission-orphaned` / `mission-restored` in a `finally`, even if the act's own audit entry fails: the act is committed and the audit must say why missions stopped.
- An account made a way the plugin no longer offers (`isRetiredWay`) keeps id, resources and missions but nothing reads its secret: calls are refused before the budget, its tools leave `tools/list`. Reconnecting keeps the id.
- `invalid_client` forgets the registered client so the next connect registers again; every other account connected through it expires at its next refresh.
- A discovered ref that goes missing is never deleted, only marked stale; a row younger than 15 min is not marked stale (providers list new resources late). Tests use `agePastStaleGrace`.
- A plugin-set `env` wins over the owner's label (`label-read-only`).
- `refresh` is single-flight per connection (rotating refresh tokens are single use); a broker down is `OAuthBrokerUnavailableError` and never expires the connection: only `400 invalid_grant` on `/token` does.
- An attested broker is reached over a TLS socket of its own whose chain is not checked (`broker-channel.ts`): trust comes from the attestation naming that socket's key, never from a CA. Nothing, the broker key included, is written before the key is pinned.

- **Screenshots of the connect guide** are served by `GET /reference/<id>/connect/<file>` (`connections.handlers.connectFile`, `guardSession` role `user`, so 401 without a session and 403 for the bootstrap operator) from the plugin's own folder, `readConnectFile` in `server/plugins/connect-files.ts`: two origins by the inventory entry, **bundled** → `plugins/<id>/docs/connect/` of the repository (`BUNDLED_PLUGINS_DIR`, resolved from the module like the migrations; in the image it exists only because `next.config.ts` traces `../../plugins/*/docs/connect/**`), **pinned** → `<pin path>/docs/connect/` (`scripts/build-plugin-bundle.mjs` copies the folder beside `index.js`; a pin built before it has none, and its images 404). Only a file the registered, enabled plugin's guide declares, by a name matching `GUIDE_SCREENSHOT_FILE_PATTERN`, is read: never a path. `Cache-Control: private, max-age=3600`.
- A file added to `docs/connect/` without a declaration fails `tests/unit/structural/connect-screenshots.test.ts`; a declared one heavier than 300 KB, wider than 1600 px or not a PNG/WebP by its bytes too. Personal data in the image is the review's.

## Procedures

- **Add a provider**: the plugin, a `SHIPPED_PLUGINS` entry, the dependency in `apps/gateway/package.json` (`next.config.ts` derives `transpilePackages` from it). A new credential kind changes the plugin contract: ADR first.
- **Hosted, several processes**: replace the two `// single-process only` guards (`PendingConnectStore`, `CredentialBroker` refresh) with an atomic get-and-delete and a shared lock.
- No test connects a real account: after changing a token way, connect one real account by hand, following the guide as written, and check its resources; the demo (`tests/demo/providers.ts`) and the v4 import test answer each plugin's `verify` and need a route when a check at paste changes.

## Debug

- **`state-invalid` after consent** → over 10 minutes, callback opened twice, session changed.
- **`token-exchange-failed`** → `redirect_uri_mismatch` (not exactly `<public_url>/connections/callback/<provider>`) or `invalid_client`.
- **"OAuth broker '<name>' answered …"** → the broker's failure, never the connection's: `401 (invalid_key)` wrong key, `403 (return_url_not_registered)` the callback is missing at the broker, `503` down; "could not be attested" is the same outage on `/attest`.
- **"OAuth broker '<name>' is not attested (…)"** → nothing was sent: "no attested broker version admitted by this release" (measurement not on the allowlist: upgrade, or declare your own broker `attestation: none`), "a version this release does not admit" (newer or modified broker), "not bound to this connection’s key" (someone else answers on its address).
- **"not configured on this gateway"** → no `oauth_brokers` entry serves the plugin; the boot log names it.
- **A resource an agent created is not listed** → is the tool in `resourceCreatingTools`? Then the log `resource discovery after a creating call`. Resources created elsewhere appear on "Refresh", "check now", or within the hour when a running mission takes future resources on the connection (log `hourly discovery ran`).
- **A connection turned `expired`** → log `credential refresh rejected`; "Reconnect" keeps id and missions. Its owners' devices are told once, by the call that made the transition ([notifications](notifications.md)). Calls failing while `active` → `ProviderUnreachableError`.
- **An owner's label disappeared** → the plugin started returning `env`.
- **`ssh-key` discovery refused** → public key not in `authorized_keys`, or the host key differs from the pinned fingerprint.
