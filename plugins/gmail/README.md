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

| Key                   | Type       | Drives                                                     |
| --------------------- | ---------- | ---------------------------------------------------------- |
| `account_email`       | `string`   | `to-zone[self]` (defaults to the ref; set at discovery)    |
| `internal_domains`    | `string[]` | `from-zone[internal]`, `to-zone[internal]`                 |
| `allowlist_addresses` | `string[]` | `from-zone[known-external]`, `to-zone[allowlist]`          |
| `allowlist_domains`   | `string[]` | `from-zone[known-external]`, `to-zone[allowlist]`          |
| `sensitive_labels`    | `string[]` | `sensitive-label[<label>]` on a `label:` clause naming one |

Discovery pre-fills nothing but `account_email`: with empty lists every
sender is `unknown` and every recipient `external-unbounded`, the safest
reading. A mission must hold exactly one Gmail resource; two or more is
denied as ambiguous (no tool argument selects a mailbox).

## Tools (modelled, not exposed)

| Tool                                                                                             | Slices → risk(s)                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gmail__describe_zones` (synthetic), `gmail__list_labels`                                        | `label[*].R` → `read-mailbox`                                                                                                                                            |
| `gmail__search_threads`                                                                          | `read-mailbox` + one `read-from-zone-*` per `from:` zone; `bulk-read` + `read-from-zone-unknown` when non-discriminating; `read-sensitive-label` on a sensitive `label:` |
| `gmail__get_thread`                                                                              | `read-mailbox` + `read-from-zone-unknown` (worst case: the sender is unknown before the fetch)                                                                           |
| `gmail__list_drafts`                                                                             | `read-drafts`                                                                                                                                                            |
| `gmail__create_draft`                                                                            | `draft-write` + `draft-to-zone-{self,internal,allowlist,external-unbounded}` (worst recipient wins)                                                                      |
| `gmail__label_message`, `gmail__unlabel_message`, `gmail__label_thread`, `gmail__unlabel_thread` | `label-write`                                                                                                                                                            |

A query is non-discriminating when it carries neither `from:` nor `to:` nor
`label:`. A no-reply local part (`no-reply@`, `notifications@`…) is
`automated` before any domain match. Any other tool name is `denied`.

The declarations live in `gmailClassifiedToolDeclarations` (argument names
`q`, `id`, `thread_id`, `message_id`, `to`/`cc`/`bcc`); the execution phase
moves them into `gmailTools` and maps them onto the official Gmail MCP
server (`gmailmcp.googleapis.com`).

## Catalog and presets

`src/risk-catalog.yaml` — fifteen risks plus the mandatory
`gmail.uncategorized-write` fallback, `catalog_version: 2`. No risk is
env-scoped (Gmail has no environment). `gmail.read-from-zone-unknown` and
`gmail.bulk-read` carry `caps` and `infra_limits` (scope-caps ADR). Two
entries are new in v5 because the SDK coverage kit showed the v4 catalog
left slices to the fallback: `read-mailbox` also matches the thread
containment slice of `get_thread`, and `draft-write` covers the containment
slice of a draft (the zone risk carries the exfiltration axis).

| Preset      | Grants                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only` | Labels, drafts, searches and reads from automated, internal, allowlisted and unknown senders (unknown capped at 20/min). No write, no bulk read, no sensitive label. |
| `developer` | Read-only + `draft-write` with drafts to self / internal / allowlist, and single-thread labels (`auto`); `bulk-read` and `bulk-label-write` under `approval`.        |

In no preset, on purpose: `gmail.read-sensitive-label` (PII, explicit
acceptance), `gmail.draft-to-zone-external-unbounded` (the exfiltration
vector — v4 marked it "never acceptable", which a v5 catalog cannot express,
so the guard is now the presets and the issuance UI) and the fallback.

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
`refreshGmailCredential` is a rejecting placeholder that only satisfies the
current SDK check and goes away with the SDK's generic refresh.

## Development

```
npx vitest run plugins/gmail       # 123 tests, no network
npx tsc -p plugins/gmail/tsconfig.json --noEmit
```

Legacy v4 exports (`gmailRiskCatalog`, `gmailAvailableTools`,
`classifyGmailV4`) remain for the v4 application and are deleted in P1.6.
