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
Provider spec (domain, zones, catalog rationale): [`docs/spec/resend.md`](../../docs/spec/resend.md).
Contributor guide: [`plugins/README.md`](../README.md).

## Data model

One plane, `email`, rooted at the two resource kinds plus two account-level
entities:

```
domain[<name>]            envScopable — the sending surface
  ├─ dns-record[*]
  ├─ to-zone[Z]           ★ internal | allowlist | external-unbounded
  └─ recipient-count[C]   ★ batch — emitted by a batch send only
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
- `attachments` (anything but an empty list, a non-array value included),
  `scheduled_at`, and `send: true` on a broadcast create or update — out of
  scope in v1, and the latter would bypass `broadcast-send`;
- a `headers` entry naming an envelope field (`To`, `Cc`, `Bcc`, `From`,
  `Sender`, `Reply-To`, `Return-Path`, `Resent-*`; case-insensitive), a
  malformed header name, a value that is not a single-line string — the
  zone is computed from `from`, `to`, `cc` and `bcc` only;
- a batch with no email or more than 100;
- a `domain` or `segment_id` outside the mission, a malformed identifier
  (an id made of dots only included).

A single send classifies to one slice, `domain[D].to-zone[Z].W`, whatever
its number of recipients; a batch adds `domain[D].recipient-count[batch].W`
per sending domain. No tool emits a slice that reaches the fallback.

`execute` re-runs the classifier before any call, and every broadcast call
first reads the broadcast upstream and refuses one that targets another
segment than the one named. List tools return only the mission's domains,
segments and the broadcasts of those segments. Only the fields a tool
declares in its `inputSchema` are forwarded to Resend: an undeclared
argument (`audience_id`, a template id, …) is dropped, because no classifier
rule read it. To expose a new Resend field, declare it in `tools.ts` and
decide how it is classified.

## Catalog

`src/risk-catalog.yaml`, version 3, 18 entries: 15 live named risks, the
`resend.uncategorized-write` fallback, and two deprecated ids
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
| `resend.send-batch`                    | W      | `POST /emails/batch`; at most 100 emails per call.                           |
| `resend.segment-write`                 | W      | Create or delete a segment.                                                  |
| `resend.contact-write`                 | W      | Contact CRUD and segment membership — PII.                                   |
| `resend.broadcast-draft`               | W      | Create or update a draft.                                                    |
| `resend.broadcast-send`                | W      | Irreversible, `cost: unbounded`; rate ceiling 10/min.                        |
| `resend.broadcast-delete`              | W      | Cancels a scheduled broadcast.                                               |
| `resend.domain-write`                  | W      | Add, update, remove a sending domain — posture shift.                        |
| `resend.domain-verify`                 | W      | Trigger DNS verification.                                                    |
| `resend.uncategorized-write`           | W      | Fallback; counts only when no named risk matched. Never offered in a preset. |

Patterns use `[*]` (exactly one identifier) and explicit verb leaves, so a
contact write never touches `segment-write` and a broadcast send never
touches `broadcast-draft`.

`send-email-external-unbounded` is the one env-scoped risk. A send with a
recipient in no zone list is allowed only from a domain labelled `staging`
or `dev`, by a mission that accepted `resend[staging].…` / `resend[dev].…`.
From a domain labelled anything else, or not labelled, the engine refuses
the call whatever the mission accepted — the classifier reports the slice,
the catalog's `acceptable_in_envs` decides.

## Presets

| Preset               | Scope                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`          | Email status, domains, campaign metadata. No PII, no write.                                                                                                |
| `developer`          | One mission per code project: reads plus transactional sends to internal and allow-listed recipients, generous budgets. No bulk, no PII, no domain change. |
| `marketing-operator` | Reads including PII, contacts and segments, drafts and single sends `auto`; `broadcast-send`, `send-batch` and `segment-write` need `approval`.            |
| `domain-admin`       | Read and verify domains freely; `domain-write` needs `approval`. No send.                                                                                  |

Presets are UI sugar: the persisted policy is the explicit enumeration.
`send-email-external-unbounded` is env-scoped and never offered; a creator
adds `resend[staging].send-email-external-unbounded` by hand, so no preset
can send to a recipient outside the zone lists. Every preset does what its
row says without the fallback (`tests/unit/mission-evaluation.test.ts`
evaluates each one call by call). Values are a starting point — ADR
`mission-presets-default-values` is deferred.

## Tests

`npx vitest run plugins/resend` — 161 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage` with no fallback hit,
`assertNoWildcard`, `assertPresetsValid`), the classifier (cross-cutting
rules in `plugin.test.ts`, one scenario per tool in `classify.test.ts`),
`execute` and `discoverResources` against `mockFetch`, the credential spec
and presets, catalog invariants, the data model, and whole decisions through
the real catalog and the engine (`mission-evaluation.test.ts`: external
sends per domain label, each preset call by call). No test ever calls
Resend.
