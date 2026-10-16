---
title: Connect driver, provider-app precedence and owner curation of resources
status: accepted
date: 2026-10-13
extends:
  - plugin-contract-and-credential-spec
  - pivot-v4-to-v5-on-prem-mission-tokens
  - embedded-store-sqlite-and-migrations
partially-supersedes:
  - oauth-app-install-per-provider
---

# Connect driver, provider-app precedence and owner curation of resources

> Records the choices feature P1.4 made inside decisions already taken: the
> pivot ADR D3 (the company registers its own app per provider) and
> [[plugin-contract-and-credential-spec]] D2 (the host runs the four
> credential flows and the standard OAuth refresh). The brief named no ADR;
> these points are structural enough that someone will ask why. Handbook:
> [[connections]].
>
> **Amended on 2026-10-13 by P1.4b** — the `app-install` trust gap listed
> under Consequences is closed: see "Amendment 2026-10-13 — installation
> binding" below (D9, D10). D4 gains one exception (the acceptance of
> unverified installations is stored, never read from the file).

## Context

P1.4 builds the host side of `CredentialSpec`: one driver for `oauth2`,
`app-install`, `api-key` and `ssh-key`, the Admin page where the operator
enters provider apps, and the resources of a connection. Four things were
left open by the spec and the earlier ADRs:

- the spec (§6) asks for a "single-use nonce" and a "return URL limited to
  the instance's public URL" without saying where the nonce lives or what a
  foreign return URL produces;
- the configuration handbook says "the mounted file wins" for provider apps
  without saying at which granularity;
- the store (P0.3) synchronised resources by **deleting** refs a discovery
  no longer returned and overwriting the display name, while the spec (§0
  "Resource") makes the owner the curator ("kept current by the owner, who
  may label each resource"), and the plugin migrations showed three needs:
  Stripe sets `env` itself (`test` / `live`), Resend keeps owner-edited
  recipient zones in the resource metadata, and missions select resources
  by row id;
- what happens to a connection when its first discovery fails differs by
  credential kind, and nothing said how.

## Decision

### D1 — The flow state is server-side, keyed by the `state`, bound to the user

The `state` sent to the provider is a 256-bit random value and the key of a
pending record (provider, user id, PKCE verifier, redirect URI, return
path, reconnect target) kept in the root's `SessionStore` for ten minutes.
The callback consumes the record whatever the outcome and receives it only
when the current web session belongs to the user who started the flow and
the provider in the path is the record's. No cookie carries flow state, and
nothing about the flow is encoded in the `state` itself.

### D2 — A foreign return URL is refused, not replaced

`return_to` is resolved against `public_url` with the WHATWG parser and
accepted only when the resulting origin is the public origin; only its path
is stored. Any other value fails the start with `return-url-refused`. The
redirect URI given to the provider is built from `config.publicUrl`, never
from the request.

### D3 — Outcomes travel as an opaque one-time notice id

After a mutation the handler stores `{ tone, title, lines }` server-side
and redirects with `?notice=<id>`; the id is readable once, by the web
session it was written for. No message text, error code or provider error
ever appears in a URL.

### D4 — Provider apps: the mounted configuration wins per provider

When `providers.<id>` exists in the mounted configuration, that block is
the whole app configuration of the provider: the Admin page is read-only
for it and stored values are ignored, even for fields the block lacks (the
provider is then shown `incomplete`). Otherwise the Admin page stores each
field in `instance_config` under `provider_apps.<id>.<field>`, secrets
sealed. The fields are derived from the plugin's `CredentialSpec`; the
host always asks `client_id` (and `client_secret` unless the client is
public) for `oauth2`. A plugin receives the app configuration without the
OAuth client secret.

### D5 — First-discovery policy per credential kind

| Kind          | A failed first discovery                                                |
| ------------- | ----------------------------------------------------------------------- |
| `api-key`     | refuses the connection; nothing is stored; the provider's message shown |
| `app-install` | refuses it when the provider rejects the installation; otherwise kept   |
| `oauth2`      | keeps the connection and records the error                              |
| `ssh-key`     | not attempted at connect time                                           |

### D6 — Discovery merges; owner fields are never overwritten; nothing is deleted

Migration `0004` adds to `connection_resources`: `metadata_json` (provider
facts, replaced by every discovery), `owner_metadata_json` (owner edits,
overlaid on read), `env_source` (`owner` | `plugin`), `display_name_edited`,
`hidden`, `stale_since`. `syncDiscoveredResources` updates provider facts
only; a label the plugin sets is read-only for the owner and follows the
plugin; a ref that disappears upstream is marked stale and keeps its row
id. The owner may edit, besides name, label and hidden flag, exactly the
metadata keys whose discovered value is a list of strings. The destructive
`replaceResources` stays in the repository contract (additive rule of the
wave) and is no longer called.

### D7 — Revocation erases the credential; state changes are conditional

`revoke` sets `revoked`, nulls the credential blob and is terminal.
`markExpired`, `refreshCredential` and `reconnect` are conditional updates,
so a refresh or a late callback racing a revocation cannot bring the
connection back. Only a rejection by the provider (`UpstreamAuthError`, or
a token error classified as rejected) expires a connection; an unreachable
provider does not.

### D8 — The shipped plugins are the default registry

`compose/shipped-plugins.ts` is the one import list of provider plugins
and the default `RootDeps.buildRegistry`; the root no longer boots with an
empty registry.

## Consequences

- A stolen or replayed callback URL is useless: the state is spent, and it
  never worked in another user's session (login-CSRF on the connect flow is
  closed without a cookie).
- A crafted link cannot make the instance display attacker-chosen text, at
  the cost of one short-lived row per redirect and a notice lost if the
  user opens the target more than five minutes later.
- An operator who manages provider apps as code keeps full control: the
  Admin page cannot silently complete or override a file block. The cost is
  that a provider cannot be split between file and page.
- Mission resource selections survive upstream churn: a deleted and
  recreated repository keeps its row; a vanished one stays visible as
  stale instead of silently shrinking a mission. Stale rows accumulate
  until someone decides to purge them — no purge exists yet.
- The "editable = list of strings" rule needs no SDK change and covers
  Resend today; a plugin that needs an owner-editable scalar cannot have
  one without amending the plugin contract.
- `hidden` and `stale_since` are only flags: consumers (mission issuance,
  the execution door) must decide what they mean for them.
- A `revoked` connection can never be diagnosed from its credential, and
  the provider-side grant stays until the owner removes it there.
- Two in-process guards exist (`PendingConnectStore.taking`,
  `CredentialBroker.refreshing`), marked `// single-process only`; a hosted
  deployment replaces them with an atomic get-and-delete and a shared lock.
- `app-install`: the installation id of the callback is trusted once the
  state is valid and the first discovery succeeds. A user who knows the id
  of another installation of the company's app (another organisation of the
  same company) could claim it. Closing this needs the provider's
  user-authorisation step during installation, hence OAuth client fields
  in the GitHub plugin's spec; it is left to a follow-up and listed in the
  handbook. **Closed by the amendment of 2026-10-13 below.**

## Amendment 2026-10-13 — installation binding (P1.4b)

### Why

The gap above is not theoretical on a single-company instance. Installation
ids are small integers visible in URLs and webhook payloads; any signed-in
user could start a connect flow, obtain a valid `state`, and come back with
the id of an installation on another organisation or on another team's
repositories. The first discovery succeeds — the company's app really is
installed there — and the user owns a connection to repositories they have
no right to, on which they can issue missions. The attacker is an insider,
and bounding what insiders' agents can do is the product. GitHub documents
the same warning for the setup URL: the `installation_id` it carries can be
spoofed, and the app should generate a user access token and check that the
installation is associated with that user.

### D9 — An installation is accepted only when the provider confirms the authorizing user can reach it

The `app-install` `CredentialSpec` gains an optional, declarative
`userVerification` block: callback parameter of the authorization code,
token endpoint and client authentication method, installations endpoint
with its static headers, where the list and the id are in the response, and
page-number pagination. The authorization request is implicit — the
provider's installation page is configured to ask the installing user to
authorize the app — so the host only handles the callback: it exchanges the
code with the app's `client_id` / `client_secret`, lists the installations
the resulting user token can reach, and accepts the claimed id only when it
is in that list. The check runs before the plugin is asked for anything.
The user token is used for that one listing and dropped: never stored,
logged, returned, or handed to the plugin.

A plugin that declares the block must list `client_id` and a secret
`client_secret` in its `appConfigFields` (`definePlugin` enforces it); the
host removes `client_secret` from the `appConfig` every plugin receives,
whatever its credential kind. GitHub declares the block
(`POST https://github.com/login/oauth/access_token`,
`GET https://api.github.com/user/installations`, 100 per page).

Every refusal — no code, code refused, list denied, id not listed — stores
nothing and writes an `AdminAuditEntry` with the new act
`connection-refused` (provider, reason, claimed installation id). An
unreachable provider is reported as such and is not a refusal.

### D10 — A plugin that cannot verify is refused unless the operator accepts it, per provider

When an `app-install` spec has no `userVerification`, starting and
completing a connect flow are both refused, and the provider is not offered
in the picker. The operator may set "accept unverified installations" for
that provider app in Admin → Provider apps: off by default, shown with a
warning, audited, withdrawn by removing the app's settings. The flag is
refused for a provider whose plugin verifies: it can never switch a
verification off. It is stored in `instance_config`
(`provider_app_flags.<id>.accept_unverified_installations`) and set from
the page only, including for a provider whose fields come from the mounted
configuration — the one exception to D4, because the file block is a
string-to-string record handed to the plugin and an operator decision is
neither.

### Consequences

- The insider attack needs, besides the id, a GitHub account that can
  already reach the target installation — at which point the user had that
  access anyway.
- The check proves **access**, not administration: for GitHub, any account
  with explicit read access to one repository of the installation passes.
  A connection then still carries the installation's full reach through
  the app, which may exceed what that person can do by hand. Narrowing
  this (requiring an organisation owner, or intersecting resources with the
  user's own repositories) is a separate decision.
- Operators must enable "Request user authorization (OAuth) during
  installation" on the GitHub App, register the gateway's callback URL as
  the app's **callback URL** (GitHub then offers no setup URL), generate a
  client secret and enter `client_id` / `client_secret`. Until they do, the
  GitHub app is `incomplete`: no new connection, and — because the plugin's
  `appConfig` is built from the complete record — existing GitHub
  connections stop resolving. Fail-closed on purpose; v5 has no released
  instance to migrate.
- The provider is trusted to return the `state` on the callback of an
  installation that includes user authorization. This is the behaviour of
  GitHub; it is not spelled out in its documentation and is covered by the
  manual end-to-end run only.
- A user who is redirected to an installation that already exists updates
  it instead of installing it; whether the provider then comes back with a
  code depends on the provider. For GitHub the dependable path for a second
  connection to an existing installation is not covered here.
- The discarded user token stays valid at the provider until it expires
  (eight hours on GitHub when token expiry is enabled, which is the
  default). The host does not revoke it: nobody holds it.
- The generic OAuth client classes an `error` member under HTTP 200 as a
  failure but not as a dead grant (P1.4, pinned by a test). GitHub reports a
  wrong code exactly that way, so the installation check treats any OAuth
  error stated below 5xx as a refusal on its own, without changing the
  refresh path.
- `AdminAct` gains `connection-refused` (additive, `@vaubaan/gateway-core`).
- One more page of pagination logic lives in the host, capped at 20 pages;
  a user reaching more installations of one app than that is refused, not
  accepted unverified.

### Rejected alternatives

**Let the plugin verify (a `verifyInstallation(ctx, id, code)` hook).** The
plugin would need the client secret and would hold a user token; D2 of
[[plugin-contract-and-credential-spec]] keeps both out of plugins, and each
plugin would re-implement an exchange the host already has.

**A full host-driven OAuth authorization before the installation redirect.**
Two redirects and a `redirect_uri` the host controls, but the user would
authorize, then install, and the two steps would have to be correlated by
the host; the provider's "authorize during installation" does it in one
step with one callback.

**Check through the app itself (`GET /app/installations/{id}` with the app
JWT) that the installation's account matches something the user typed.**
Proves the installation exists for this app — which the first discovery
already does — and nothing about the human.

**Match the gateway user's IdP email against the installation's account.**
The IdP identity and the GitHub identity are unrelated namespaces; emails
at GitHub are user-controlled and often private.

**Keep accepting unverified installations by default, with a warning.** The
default would remain the vulnerable state on every instance that upgrades
without reading. Refused; the unsafe mode is opt-in per provider.

**A global "accept unverified installations" switch, or a key in the
mounted configuration.** Global is wider than any need (one third-party
plugin); a file key would have to be carved out of the per-provider record
plugins receive and of the provider-app field list. Kept per provider, in
the store, behind the audited page.

## Rejected alternatives

### State in a cookie, compared on the callback (the v4 design)

Works, but the verifier and the return path then live in the browser, the
flow is bound to a browser rather than to a user, and two tabs overwrite
each other. Rejected for the server-side record.

### Fall back to a default page on a foreign return URL

Friendlier, but it hides an attack or a caller bug. The spec says
"limited"; a refusal is observable and testable. Rejected.

### Flash messages in the query string or in a cookie

The query string lets anyone compose a link that shows their text inside
the instance's own banner; a cookie adds a second piece of client state
and a size limit. Rejected for the opaque id.

### Merge file and stored provider-app fields key by key

Matches the loader's "file wins key by key" wording, but the effective
configuration of a provider would then be the union of two sources with no
single place showing it, and a secret removed from the file would silently
be replaced by an older stored one. Rejected.

### Create the connection first, discover afterwards, for every kind

Uniform, but an API key the provider refuses would leave a dead connection
behind for the user to clean up, and Resend's "this key cannot list
domains" would arrive as a warning on a page instead of at the form.
Rejected for the per-kind policy.

### Delete resources that disappear upstream (P0.3 behaviour)

Simplest, but it cascades into `mission_resources` and silently narrows
running missions, and it loses the owner's label when a resource is
recreated. Rejected.

### One metadata column, with the plugin told to preserve owner keys

Every plugin would re-implement the merge, and a plugin bug would erase
owner settings. Rejected for two columns merged by the host.

### A declarative "owner-editable metadata" schema in the plugin SDK

The right long-term shape, but it amends the public plugin contract while
ten plugins have just migrated, for one provider's three lists. Deferred;
the list-of-strings convention is its stopgap.

## References

- Spec: [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §0, §2.3, §4.2,
  §4.3, §6, §7.2.
- Handbook: [[connections]]; neighbours [[store]], [[configuration]],
  [[authentication]], [[plugin-sdk]].
- Code: `apps/gateway/src/server/connections/`,
  `apps/gateway/src/server/provider-apps/`,
  `apps/gateway/src/server/store/repositories/connections.ts`,
  `apps/gateway/migrations/0004_connection_resource_curation.sql`.
