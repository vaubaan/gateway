---
title: A service connects through the company app or with a token pasted by hand, both kept
status: accepted
date: 2026-10-13
extends:
  - plugin-contract-and-credential-spec
  - connect-driver-and-resource-curation
  - provider-side-revocation-on-connection-revoke
  - upstream-credential-cache-and-rejected-credentials
partially-supersedes:
  - oauth-app-install-per-provider
---

# A service connects through the company app or with a token pasted by hand, both kept

> Product owner's decision of 2026-10-14 (brief PK): two ways to connect a
> service coexist, and nothing already built is removed. When an
> administrator registered the integration app (GitHub App, Supabase or
> Railway OAuth app), people connect through it as before; when not, the
> interface guides them to create a token at the service and paste it. Teams
> often use one shared account per service and let Vaubaan decide who may do
> what. An app shared across instances stays refused: no secret ships with the
> gateway. Handbooks: [connections](../handbook/connections.md),
> [plugin-sdk](../handbook/plugin-sdk.md),
> [providers](../handbook/providers/README.md),
> [threat-model](../handbook/threat-model.md). Spec patch: delivered beside
> this ADR (§0 "Connection", §5, §7.2).

> **Amendment of 2026-10-14 — Railway: workspace token, and the MCP server's
> tools on a token (brief PM).** Supersedes the Railway row of D5 and the
> rejected alternative "sending a Railway account token to the MCP server".
>
> - **Empirical check, 2026-10-14** (orchestrator, against the real service,
>   with a workspace token of the dogfood workspace `vaubaan`):
>   `https://mcp.railway.com` (Streamable HTTP, SSE responses) accepts
>   `Authorization: Bearer <workspace token>` — `initialize` 200,
>   `tools/call list-projects` 200 returning the workspace's project; a bogus
>   Bearer gets 401 on `tools/call`; `tools/list` answers 200 without a token
>   (69 tools that day). Cloudflare in front refuses some user agents (error
>   1010): every request now carries `User-Agent: vaubaan-gateway`. Railway's
>   docs still describe the server for OAuth and the CLI's sign-in only, so
>   the **account token is not verified** on the MCP server.
> - **The workspace token is offered and recommended** (least privilege: one
>   workspace; fit for a shared service account), the account token second,
>   both through the one `api-key` way (D1 refuses a kind declared twice, and
>   one form suits both: they are created on the same page and sent the same
>   way). Project tokens stay out: one environment of one project, while the
>   resource is a project.
> - **Check at paste**: `me` answers for an account token only; otherwise the
>   projects the token reaches answer for a workspace token, shown as its
>   workspace (`the vaubaan workspace`), else by its projects. Discovery lists
>   the reached projects, then, for an account token, each of its workspaces'.
> - **Every tool runs on a token**: `unavailableTools` is gone. When the MCP
>   server refuses a pasted token (401/403), the plugin asks the API about
>   the same token: refused there too → 401, the rejected-credential path
>   ("Needs reconnecting"); still accepted → 403 naming the kind of token
>   and the way out (a workspace token, or the company app). The 403 keeps a
>   healthy connection usable for the variable tools — the reason D5 gave for
>   not sending tokens to the MCP server at all — instead of expiring it on
>   the first MCP call if Railway turns out not to take account tokens there.
> - Rejected: **two `api-key` declarations, one per kind** (refused by D1's
>   rule, and two cards for one service); **expiring the connection on any
>   MCP 401** (the brief's first reading: it would stop the variable tools
>   of a valid account token); **keeping the account token MCP-less while the
>   workspace token runs everything** (the kind is not stored, and the 403
>   path makes the uncertainty harmless).

## Context

The plugin contract carried one `CredentialSpec` per plugin
([plugin-contract-and-credential-spec](plugin-contract-and-credential-spec.md)
D2). GitHub, Supabase and Railway declared their app (`app-install`,
`oauth2`), so without a registered app their card on "Connect an account" was
dashed and nobody could connect them. The v4 ADR
[oauth-app-install-per-provider](oauth-app-install-per-provider.md) had
refused pasted tokens altogether; in an on-prem instance every company would
first have to register three apps, for a pilot that often runs on one shared
account per service.

## Decision

### D1 — One declaration, several ways: `alternativeCredentials`

`ProviderPlugin` keeps `credential` (the primary way, offered first) and gains
`alternativeCredentials?: CredentialSpec[]`. The host reads the two only
through `credentialSpecsOf(plugin)` (primary first), `credentialSpecFor(plugin,
kind)` and `appCredentialSpecOf(plugin)`. `definePlugin` validates every
alternative like a primary spec (issues prefixed `alternativeCredentials[i]`),
refuses a kind declared twice and more than one way through a company app.
A plugin that declares nothing new is untouched.

Every spec may say, beside its flow (`CredentialSpecCommon`):

- `unavailableTools` — tool → one sentence why ("needs the GitHub App: …");
- `manualRevocation` — where the grant of a connection made this way is
  removed, overriding the plugin's sentence.

An `api-key` spec may add `label` (what the person creates, in the service's
words), `guide` (`steps`, `permissions: { name, access: read | read-write,
tools }[]`, `recommendedExpiryDays`, `docsUrl`) and `verify(ctx) → { account,
expiresAt }`. `definePlugin` checks that the guide names real tools and that
every tool the way can run is served by at least one permission (an empty list
is allowed for a token that carries no permission choice: Railway); the
connect page renders the guide, so nothing about a service is written in the
page.

### D2 — How the host chooses and stores the way

- **Offered way**: the first way usable now (the company app when it is
  registered and verifiable, else the first way that needs no app), else the
  primary. A service is connectable when one of its ways is.
  `ConnectableProvider` keeps its fields (the offered way's) and gains
  `methods`.
- **Chosen way**: the form posts `method=<kind>`; a kind the plugin does not
  declare is `invalid-input`. A reconnect without `method` keeps the way the
  account was made; with one, it may switch (same id, missions kept; the facts
  of the old way are dropped from the metadata).
- **How an account was made** is `metadata.credential_kind`, which every
  connect has written since the first store (`connectionCredentialKind`); the
  stored secret carries its kind too. **No migration**: existing connections
  read exactly as before.
- **Verify before storing**: a pasted token is checked with the spec's
  `verify` (who it acts as, its expiry when the service says), then by the
  first discovery (D5 of the connect-driver ADR, `required`). A rejection, an
  unreadable answer or an expiry already past stores nothing. The account and
  the expiry are kept in clear (`metadata.account`, `expires_at`,
  `credential_expires_at`); the token is sealed like any credential.
- **The app's settings never reach a token connection**:
  `ProviderAppsService.pluginAppConfigFor(id, kind)` hands a plugin the app
  record only for a connection made through the app, `{}` otherwise — so a
  token connection works whether an app is registered, incomplete or removed.

### D3 — A tool a way cannot run is refused before the budget

The resource stage of the execution door refuses such a call as a structural
rejection (`{ ok: false, reason }`: audited `refused`, no refusal code, no
credit consumed), with the sentence "tool '<name>' is not available on the
<service> account '<name>': <reason>", and `tools/list` leaves the tool out.
`MissionConnection` gains the optional `credential_kind`. The plugin also
declines it in `execute` (`ExecutorRefusal`), for a host that would not.

### D4 — Expiry and rejection: the existing path

A pasted token cannot be refreshed: the broker's refresh ladder applies only
to the kind it serves (`refresh` override: the primary kind; the generic
grant: an `oauth2` credential), so a 401 on a token marks the account
`expired` at once, as for any API key ([upstream-credential-cache-and-rejected-credentials](upstream-credential-cache-and-rejected-credentials.md)
D3). The expiry the service gave at paste time is shown on the account page's
first line, and a warning appears fourteen days ahead.

### D5 — The three services

Every fact was read through Context7 on 2026-10-14 (see "Sources").

| Service  | Token                                                                                                           | Runs                                                                                       | Checked at paste                                                                                     | Revocation on removal                                                                                                                                                                                                                         |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub   | fine-grained personal access token only (`github_pat_`); a classic one (`ghp_`) is refused by the field's shape | every tool but `github__mint_install_token` ("needs the GitHub App")                       | `GET /user` (login), `github-authentication-token-expiration` header when sent; repos: `/user/repos` | by hand: `POST /credentials/revoke` exists but is for credentials the caller does not own (leaked ones), notifies the owner as a leak, is limited to 60 unauthenticated requests an hour, and answers 403 to an authenticated call — not used |
| Supabase | personal access token (`sbp_`), a scoped one recommended                                                        | every tool                                                                                 | `GET /v1/organizations` (names); no expiry is exposed                                                | by hand: no endpoint deletes a personal access token in what was read                                                                                                                                                                         |
| Railway  | account token ("No workspace"), `Authorization: Bearer`                                                         | discovery and the four GraphQL variable tools; the ten MCP-server tools need the OAuth app | `query { me { name email } }`; no expiry is exposed                                                  | by hand: no deletion endpoint in what was read                                                                                                                                                                                                |

Why fine-grained only on GitHub: a classic token reaches every repository and
organisation of its account with coarse scopes and may never expire; a
fine-grained one names its resource owner, its repositories and its
permissions, which is what the guide asks the person to choose, and is what
GitHub recommends. Why an account token on Railway: the public GraphQL API
documents it as a Bearer with the `me` query and the personal project list; a
workspace token's answer to those is not documented, and a project token is
scoped to one environment (one connection per environment would not match the
plugin's project resources) and is refused by Railway's MCP server. Why the
MCP tools are unavailable with a token: Railway documents its MCP server for
OAuth and its CLI's sign-in only, and an MCP 401 would expire a healthy
connection (D4).

## Consequences

- An instance with no company app can connect GitHub, Supabase and Railway
  the day it is installed; registering the app later adds the other way, and
  both stay.
- A pasted token is a long-lived secret that acts as a person or a shared
  account, where an app grants short-lived, scoped tokens and can be revoked
  in one place. The threat model says so; the guide narrows the token
  (fine-grained, scoped, chosen repositories and projects, an expiry), and the
  gateway still decides every call.
- The gateway does not delete pasted tokens at the services: the person reads
  where to delete it, in the confirmation before and on the page after.
- A third-party plugin may declare a token way the same way; the guide and the
  structural checks come with it.
- Two facts were not found in the documentation Context7 returned and are
  handled defensively: the GitHub expiry header (read when present, otherwise
  "not said"), and how a Railway account token answers the MCP server (not
  sent: the tools are declared unavailable). Both are open questions for a run
  against real accounts.

## Rejected alternatives

- **`credentials: CredentialSpec[]` replacing `credential`.** One field
  instead of two, but every plugin, every host consumer and two branches in
  flight (GitHub App manifest, git remote) read `plugin.credential`; the
  additive member keeps all of them compiling and keeps one reading through
  `credentialSpecsOf`.
- **A second plugin per service (`github-token`).** Two provider ids, two
  catalogs and two reference pages for the same permissions; missions and
  shares would split by way of connecting. Rejected: the provider list stays
  one entry per service.
- **Hand-written guides in the page.** Drifts from the plugin's tools; the
  structural check that every tool is served by a permission would be
  impossible.
- **Refusing the mint in the plugin only.** The call would consume a credit
  and the tool would stay listed; refusing in the resource stage costs one
  optional field on `MissionConnection`.
- **Accepting classic GitHub tokens.** See D5.
- **Revoking GitHub tokens through `/credentials/revoke`.** See D5: it is the
  leak-report endpoint.
- **Sending a Railway account token to the MCP server and seeing.** A refusal
  there would expire the connection for every tool.
- **A shared app across instances** (one GitHub App for every Vaubaan): a
  shared secret in every image. Refused by the owner.

## Sources

Context7, 2026-10-14: GitHub REST (`/user/repos`, `/credentials/revoke`,
authenticating with a personal access token), GitHub Docs (managing personal
access tokens: creation steps, resource owner, expiration, repository access);
Supabase (Management API authentication, personal access tokens, scoped token
permission names, `x-fga-permissions`); Railway docs (public API tokens and
headers, `me` and workspace queries, projects in a workspace, MCP server
security notes). The fine-grained permissions of the GitHub token guide are
read off the App's own declaration, `GITHUB_APP_PERMISSIONS`
(`tokenPermissionsOf`): fine-grained tokens use the App's permission names, so
the manifest and the guide share one source. Which permission each endpoint
needs was not re-checked endpoint by endpoint against GitHub's docs: the
Context7 quota ran out (twice, 2026-10-14), so the guide inherits the App
declaration's mapping as is.
