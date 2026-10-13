# `@vaubaan/plugin-gmail`

Vaubaan Gateway provider plugin for [Gmail](https://developers.google.com/workspace/gmail/api).
**Experimental, classifier-only.** The plugin models the risks of reading,
drafting and labelling in a mailbox and discovers the connected mailbox, but
it exposes **no tool** (`tools` is empty) and `execute` answers a structured
`not_implemented` error for every call. Written against
`@vaubaan/plugin-sdk` only. Maintainer handbook:
[`docs/handbook/providers/gmail.md`](../../docs/handbook/providers/gmail.md).

## Data model

One plane, `mailbox`:

```
account → mailbox → label
                  → thread → message → attachment
                  → draft
                  → from-zone[automated | internal | known-external | unknown]   (synthetic)
                  → to-zone[self | internal | allowlist | external-unbounded]     (synthetic)
                  → bulk-marker                                                   (synthetic)
                  → sensitive-label[<label>]                                      (synthetic)
```

Gmail zones by **identity**, not by containment: the risk of a read depends
on the sender, the risk of a draft on its recipients. The four synthetic
entities are markers the classifier emits; the catalog matches them.

The **resource** a connection exposes is the authenticated **mailbox**
(`ref` = the lower-cased address, from `GET /gmail/v1/users/me/profile`).
Its `metadata` carries the zoning configuration the owner edits:

| Key                   | Type       | Drives                                                   |
| --------------------- | ---------- | -------------------------------------------------------- |
| `account_email`       | `string`   | `to-zone[self]` (defaults to the ref; set at discovery)  |
| `internal_domains`    | `string[]` | `from-zone[internal]`, `to-zone[internal]`               |
| `allowlist_addresses` | `string[]` | `from-zone[known-external]`, `to-zone[allowlist]`        |
| `allowlist_domains`   | `string[]` | `from-zone[known-external]`, `to-zone[allowlist]`        |
| `sensitive_labels`    | `string[]` | `sensitive-label[<label>]` on every read and label write |

Discovery pre-fills nothing but `account_email`: with empty lists every
sender is `unknown` and every recipient but the mailbox itself is external,
so every such draft is refused — the safest reading. A mission must hold exactly one Gmail resource; two or more is
denied as ambiguous (no tool argument selects a mailbox).

## Tools (modelled, not exposed)

| Tool                                                                                             | Slices → risk(s)                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail__describe_zones` (synthetic), `gmail__list_labels`                                        | `label[*].R` → `read-mailbox`                                                                                                                                                                              |
| `gmail__search_threads`                                                                          | `read-mailbox` + one `read-from-zone-*` per `from:` zone; `read-from-zone-unknown` + `bulk-read` when the query is not bounded; `read-sensitive-label` for each sensitive label the query does not exclude |
| `gmail__get_thread`                                                                              | `read-mailbox` + `read-from-zone-unknown` (+ `read-sensitive-label` when the mailbox declares sensitive labels) — worst case: sender and labels are unknown before the fetch                               |
| `gmail__list_drafts`                                                                             | `read-drafts`                                                                                                                                                                                              |
| `gmail__create_draft`                                                                            | `draft-write` + `draft-to-zone-{self,internal,allowlist}` (worst recipient wins); **refused** when a recipient is external or does not parse                                                               |
| `gmail__label_message`, `gmail__unlabel_message`, `gmail__label_thread`, `gmail__unlabel_thread` | `label-write` (+ the fallback `uncategorized-write` when the label is, or may be, a sensitive one); **refused** for `TRASH` / `SPAM` or a missing id                                                       |

The classifier fails closed — what it cannot read costs the worst case or
refuses the call:

- **Searches.** A query is _bounded_ only when it is a plain conjunction
  holding at least one positive `from:<full address>`. An `OR`, a grouping
  (`( ) { } |`), a quoted phrase, a `from:` that is not one address
  (`from:support`), or no `from:` at all (`to:` only, `label:` only,
  `-from:`) is `read-from-zone-unknown` + `bulk-read`. A negation or an
  operator the parser does not model adds `read-from-zone-unknown`.
- **Automated senders.** A sender is `automated` when it is on an internal
  or allowlisted domain (or is an allowlisted address) **and** the local
  part of its full address _is_ a no-reply name (`no-reply@`,
  `notifications@`…). On a domain nobody listed the local part is chosen by
  the sender and decides nothing: `noreply@unlisted.example` is `unknown`.
  `supportive.ceo@myorg.com` is `internal`.
- **Sensitive labels.** On a mailbox that declares some, `get_thread` always
  carries the marker and a search carries it for each label it does not
  exclude with `-label:<name>` in a plain conjunction.
- **Recipients.** One address per string, `addr@example.com` or
  `Name <addr@example.com>`; anything else (two addresses in one string, an
  object, a bare word) refuses the call. A recipient outside the internal
  domains and the allowlists refuses the draft.
- **Label writes.** `thread_id`, `message_id` (message tools) and `label` are
  required and validated. A user label id cannot be mapped to a name, so on a
  mailbox with sensitive labels only system label ids (`INBOX`, `STARRED`,
  `UNREAD`, `IMPORTANT`…) are plain `label-write`.
- **Identifiers.** A thread or message id is one opaque token
  (`gmailId`: `[A-Za-z0-9_-]`, at most 64 characters); a label is an id or a
  name without spaces (`labelRef`: at most 225 characters, `/` for nesting,
  no empty, `.` or `..` segment). Anything else is refused, never escaped.
  Both functions are exported for the executor to come, which must take its
  path segments from them and from nothing else.

Any other tool name is `denied`.

The declarations live in `gmailClassifiedToolDeclarations` (argument names
`q`, `id`, `thread_id`, `message_id`, `label`, `to`/`cc`/`bcc`); the execution phase
moves them into `gmailTools` and maps them onto the official Gmail MCP
server (`gmailmcp.googleapis.com`).

## Catalog and presets

`src/risk-catalog.yaml` — fifteen risks plus the mandatory
`gmail.uncategorized-write` fallback, `catalog_version: 3`. No risk is
env-scoped (Gmail has no environment). No entry declares `caps` or
`infra_limits`: the door enforces no stateless cap (ADR
`scope-caps-not-enforced-in-v5-0`), so `gmail.read-from-zone-unknown` and
`gmail.bulk-read` are bounded by the mission's quota and rate limit only. The
SDK coverage kit showed the v4 catalog left two slices uncovered or on the
fallback: `draft-write` is the one id v5 adds, for the containment slice of
a draft (the zone risk carries the exfiltration axis), and `read-mailbox`,
an existing id, also matches the thread containment slice of `get_thread`.
Plugin version 0.3.0.

| Preset      | Grants                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only` | Labels, drafts, searches and reads from automated, internal, allowlisted and unknown senders (unknown capped at 20/min). No write, no bulk read, no sensitive label. |
| `developer` | Read-only + `draft-write` with drafts to self / internal / allowlist, and single-thread labels (`auto`); `bulk-read` under `approval`.                               |

In no preset, on purpose: `gmail.read-sensitive-label` (PII, explicit
acceptance), `gmail.draft-to-zone-external-unbounded` (the exfiltration
vector — never acceptable: the classifier refuses the draft, and the entry
is kept `deprecated` because ids are never deleted),
`gmail.bulk-label-write` (no modelled tool can touch it) and the fallback.

## Credential — how the company registers its app

1. Google Cloud Console → **APIs & Services → Credentials → Create
   credentials → OAuth client ID**, type _Web application_. Enable the
   **Gmail API** on the project and configure the OAuth consent screen
   (internal user type for a Workspace organisation).
2. Authorised redirect URI: the instance callback the gateway shows on the
   Connect page.
3. Copy the client id and secret into the instance configuration under the
   Gmail provider app (`appConfig.client_id` / `appConfig.client_secret`).

The gateway runs the authorization-code flow declared by
`gmailCredentialSpec`: `https://accounts.google.com/o/oauth2/v2/auth` and
`https://oauth2.googleapis.com/token`, PKCE S256, `client_secret_post`,
`access_type=offline` + `prompt=consent` (a refresh token on every connect),
`include_granted_scopes=true`. Scopes are **`gmail.readonly` and
`gmail.compose` only**: no `gmail.modify` (needed upstream by the `label_*`
tools, but it also unlocks sending), no `gmail.send`. Widening them is an
incremental-authorization decision for the execution phase.

The plugin implements no provider-specific refresh: Google's refresh is the
standard `refresh_token` grant the host performs from the spec.

## Development

```
npx vitest run plugins/gmail       # 406 tests, no network
npx tsc -p plugins/gmail/tsconfig.json --noEmit
```
