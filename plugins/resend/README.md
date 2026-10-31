# `@vaubaan/plugin-resend`

Outbound email through [Resend](https://resend.com) as a Vaubaan Gateway
provider plugin on the v5 SDK (`@vaubaan/plugin-sdk`). Transactional sends
classified by **who the email goes to**, segments and contacts, broadcast
campaigns and sending domains — with **one resource per sending domain and
one per segment**, so a mission can send from the staging domain freely and
touch the production domain or the customer segment under budget and
approval.

Contract: [`plugin-contract-and-credential-spec`](../../docs/decisions/plugin-contract-and-credential-spec.md);
what the executor declines:
[`plugin-identifiers-one-grammar-for-classify-and-execute`](../../docs/decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md).
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
the Resend dashboard and pastes it (`src/credential.ts`). A **Sending
access** key cannot list domains or segments, so the check at paste
(`verifyResendKey`, `GET /domains`) refuses it with the permission to choose;
a Full access key is named by its domains.

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

Reads (10): `get_email`, `list_domains`, `get_domain`, `list_segments`,
`get_segment`, `list_contacts`, `get_contact`, `list_broadcasts`,
`get_broadcast`, `describe_zones` (synthetic: returns the zone configuration
of the mission's domains, without calling Resend).

Writes (17): `send_email`, `send_batch_emails`, `create_domain`,
`update_domain`, `delete_domain`, `verify_domain`, `create_segment`,
`delete_segment`, `create_contact`, `update_contact`, `delete_contact`,
`add_contact_to_segment`, `remove_contact_from_segment`, `create_broadcast`,
`update_broadcast`, `send_broadcast`, `delete_broadcast`.

Rules the classifier enforces, all `denied` (audited, never executed):

- a `from` whose domain is not a sending domain of the mission (sends and
  broadcasts), a malformed recipient, a send without recipient;
- `attachments` (anything but an empty list, a non-array value included),
  `scheduled_at`, and any `send` on a broadcast create or update,
  `send: false` as well as `send: true` — out of scope in v1: `true` would bypass
  `broadcast-send`, and an argument that does nothing is not accepted;
- a `headers` entry naming an envelope field (`To`, `Cc`, `Bcc`, `From`,
  `Sender`, `Reply-To`, `Return-Path`, `Resent-To` / `-Cc` / `-Bcc` /
  `-From` / `-Sender`; case-insensitive), a
  malformed header name, a value that is not a single-line string — the
  zone is computed from `from`, `to`, `cc` and `bcc` only;
- a batch with no email or more than 100;
- a `domain` or `segment_id` outside the mission, a malformed identifier.
  An id that reaches the request path (`id`, `segment_id`) is one path
  segment, `^[A-Za-z0-9_-]{1,64}$` (`pathIdent`); a contact may also be
  named by a bare email address (`contactSelector`), sent percent-encoded;
  `domain` is a dotted host name (`domainName`) and never reaches the path
  — the resource's `domain_id` does, checked by `pathIdent` too. `classify`
  and `execute` share these functions; nothing is escaped or repaired.
- a recipient string that could be read as several addresses: one string
  is one address (`parseAddress` in `zones.ts`) — a display name takes no
  `,` `;` `@` `"` `\\` nor control character, a local part no `,` or `;`.
  Several recipients are an array, each zoned on its own.

A single send classifies to one slice, `domain[D].to-zone[Z].W`, whatever
its number of recipients; a batch adds `domain[D].recipient-count[batch].W`
per sending domain. No tool emits a slice that reaches the fallback.

`execute` re-runs the classifier before any call, and a broadcast call that
names an `id` (get, update, send, delete) first reads the broadcast upstream
and declines one that targets another segment than the one named.
`list_domains`, `list_segments` and `list_broadcasts` return only the
mission's domains, segments and the broadcasts of those segments;
`list_contacts` is not filtered (contacts are account-level). Only the
fields a tool declares in its `inputSchema` are forwarded to Resend: the
request is built field by field, so an undeclared argument (`audience_id`, a
template id, …) is never read — ignored, not refused — because no classifier
rule read it. To expose a new Resend field, declare it in `tools.ts` and
decide how it is classified.

What `execute` declines itself — whatever the classifier denies, a malformed
id, a broadcast of another segment — is an `isError` result carrying the
reason (`ExecutorRefusal` under the SDK's `declining`), not a thrown error:
the audit records no upstream failure for it. What Resend fails is thrown
(`UpstreamAuthError`, `UpstreamHttpError`).

## Catalog

`src/risk-catalog.yaml`, 18 entries: 15 live named risks, the
`resend.uncategorized-write` fallback, and two deprecated ids
(`read-audiences` → `read-segments`, `audience-write` → `segment-write`)
kept so they stay resolvable.

| Risk                                   | Action | Notes                                                                 |
| -------------------------------------- | ------ | --------------------------------------------------------------------- |
| `resend.read-email-status`             | R      | `GET /emails/:id` metadata.                                           |
| `resend.read-domains`                  | R      | Domains, DNS records, `describe_zones`.                               |
| `resend.read-segments`                 | R      | Segments, contacts, members — **PII**.                                |
| `resend.read-broadcasts`               | R      | Campaign metadata.                                                    |
| `resend.send-email-internal`           | W      | Every recipient in `internal_domains`.                                |
| `resend.send-email-allowlist`          | W      | Internal or allow-listed recipients.                                  |
| `resend.send-email-external-unbounded` | W      | Irreversible, `data: secret`; **env-scoped `[staging, dev]`**.        |
| `resend.send-batch`                    | W      | `POST /emails/batch`; at most 100 emails per call.                    |
| `resend.segment-write`                 | W      | Create or delete a segment.                                           |
| `resend.contact-write`                 | W      | Contact CRUD and segment membership — PII.                            |
| `resend.broadcast-draft`               | W      | Create or update a draft.                                             |
| `resend.broadcast-send`                | W      | Irreversible, `cost: unbounded`; rate ceiling 10/min.                 |
| `resend.broadcast-delete`              | W      | Cancels a scheduled broadcast.                                        |
| `resend.domain-write`                  | W      | Add, update, remove a sending domain — posture shift.                 |
| `resend.domain-verify`                 | W      | Trigger DNS verification.                                             |
| `resend.uncategorized-write`           | W      | Fallback; counts only when no named risk matched. In no macro-action. |

Patterns use `[*]` (exactly one identifier) and explicit verb leaves, so a
contact write never touches `segment-write` and a broadcast send never
touches `broadcast-draft`.

`send-email-external-unbounded` is the one env-scoped risk. A send with a
recipient in no zone list is allowed only from a domain labelled `staging`
or `dev`, by a mission that accepted `resend[staging].…` / `resend[dev].…`.
From a domain labelled anything else, or not labelled, the engine refuses
the call whatever the mission accepted — the classifier reports the slice,
the catalog's `acceptable_in_envs` decides.

## Macro-actions

| Macro-action | What it covers                                    | Risks                                                                                        |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `check`      | Email statuses, domains, broadcasts and segments. | `read-email-status`, `read-domains`, `read-broadcasts`, `read-segments`                      |
| `send`       | Transactional emails, one by one or in batches.   | `send-email-internal`, `send-email-allowlist`, `send-email-external-unbounded`, `send-batch` |
| `campaign`   | Contacts, segments and broadcasts.                | `contact-write`, `segment-write`, `broadcast-draft`, `broadcast-send`, `broadcast-delete`    |
| `domains`    | Verify and change sending domains.                | `domain-verify`, `domain-write`                                                              |

A creator ticks macro-actions at a trust cran (Prudent / Confiant / Autonome,
risk model §4.6); the cran turns each risk's vector into a gate and scales its
base budget. The persisted policy is the explicit list.
`send-email-external-unbounded` is env-scoped: it is only written qualified
with `staging` or `dev` (`resend[staging].…`), from Confiant up, and always
asks first. Bulk sends (`send-batch`, `broadcast-send`) never run freely at any
cran. No mission needs the fallback to do its job
(`tests/unit/mission-evaluation.test.ts` evaluates them call by call).

## Tests

`npx vitest run plugins/resend` — 233 tests: the SDK kit
(`assertPluginWellFormed`, `assertCatalogCoverage` with no fallback hit,
`assertNoWildcard`), the classifier (cross-cutting
rules in `plugin.test.ts`, scenarios per tool in `classify.test.ts`),
`execute` and `discoverResources` against `mockFetch`, the credential spec
and macro-actions, catalog invariants, the identifier grammars fed hostile values
on both sides (`identifiers.test.ts`), address parsing, the data model, and
whole decisions through
the real catalog and the engine (`mission-evaluation.test.ts`: external
sends per domain label, each mission call by call). No test ever calls
Resend.
