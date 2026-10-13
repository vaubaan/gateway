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
  handbook.

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
