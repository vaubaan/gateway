---
title: Resend provider — spec
status: current
date: 2026-10-13
---

# Resend provider — spec

> **Status:** current. Describes the Resend provider as the v5 plugin
> implements it: _what_ it exposes and _why_. _How_ it is built (modules,
> upstream endpoints, error mapping, tests) lives in the
> [Resend provider handbook](../handbook/providers/resend.md) and in the
> plugin's own [README](../../plugins/resend/README.md).
>
> **Upstream specs.** Vocabulary (connection, resource, mission, `RiskId`,
> preset, restriction): [vaubaan-gateway](./vaubaan-gateway.md) §0. Risk
> model (data model, slices, catalog, classification, decision):
> [gateway-risk-model](./gateway-risk-model.md). Neither is restated here.
>
> **History.** The v4 spec of this provider (bindings, audiences, adapter)
> is archived as [legacy/resend.md](./legacy/resend.md). The founding
> decision is ADR
> [resend-unified-email-provider](../decisions/resend-unified-email-provider.md),
> a v4 decision kept for its rationale.

## 0. Vision

Resend is the gateway's **outbound email** provider. One provider covers
three uses, so that there is a single catalog and a single classifier for
everything that leaves by email:

1. **Transactional email** — confirmation, password reset, notification.
   An agent sends targeted one-off emails from a verified domain.
2. **Broadcasts** — newsletters and announcements. An agent drafts a
   campaign for a curated list of contacts and, under a distinct risk,
   sends it.
3. **Sending domains** — add a domain, trigger its DNS verification,
   check its status. A provisioning agent wires up email for a project.

Resend is the provider whose primary action is _sending a message to
someone outside_. Two things therefore carry most of the risk, and the
whole model is organised around them:

- **who the email goes to** — an agent that can write to an arbitrary
  address can exfiltrate anything it has read, irreversibly;
- **how many people it reaches** — a batch or a broadcast multiplies one
  decision by tens or thousands of recipients.

Who the email comes _from_ is not a risk axis of its own: Resend only
sends from a verified domain. It is the **scope** of a mission instead.
A mission selects the domains it may send from and the contact lists it
may address, and a call outside that selection is refused.

## 1. Vocabulary

Terms of the gateway (connection, resource, mission, `RiskId`, preset,
restriction, gate, budget) are used as defined in
[vaubaan-gateway](./vaubaan-gateway.md) §0. The terms below are specific
to this provider.

| Term                | Meaning                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Account**         | The Resend account an API key authenticates. One connection is one account. Not an entity of the data model.                                                               |
| **Sending domain**  | A domain registered in the account to send from (`notifications.acme.com`). A resource.                                                                                    |
| **DNS record**      | One of the records Resend asks the domain's owner to publish (DKIM, SPF, DMARC). Published outside Resend; the only write the provider offers is the verification trigger. |
| **Segment**         | A named list of contacts that broadcasts target. Resend's former "audience" (renamed in November 2025). A resource.                                                        |
| **Contact**         | A subscriber of the account. Carries personal data: email address, first name, last name, custom properties. Belongs to zero or more segments.                             |
| **Member**          | A contact _as a member of one segment_. Synthetic: it exists so that membership (who a broadcast reaches) can be named separately from the contact itself.                 |
| **Broadcast**       | A campaign email targeting one segment. A draft until it is sent.                                                                                                          |
| **Email**           | A transactional email already sent. Only its status and metadata are read.                                                                                                 |
| **Batch**           | Several transactional emails sent in one call, at most 100.                                                                                                                |
| **Recipient zone**  | The class of a recipient relative to a sending domain: `internal`, `allowlist` or `external-unbounded`. See §4.                                                            |
| **Zone lists**      | The three lists, kept on each sending domain, that define its zones: `internal_domains`, `allowlist_domains`, `allowlist_addresses`.                                       |
| **Envelope header** | A header that decides who receives an email or who it claims to come from (`To`, `Cc`, `Bcc`, `From`, `Sender`, `Reply-To`, `Return-Path` and their `Resent-*` forms).     |

## 2. Data model

The data model follows [gateway-risk-model](./gateway-risk-model.md) §2.
Resend has **one plane**, `email`, with nine entities. Two of them are
roots that a mission selects as resources; two more are roots that
belong to the account as a whole.

```
domain[<name>]            resource, environment-scopable — the sending surface
  ├─ dns-record[*]        the records to publish for the domain
  ├─ to-zone[Z]         ★ internal | allowlist | external-unbounded
  └─ recipient-count[C] ★ batch — emitted by a batch send only
segment[<id>]             resource, environment-scopable — a contact list
  ├─ member[<contact>]  ★ a contact's membership of the segment
  └─ broadcast[<id>]      a campaign targeting the segment
contact[<id>]             account-level — personal data
email[<id>]               account-level — a sent email, status only
```

★ marks a **synthetic** entity: Resend exposes no such object. It exists
so that a risk can be named for it.

| Entity            | Parent    | Cardinality | Why it is modelled this way                                                                                                                |
| ----------------- | --------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `domain`          | —         | bounded     | Every send is rooted at the domain of its `from` address, so the domain carries both the mission scope and the environment of a send.      |
| `dns-record`      | `domain`  | bounded     | Separates "trigger a verification" from changing the domain itself.                                                                        |
| `to-zone`         | `domain`  | bounded     | Makes the recipient zone a named part of the action, so each zone has its own risk (§4.1).                                                 |
| `recipient-count` | `domain`  | bounded     | Makes bulk sending a consent of its own, independent of the zone. Its only value is `batch` (§4.2).                                        |
| `segment`         | —         | bounded     | Every broadcast and every membership change names its segment, so the segment carries the mission scope of a campaign.                     |
| `member`          | `segment` | unbounded   | Moving a contact in or out of a segment decides who a broadcast reaches; it must be distinguishable from creating or deleting the segment. |
| `broadcast`       | `segment` | unbounded   | A campaign belongs to the segment it targets. Drafting, sending and deleting are three different actions on it (§5.4).                     |
| `contact`         | —         | unbounded   | A contact is independent of segments in Resend's current model; it cannot be attached to one resource.                                     |
| `email`           | —         | unbounded   | The sending domain of an already-sent email is not known when a status read is classified; it cannot be attached to one resource either.   |

Consequence of the last two rows: **contacts and sent emails are not
confined by a mission's resource selection.** A mission that accepts a
contact risk can reach every contact of the account, whatever segments it
selected; only membership operations are confined to the selected
segments.

## 3. Connection and resources

### 3.1 Credential

A Resend connection holds **one API key**, pasted by the user who creates
the connection. There is no authorization redirect and no application
registered by the company with Resend: the user creates the key in the
Resend dashboard. Like every provider credential it is stored encrypted,
used for the duration of one upstream call, and never shown to the
executor ([vaubaan-gateway](./vaubaan-gateway.md) §2.4).

The key must be a **full-access** key. Resend also issues keys restricted
to sending; such a key cannot list domains or segments, so resource
discovery fails with it and the connection has nothing a mission could
select.

### 3.2 Resources

A connection is one Resend account. Within it, the plugin discovers two
kinds of resources:

| Kind               | Ref                                | What the owner sets on it                         |
| ------------------ | ---------------------------------- | ------------------------------------------------- |
| **Sending domain** | the domain name, lower-cased       | an environment label; the three zone lists (§4.1) |
| **Segment**        | the segment's identifier in Resend | an environment label                              |

Why these two, and not the account as a single resource (the v4 model):
a company commonly sends from a staging domain and a production domain
with the same account, and keeps a test list next to its customer list.
With one resource per domain and per segment, a mission can send freely
from the staging domain while the production domain and the customer
list stay out of reach, or reachable only under budget and approval.

Contacts and sent emails are not resources (§2). An account with no
domain and no segment yields no resource.

Discovery is bounded: a fixed maximum number of domains and of segments
is read per connection (the value is in the handbook). Beyond it, the
remaining items are not offered as resources.

### 3.3 Mission scope

A mission selects the resources it may touch
([vaubaan-gateway](./vaubaan-gateway.md) §0, "Mission"). For Resend this
selection is enforced on every call that names a resource:

- a send, or a broadcast, whose `from` address is not on a sending
  domain of the mission is refused. The match is exact: a subdomain of a
  selected domain is a different domain;
- a domain operation names its domain, and a segment, membership or
  broadcast operation names its segment; a name outside the mission is
  refused;
- a broadcast is acted on only if it really targets the segment the call
  names (§8);
- listing domains, segments or broadcasts returns only those of the
  mission.

A refusal never widens: there is no fallback to "any domain of the
account".

### 3.4 Environment labels and zone lists

Both live on the resource, and both are the owner's:

- the **environment label** is free text (`prod`, `staging`, …), as for
  every provider. Resend has no native notion of environment. §9 says
  what the label is used for;
- the **zone lists** are kept on each sending-domain resource, so two
  domains of the same account can have different notions of "internal".
  They are **empty when a domain is discovered**. An empty list matches
  nobody, so until the owner fills them every recipient of that domain is
  `external-unbounded`: the unconfigured state is the most restrictive
  one.

Refreshing a connection's resources must not erase what the owner set on
them.

## 4. Identity zoning

Zoning answers "who does this email go to?". It applies to transactional
sends, single and batch.

### 4.1 Recipient zones

Each recipient falls into exactly one zone, judged against the zone lists
of the **sending domain** of the email:

| Zone                 | A recipient is in it when                                                                  | What it means                                            |
| -------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| `internal`           | its domain is in `internal_domains`                                                        | The message stays inside the organisation.               |
| `allowlist`          | otherwise, its address is in `allowlist_addresses` or its domain is in `allowlist_domains` | It leaves the organisation, to a pre-approved recipient. |
| `external-unbounded` | otherwise                                                                                  | An arbitrary recipient: the exfiltration vector.         |

Rules:

- **All recipients count**: the union of `to`, `cc` and `bcc`.
- **The worst zone wins.** A send takes the most permissive zone among
  its recipients: one `external-unbounded` recipient among twenty
  internal ones makes the send `external-unbounded`; internal and
  allow-listed recipients together make it `allowlist`.
- **Matching is exact and case-insensitive.** A listed domain does not
  cover its subdomains.
- **Addresses are parsed, not guessed.** A display-name form
  (`Alice <alice@acme.com>`) is read as its address. An address that
  cannot be parsed, or a send without any recipient, is refused rather
  than assigned a zone.
- **The envelope cannot be rewritten on the side.** The zone is computed
  from `from`, `to`, `cc` and `bcc` only. A custom header that names an
  envelope field, a malformed header name, or a header value that is not
  a single-line string is refused: it could add a recipient or move the
  sender behind the classification.

### 4.2 Recipient count

The count marker has a **single value, `batch`**, emitted by a batch send
and by nothing else. It makes bulk sending a consent of its own: a batch
touches the risk of its zone _and_ the batch risk, and a mission needs
both.

A single send emits no count marker, whether it has one recipient or
several. Its recipients are already judged by the zone, and a marker that
no named risk covers would make every send touch the fallback risk
(§5.6).

A batch is limited to 100 emails; a larger or empty batch is refused. In
a batch, emails are grouped by sending domain, and each group is zoned on
its own, worst recipient of the group.

### 4.3 Broadcasts

A broadcast is **not zoned**. Its recipients are the members of a
segment, which are not known when the call is classified; and its blast
radius is structurally that of the whole segment. It therefore has a risk
of its own, `resend.broadcast-send`, which is self-contained: it does not
additionally require a zone risk or the batch risk. What a broadcast can
reach is controlled upstream of the send, by who may change the
membership of the segment (`resend.contact-write`) and by which segments
the mission selected.

Two rules keep the send a distinct decision:

- a broadcast cannot be dispatched as a side effect of creating or
  updating it: a create or update that asks to send or to schedule is
  refused;
- the `from` address of a broadcast must be on a sending domain of the
  mission, like any send.

## 5. Risk catalog

The catalog follows [gateway-risk-model](./gateway-risk-model.md) §4. It
has **18 entries**: 15 live named risks, the fallback, and 2 deprecated
identifiers. The catalog file shipped with the plugin is the source of
truth for labels, reasons, patterns and the six-dimension vector of each
entry; this section says what each entry covers and why it is separate.

Only one entry is environment-scoped,
`resend.send-email-external-unbounded` (§9). Every other entry is
accepted and touched under its plain identifier, whatever the label of
the resource.

### 5.1 Reads

| RiskId                     | Covers                                                                                           | Env-scoped |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ---------- |
| `resend.read-email-status` | The status and metadata of a sent email. No body content.                                        | no         |
| `resend.read-domains`      | The mission's sending domains, their DNS records and verification status, and their zone lists.  | no         |
| `resend.read-segments`     | The mission's segments, the members of a segment, and the account's contacts. **Personal data.** | no         |
| `resend.read-broadcasts`   | Campaign metadata (name, subject, status) of the mission's segments. No contact-level data.      | no         |

`read-segments` and `read-broadcasts` are separate so that the status of
a campaign can be checked without opening the contact database.

### 5.2 Transactional sends

| RiskId                                 | Covers                                                                                                  | Env-scoped           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------- |
| `resend.send-email-internal`           | A send whose every recipient is internal.                                                               | no                   |
| `resend.send-email-allowlist`          | A send whose recipients are internal or allow-listed, at least one allow-listed.                        | no                   |
| `resend.send-email-external-unbounded` | A send with at least one recipient in no zone list. Irreversible; treated as a potential secret leak.   | **`staging`, `dev`** |
| `resend.send-batch`                    | Sending a batch (up to 100 emails in one call), whatever the zone. Touched together with the zone risk. | no                   |

The three zone risks are exclusive for a given sending domain: a send
touches exactly one of them. Accepting a wider zone does not imply the
narrower ones; a mission that should send to internal and allow-listed
recipients accepts both.

### 5.3 Segments and contacts

| RiskId                 | Covers                                                                                                              | Env-scoped |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------- |
| `resend.segment-write` | Creating or deleting a segment. Deleting drops every membership it held; the contacts survive.                      | no         |
| `resend.contact-write` | Creating, updating or deleting a contact, and adding a contact to or removing it from a segment. **Personal data.** | no         |

Membership belongs to `contact-write`, not to `segment-write`: changing
who is in a list is a data change, repeated often; creating or deleting
the list is a structural change, rare, and worth a different gate.

### 5.4 Broadcasts

| RiskId                    | Covers                                                                                                                              | Env-scoped |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `resend.broadcast-draft`  | Creating or updating a broadcast that stays a draft. No effect outside the account until it is sent.                                | no         |
| `resend.broadcast-send`   | Delivering a broadcast to its segment. Bulk, irreversible, at a cost that grows with the segment. The highest risk of the provider. | no         |
| `resend.broadcast-delete` | Deleting a broadcast. A sent one loses its record only; delivered emails are not recalled.                                          | no         |

`broadcast-send` is the one entry that declares a limit the gateway
enforces: a ceiling on the rate limit a mission may set for it (§5.8).

### 5.5 Domains

| RiskId                 | Covers                                                                                                                         | Env-scoped |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| `resend.domain-write`  | Adding, updating or removing a sending domain. A posture change: it alters what the account can send from, or breaks delivery. | no         |
| `resend.domain-verify` | Asking Resend to re-check the DNS records of a domain. Idempotent, no effect beyond the attempt.                               | no         |

### 5.6 Fallback

`resend.uncategorized-write` is the catch-all required by
[gateway-risk-model](./gateway-risk-model.md) §4.3: it covers any write
that no named entry covers. Its role is to fail loudly if a new surface
is exposed before the catalog is updated.

- It counts **only when no specific entry matched** the action (ADR
  [fallback-risk-only-when-uncategorized](../decisions/fallback-risk-only-when-uncategorized.md)).
- **No tool of this provider reaches it**: every action a tool can
  produce is covered by exactly one named entry.
- **No preset includes it.** Seeing it in a refusal means a catalog entry
  is missing; accepting it by hand is never the fix.

### 5.7 Deprecated identifiers

A catalog entry is never removed or renamed. Two entries named after
Resend's retired "audiences" remain, marked deprecated, each pointing at
its replacement:

| Deprecated RiskId       | Replaced by            |
| ----------------------- | ---------------------- |
| `resend.read-audiences` | `resend.read-segments` |
| `resend.audience-write` | `resend.segment-write` |

They are kept so that the identifiers stay resolvable. No call matches
them any more and no preset offers them.

### 5.8 Limits

Scope caps are not enforced in v5.0 (ADR
[scope-caps-not-enforced-in-v5-0](../decisions/scope-caps-not-enforced-in-v5-0.md)),
and a catalog may declare only what the gateway enforces. Accordingly:

- no entry of this catalog declares a soft cap;
- `resend.broadcast-send` declares a ceiling on calls per minute, which
  bounds the rate limit a mission may set for that risk;
- the 100-email limit of a batch is not a catalog cap: it is a refusal at
  classification (§4.2).

### 5.9 Presets

The catalog ships four presets. Each is a starting policy for one
connection; the persisted mission policy is always the explicit list of
`RiskId`s with their budgets and gates, never a reference to the preset
and never a wildcard. The budgets and gates of each preset are defined in
the catalog file and are not repeated here.

| Preset               | Intent                                                                                                                                                                                          | Under approval                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `read-only`          | Email status, sending domains, campaign metadata. No personal data, no write.                                                                                                                   | —                                            |
| `developer`          | One mission per code project: the same reads, plus transactional sends to internal and allow-listed recipients. No batch, no personal data, no domain change.                                   | —                                            |
| `marketing-operator` | Contacts, segments and campaigns: reads including personal data, internal and allow-listed sends, batches, contact and segment writes, drafts, broadcast sends and deletions. No domain change. | batch sends, segment writes, broadcast sends |
| `domain-admin`       | Provisioning sending domains: read and verify freely, change them under approval. No send.                                                                                                      | domain writes                                |

No preset includes the fallback, a deprecated identifier, or
`resend.send-email-external-unbounded`. **No preset can reach a recipient
outside the zone lists**; the creator of a mission adds the
environment-qualified risk by hand (§9).

## 6. Tools

The provider exposes **27 tools**, all named `resend__<verb>_<noun>`.
Ten read, seventeen write. Resource arguments are explicit: domain tools
take the domain's ref, segment, membership and broadcast tools take the
segment's ref, and sends take their domain from the `from` address.

The plugin's own declaration groups `describe_zones` with the write
tools (9 and 18); it is counted here with the reads because that is how
it is classified.

### 6.1 Sent emails and transactional sends

| Tool                | Does                                             | Risk touched                                    |
| ------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `get_email`         | Reads the status and metadata of a sent email.   | `read-email-status`                             |
| `send_email`        | Sends one transactional email.                   | the zone risk of the send                       |
| `send_batch_emails` | Sends 1 to 100 transactional emails in one call. | per sending domain, its zone risk; `send-batch` |

### 6.2 Domains

| Tool             | Does                                                                                                                                       | Risk touched    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| `list_domains`   | Lists the mission's sending domains with their verification status.                                                                        | `read-domains`  |
| `get_domain`     | Reads one domain with its DNS records.                                                                                                     | `read-domains`  |
| `describe_zones` | Returns the zone lists and environment label of each of the mission's domains. Synthetic: answered by the gateway, without calling Resend. | `read-domains`  |
| `create_domain`  | Adds a sending domain to the account.                                                                                                      | `domain-write`  |
| `update_domain`  | Changes the tracking and TLS settings of a domain.                                                                                         | `domain-write`  |
| `delete_domain`  | Removes a sending domain.                                                                                                                  | `domain-write`  |
| `verify_domain`  | Asks Resend to re-check the DNS records of a domain.                                                                                       | `domain-verify` |

`describe_zones` lets an agent see why a send was classified the way it
was, without being able to change it: the zone lists are edited by the
owner of the connection, never through a tool.

A domain created through `create_domain` is not part of any mission
until the owner refreshes the connection's resources and a mission
selects it.

### 6.3 Segments

| Tool             | Does                                                    | Risk touched    |
| ---------------- | ------------------------------------------------------- | --------------- |
| `list_segments`  | Lists the mission's segments.                           | `read-segments` |
| `get_segment`    | Reads one segment.                                      | `read-segments` |
| `create_segment` | Creates a segment.                                      | `segment-write` |
| `delete_segment` | Deletes a segment; memberships are lost, contacts stay. | `segment-write` |

### 6.4 Contacts and membership

| Tool                          | Does                                                                        | Risk touched    |
| ----------------------------- | --------------------------------------------------------------------------- | --------------- |
| `list_contacts`               | Lists the account's contacts, or the members of one segment of the mission. | `read-segments` |
| `get_contact`                 | Reads one contact, by identifier or email address.                          | `read-segments` |
| `create_contact`              | Creates a contact, optionally as a member of a segment of the mission.      | `contact-write` |
| `update_contact`              | Updates a contact.                                                          | `contact-write` |
| `delete_contact`              | Deletes a contact.                                                          | `contact-write` |
| `add_contact_to_segment`      | Adds an existing contact to a segment of the mission.                       | `contact-write` |
| `remove_contact_from_segment` | Removes a contact from a segment of the mission.                            | `contact-write` |

### 6.5 Broadcasts

| Tool               | Does                                                       | Risk touched       |
| ------------------ | ---------------------------------------------------------- | ------------------ |
| `list_broadcasts`  | Lists the broadcasts of the mission's segments.            | `read-broadcasts`  |
| `get_broadcast`    | Reads one broadcast of a segment of the mission.           | `read-broadcasts`  |
| `create_broadcast` | Creates a draft for a segment of the mission. Never sends. | `broadcast-draft`  |
| `update_broadcast` | Updates a draft.                                           | `broadcast-draft`  |
| `send_broadcast`   | Sends a broadcast to its segment, now.                     | `broadcast-send`   |
| `delete_broadcast` | Deletes a broadcast.                                       | `broadcast-delete` |

## 7. Classification

Classification follows [gateway-risk-model](./gateway-risk-model.md) §3
(slices) and §7 (the plugin's responsibility). The classifier states what
a call does, as slices, or refuses the call. It is a pure function of the
tool, its arguments and the mission's resources: it reads no credential
and calls nobody. Whether the action is acceptable is not its decision
(§9, and [gateway-risk-model](./gateway-risk-model.md) §8).

### 7.1 Slice emission rules

Slices are rooted at the resource the call names, so that the environment
of the action is that of the resource.

| Call                                           | Slice(s)                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Single send                                    | `domain[D].to-zone[Z].W`                                                              |
| Batch send                                     | per sending domain: `domain[D].to-zone[Z].W` and `domain[D].recipient-count[batch].W` |
| Read a sent email                              | `email[E].R`                                                                          |
| List domains, describe zones                   | `domain[*].R`                                                                         |
| Read a domain                                  | `domain[D].R` and `domain[D].dns-record[*].R`                                         |
| Create a domain                                | `domain.W`                                                                            |
| Update or delete a domain                      | `domain[D].W`                                                                         |
| Verify a domain                                | `domain[D].dns-record[*].W`                                                           |
| List segments / read a segment                 | `segment[*].R` / `segment[S].R`                                                       |
| Create a segment / delete a segment            | `segment.W` / `segment[S].W`                                                          |
| List contacts, account-wide / of a segment     | `contact[*].R` / `segment[S].member[*].R`                                             |
| Read, update or delete a contact               | `contact[C].R` or `contact[C].W`                                                      |
| Create a contact                               | `contact.W`, and `segment[S].member[*].W` when a segment is named                     |
| Add a contact to, or remove it from, a segment | `segment[S].member[C].W`                                                              |
| List broadcasts / read a broadcast             | `segment[*].broadcast[*].R` / `segment[S].broadcast[B].R`                             |
| Create a broadcast / update a broadcast        | `segment[S].broadcast.W` / `segment[S].broadcast[B].W`                                |
| Send a broadcast / delete a broadcast          | `segment[S].broadcast[B].send.W` / `segment[S].broadcast[B].delete.W`                 |

`D` is the ref of a sending domain of the mission, `S` the ref of a
segment of the mission, `Z` the zone (§4.1).

Rules behind the table:

1. **One slice, one named risk.** Catalog patterns are written so that
   every slice above is covered by exactly one named entry: a contact
   write never touches `segment-write`, a broadcast send never touches
   `broadcast-draft`, and nothing reaches the fallback.
2. **Distinct actions on the same object have distinct slices.** Sending
   and deleting a broadcast end in an explicit `send` or `delete` leaf;
   without it, the slice is a draft change.
3. **A contact selected by email address is an unknown contact.** A
   contact may be named by its identifier or by its email address; the
   address is not embedded in the slice, the contact is written `*`. The
   risk touched is the same.
4. **Identifiers are checked before they are used.** An identifier that
   contains anything other than plain identifier characters, or that is
   made of dots only, is refused rather than escaped.

Refusals at classification. Each is recorded as a refused call and
nothing is executed:

- a `from` address that is missing, malformed, or not on a sending
  domain of the mission;
- a recipient that is malformed, or no recipient at all;
- an attachment, or a scheduled send (§10);
- a custom header that names an envelope field, has a malformed name, or
  has a value that is not a single-line string;
- a batch that is empty, has more than 100 emails, or contains something
  that is not an email;
- a domain or a segment that is not in the mission;
- a malformed identifier;
- a create without what it creates (a domain or segment name, a contact
  address, a broadcast's `from`);
- a broadcast create or update that asks to send or to schedule, and a
  broadcast send that asks to schedule;
- a tool this provider does not have.

### 7.2 Multi-slice examples

The examples assume a mission with two sending domains,
`notifications.acme.com` (labelled `prod`) and `staging.acme.dev`
(labelled `staging`), both with `internal_domains: [acme.com]` and
`allowlist_domains: [partner.com]`, and one segment `seg_news`.

```
# One recipient, internal
send_email { from: bot@notifications.acme.com, to: [alice@acme.com] }
  → resend.domain[notifications.acme.com].to-zone[internal].W
  touches: resend.send-email-internal

# Several recipients, the worst is allow-listed — still one slice
send_email { from: bot@notifications.acme.com,
             to: [alice@acme.com], cc: [bob@partner.com] }
  → resend.domain[notifications.acme.com].to-zone[allowlist].W
  touches: resend.send-email-allowlist

# One recipient in no zone list, from the staging domain
send_email { from: bot@staging.acme.dev, to: [someone@example.org] }
  → resend.domain[staging.acme.dev].to-zone[external-unbounded].W
  touches: resend[staging].send-email-external-unbounded

# The same from the production domain: classified the same way,
# refused at the decision (§9)
send_email { from: bot@notifications.acme.com, to: [someone@example.org] }
  → resend.domain[notifications.acme.com].to-zone[external-unbounded].W
  touches: resend[prod].send-email-external-unbounded   (never acceptable)

# A batch from one domain: two slices, two risks
send_batch_emails { emails: [
    { from: bot@notifications.acme.com, to: [alice@acme.com] },
    { from: bot@notifications.acme.com, to: [bob@partner.com] } ] }
  → resend.domain[notifications.acme.com].to-zone[allowlist].W
  → resend.domain[notifications.acme.com].recipient-count[batch].W
  touches: resend.send-email-allowlist, resend.send-batch

# A batch from two domains: one pair of slices per domain,
# each domain zoned on its own recipients
send_batch_emails { emails: [
    { from: bot@notifications.acme.com, to: [alice@acme.com] },
    { from: bot@staging.acme.dev,       to: [someone@example.org] } ] }
  → resend.domain[notifications.acme.com].to-zone[internal].W
  → resend.domain[notifications.acme.com].recipient-count[batch].W
  → resend.domain[staging.acme.dev].to-zone[external-unbounded].W
  → resend.domain[staging.acme.dev].recipient-count[batch].W
  touches: resend.send-email-internal, resend.send-batch,
           resend[staging].send-email-external-unbounded

# Reading a domain: the domain and its DNS records
get_domain { domain: notifications.acme.com }
  → resend.domain[notifications.acme.com].R
  → resend.domain[notifications.acme.com].dns-record[*].R
  touches: resend.read-domains

# Creating a contact directly into a segment: the contact and the
# membership, one risk
create_contact { email: new@example.com, segment_id: seg_news }
  → resend.contact.W
  → resend.segment[seg_news].member[*].W
  touches: resend.contact-write

# Sending a broadcast: not zoned, one risk
send_broadcast { segment_id: seg_news, id: brd_1 }
  → resend.segment[seg_news].broadcast[brd_1].send.W
  touches: resend.broadcast-send
```

## 8. Guarantees at execution

Classification says what a call _claims_ to do. Four guarantees make the
executed call match that claim.

1. **Nothing unclassified is executed.** The call is classified again
   immediately before it is executed, and a call the classifier refuses
   is not sent, whatever happened before.
2. **Only declared arguments reach Resend.** A tool forwards the
   arguments it declares and nothing else. An argument the tool does not
   declare was not read by any classification rule, so it is dropped
   rather than passed through unseen. Exposing a new Resend field is a
   deliberate change: declare it, and decide how it is classified.
3. **A broadcast is acted on only in the segment the call names.**
   Before reading, updating, sending or deleting a broadcast, the plugin
   reads it from Resend and refuses if it targets another segment. An
   executor cannot reach a broadcast of an unselected segment by naming a
   selected one.
4. **Lists are filtered to the mission.** Listing domains, segments or
   broadcasts returns only the mission's domains and segments and the
   broadcasts of those segments.

The API key itself is used for the call and never returned to the
executor ([vaubaan-gateway](./vaubaan-gateway.md) §2.4).

## 9. Environment qualification

Environment qualification follows
[gateway-risk-model](./gateway-risk-model.md) §4.4. Resend has no native
environment; the environment of an action is the **label the owner put on
the resource the action is rooted at** (§3.4): the sending domain for a
send, the segment for a broadcast or a membership change.

**One risk is environment-scoped**:
`resend.send-email-external-unbounded` is acceptable only in `staging`
and `dev`. A send, single or batch, with
at least one recipient in no zone list is decided as follows:

| Label of the sending domain | Risk touched                                    | Decision                                                      |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| `staging` or `dev`          | `resend[staging].…` or `resend[dev].…`          | allowed if the mission accepted that exact qualified `RiskId` |
| any other label             | `resend[<label>].send-email-external-unbounded` | **refused**, whatever the mission accepted                    |
| no label                    | `resend.send-email-external-unbounded`          | **refused**, whatever the mission accepted                    |

Points that follow:

- The qualified identifiers are distinct: accepting the `staging` one
  does not allow a send from a `dev` domain, and the unqualified
  identifier allows nothing.
- An unlabelled domain is never treated as a safe default. Its owner
  either labels it or fills its zone lists.
- The refusal cannot be bypassed through the risks touched alongside:
  neither `send-batch`, nor another zone risk, nor the fallback carries
  such a send.
- A batch is decided as a whole: one external send from a production
  domain refuses the entire batch, including the emails from a staging
  domain.
- **The decision is the engine's, not the classifier's.** The classifier
  reports an `external-unbounded` send as such on every domain. This
  keeps the list of acceptable environments in one place, the catalog,
  and makes the refusal a risk decision, recorded with the risk and the
  label, rather than an opaque classification refusal.

Every other risk is unscoped. Environment labels are free text chosen by
each owner, so the catalog does not restrict any other risk to a closed
list of names: an internal or allow-listed send is acceptable from any
domain of the mission, labelled or not. Separating staging from
production for those risks is done by **resource selection**: a mission
that must not send from production does not select the production
domain.

A segment may carry a label too. No risk of the current catalog depends
on it.

## 10. Out of scope

Refused when asked for (see §7.1):

| Feature                  | Why                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Attachments**          | A binary payload is an exfiltration surface that classification does not inspect.                          |
| **Scheduled sends**      | Scheduling a transactional email adds a temporal dimension to blast control that the model does not cover. |
| **Scheduled broadcasts** | Same reason; and scheduling at creation would dispatch a broadcast without touching `broadcast-send`.      |

Not exposed at all (no tool):

| Feature                     | Why                                                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **API key management**      | Creating or deleting Resend keys is a credential-minting surface; it stays with humans.                            |
| **Webhooks**                | An inbound configuration surface with no agent use identified.                                                     |
| **Templates**               | A convenience layer; agents compose the content directly.                                                          |
| **Receiving email**         | A different product surface; this provider is outbound only.                                                       |
| **Editing zone lists**      | They are the owner's control over classification; an executor reads them (`describe_zones`) and never writes them. |
| **Per-recipient decisions** | A send is decided on its worst recipient as a whole; there is no partial send to the acceptable recipients only.   |

If one of the unexposed surfaces is wrapped before the catalog names a
risk for it, its writes land on the fallback (§5.6).

## 11. Open points

- **Preset budgets are provisional.** The quotas, rate limits and gates
  shipped with the four presets are a starting point; the decision that
  should fix default values across providers has not been taken. The
  catalog records this next to the presets.
