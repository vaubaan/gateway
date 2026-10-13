# `@vaubaan/plugin-resend`

Outbound email through [Resend](https://resend.com) as a Vaubaan Gateway
provider plugin on the v5 SDK (`@vaubaan/plugin-sdk`). Transactional sends
classified by **who the email goes to**, segments and contacts, broadcast
campaigns and sending domains — with **one resource per sending domain and
one per segment**, so a mission can send from the staging domain freely and
touch the production domain or the customer segment under budget and
approval.

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md).
Modelling handbook: [`docs/handbook/providers/resend.md`](../../docs/handbook/providers/resend.md).
v4 provider spec (domain, zones, catalog rationale): [`docs/spec/resend.md`](../../docs/spec/resend.md).
Contributor guide: [`plugins/README.md`](../README.md).

## Data model

One plane, `email`, rooted at the two resource kinds plus two account-level
entities:

```
domain[<name>]            envScopable — the sending surface
  ├─ dns-record[*]
  ├─ to-zone[Z]           ★ internal | allowlist | external-unbounded
  └─ recipient-count[C]   ★ single | multi | batch
segment[<id>]             envScopable — a contact list (Resend's former "audience")
  ├─ member[<contact>]    ★ a contact's membership of the segment
  └─ broadcast[<id>]      a campaign targeting the segment
contact[<id>]             account-level, PII
email[<id>]               a sent transactional email (status only)
```

★ synthetic entities exist for classification only. Every send is rooted at
the domain of its `from` address; every broadcast call names its segment.
The default env resolver finds the resource ref as the first identifier of
the slice, so `resend[staging].send-email-external-unbounded` resolves from
the domain the mission labelled `staging`.

## Credential and resources

Kind `api-key`, one secret field:

| Field     | Pattern               | Purpose                                                        |
| --------- | --------------------- | -------------------------------------------------------------- |
| `api_key` | `^re_[A-Za-z0-9_-]+$` | A **Full access** key created at `https://resend.com/api-keys` |

There is no company-registered app for Resend: the owner creates the key in
the Resend dashboard and pastes it. A **Sending access** key cannot list
domains or segments, so discovery refuses it (`UpstreamAuthError`).

`discoverResources` pages through `GET /domains` and `GET /segments` (100 per
page, at most 500 per kind) and returns:

```ts
{ provider: 'resend', ref: 'notifications.acme.com', displayName: 'notifications.acme.com',
  metadata: { kind: 'domain', domain_id: 'd91c…', status: 'verified', region: 'eu-west-1',
              internal_domains: [], allowlist_domains: [], allowlist_addresses: [] } }
{ provider: 'resend', ref: '7826…', displayName: 'Newsletter',
  metadata: { kind: 'segment', segment_id: '7826…' } }
```

The **recipient zones** of a domain live in its resource metadata and start
empty, which is the safe default: until the owner fills them, every
recipient is `external-unbounded`. The owner edits the three lists (exact
domain or address match, case-insensitive) and labels the environment of
each resource. A host that re-runs discovery must preserve those edits.

## Tools

27 tools named `resend__<verb>_<noun>`. Domain tools take `domain` (the ref,
e.g. `notifications.acme.com`); segment, membership and broadcast tools take
`segment_id`. Sends take the domain from `from`.

Reads (9): `get_email`, `list_domains`, `get_domain`, `list_segments`,
`get_segment`, `list_contacts`, `get_contact`, `list_broadcasts`,
`get_broadcast`.

Writes (18): `send_email`, `send_batch_emails`, `create_domain`,
`update_domain`, `delete_domain`, `verify_domain`, `create_segment`,
`delete_segment`, `create_contact`, `update_contact`, `delete_contact`,
`add_contact_to_segment`, `remove_contact_from_segment`, `create_broadcast`,
`update_broadcast`, `send_broadcast`, `delete_broadcast`, `describe_zones`
(synthetic: returns the zone configuration of the mission's domains).

Rules the classifier enforces, all `denied` (audited, never executed):

- a `from` whose domain is not a sending domain of the mission (sends and
  broadcasts), a malformed recipient, a send without recipient;
- `attachments`, `scheduled_at`, and `send: true` on a broadcast create or
  update — out of scope in v1, and the latter would bypass `broadcast-send`;
- a batch with no email or more than 100;
- a `domain` or `segment_id` outside the mission, a malformed identifier.

`execute` re-runs the classifier before any call, and every broadcast call
first reads the broadcast upstream and refuses one that targets another
segment than the one named. List tools return only the mission's domains,
segments and the broadcasts of those segments.

## Catalog

`src/risk-catalog.yaml`, version 2: 16 live risks, the
`resend.uncategorized-write` fallback, and two deprecated v4 ids
(`read-audiences` → `read-segments`, `audience-write` → `segment-write`)
kept so they stay resolvable.

| Risk                                   | Action | Notes                                                                        |
| -------------------------------------- | ------ | ---------------------------------------------------------------------------- |
| `resend.read-email-status`             | R      | `GET /emails/:id` metadata.                                                  |
| `resend.read-domains`                  | R      | Domains, DNS records, `describe_zones`.                                      |
| `resend.read-segments`                 | R      | Segments, contacts, members — **PII**.                                       |
| `resend.read-broadcasts`               | R      | Campaign metadata.                                                           |
| `resend.send-email-internal`           | W      | Every recipient in `internal_domains`.                                       |
| `resend.send-email-allowlist`          | W      | Internal or allow-listed recipients.                                         |
| `resend.send-email-external-unbounded` | W      | Irreversible, `data: secret`; **env-scoped `[staging, dev]`**.               |
| `resend.send-batch`                    | W      | `POST /emails/batch`; caps 100/call, 5/min, 50/session.                      |
| `resend.segment-write`                 | W      | Create or delete a segment.                                                  |
| `resend.contact-write`                 | W      | Contact CRUD and segment membership — PII.                                   |
| `resend.broadcast-draft`               | W      | Create or update a draft.                                                    |
| `resend.broadcast-send`                | W      | Irreversible, `cost: unbounded`; caps 1/min, 5/session.                      |
| `resend.broadcast-delete`              | W      | Cancels a scheduled broadcast.                                               |
| `resend.domain-write`                  | W      | Add, update, remove a sending domain — posture shift.                        |
| `resend.domain-verify`                 | W      | Trigger DNS verification.                                                    |
| `resend.uncategorized-write`           | W      | Fallback; counts only when no named risk matched. Never offered in a preset. |

Patterns use `[*]` (exactly one identifier) and explicit verb leaves, so a
contact write never touches `segment-write` and a broadcast send never
touches `broadcast-draft` — the v4 catalog's `[**]` patterns overlapped.

## Presets

| Preset               | Scope                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`          | Email status, domains, campaign metadata. No PII, no write.                                                                                              |
| `developer`          | One token per code project: reads plus transactional sends to internal and allow-listed recipients, generous budgets. No bulk, no PII, no domain change. |
| `marketing-operator` | Reads including PII, contacts and segments, drafts and single sends `auto`; `broadcast-send`, `send-batch` and `segment-write` need `approval`.          |
| `domain-admin`       | Read and verify domains freely; `domain-write` needs `approval`. No send.                                                                                |

Presets are UI sugar: the persisted policy is the explicit enumeration.
`send-email-external-unbounded` is env-scoped and never offered; a creator
adds `resend[staging].send-email-external-unbounded` by hand. Values are a
starting point — ADR `mission-presets-default-values` is deferred.

## Tests

`npx vitest run plugins/resend` — 136 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage`, `assertNoWildcard`,
`assertPresetsValid`), the v5 classifier, `execute` and
`discoverResources` against `mockFetch`, the credential spec and presets,
catalog invariants, the data model, and the v4 suites kept unchanged for the
legacy surface (`risk-classifier.test.ts`, 46; `adapter.test.ts`, 12). No
test ever calls Resend.

## Legacy v4 surface

`ResendAdapter`, `resendAvailableTools` (the 25 audience-era v4 tools),
`resendExecuteCall`, `resendRiskCatalog` (now the loaded YAML) and
`classifyResendV4` are kept, `@deprecated`, so `apps/gateway` compiles until
P1.6 replaces the execution door. The v4 classifier emits
`account[<slug>]`-rooted slices that the v2 catalog no longer matches; it is
kept verbatim, not delegated, and deleted with the v4 app.
