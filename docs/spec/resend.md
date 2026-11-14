---
title: Resend provider — spec
status: stable
---

# Resend provider — spec

> **Status:** stable. _What_ the Resend provider exposes and _why_; _how_: the
> [Resend handbook](../handbook/providers/resend.md). Vocabulary:
> [vaubaan-gateway](./vaubaan-gateway.md) §0; risk model:
> [gateway-risk-model](./gateway-risk-model.md).

## 0. Vision

The gateway's **outbound email** provider: transactional emails from a verified domain, broadcasts
to a curated contact list (drafted, and under a distinct risk sent), and sending domains (add,
verify, check). The model is organised around **who the email goes to** (an arbitrary address can
exfiltrate anything the agent read, irreversibly) and **how many it reaches** (a batch or broadcast
multiplies one decision). Who it comes _from_ is the mission's scope, not a risk axis.

## 1. Vocabulary

- **Account** — what an API key authenticates; one account.
- **Sending domain** — a domain of the account to send from; a resource.
- **Segment** — a named contact list broadcasts target; a resource.
- **Contact** — a subscriber; personal data; in zero or more segments. **Member** — a contact as a
  member of one segment.
- **Broadcast** — a campaign email targeting one segment; a draft until sent. **Email** — a sent
  transactional email (status only). **Batch** — 1 to 100 transactional emails in one call.
- **Recipient zone** — a recipient's class relative to a sending domain: `internal`, `allowlist`,
  `external-unbounded` (§4). **Zone lists** — per sending domain: `internal_domains`,
  `allowlist_domains`, `allowlist_addresses`.
- **Envelope header** — a header deciding who receives or sends (`To`, `Cc`, `Bcc`, `From`,
  `Sender`, `Reply-To`, `Return-Path`, their `Resent-*`).

## 2. Data model

One plane, `email`: `domain` (with `dns-record`, and the synthetic `to-zone` and
`recipient-count[batch]`), `segment` (with the synthetic `member`, and `broadcast`), `contact`,
`email`. Synthetic entities exist so a risk can be named for them.

- `domain` roots every send, so it carries the mission scope and the environment of a send;
  `segment` carries a campaign's.
- **Contacts and sent emails are not confined by resource selection**: a contact risk reaches every
  contact of the account; only membership is confined to the selected segments.

## 3. Account and resources

### 3.1 Credential

One **full-access API key**, pasted; a sending-only key cannot list domains or segments, so nothing
could be selected.

### 3.2 Resources

One resource per sending domain (ref: the lower-cased name) and per segment (its id), each with an
owner's environment label; a domain also carries the three zone lists. Discovery reads a bounded
number of each.

### 3.3 Mission scope

- A send or broadcast whose `from` is not on a mission domain is refused; exact match, a subdomain
  is another domain.
- An operation naming a domain, segment, membership or broadcast outside the mission is refused; a
  broadcast is acted on only if it really targets the named segment (§8).
- Lists of domains, segments and broadcasts return only the mission's. A refusal never falls back to
  "any domain of the account".

### 3.4 Environment labels and zone lists

Both belong to the owner. Zone lists are **empty at discovery**: an empty list matches nobody, so
every recipient is `external-unbounded` until filled. A resource refresh never erases what the owner
set.

## 4. Identity zoning

### 4.1 Recipient zones

Against the zone lists of the email's sending domain: `internal` when its domain is in
`internal_domains`; else `allowlist` when its address or domain is listed; else
`external-unbounded`.

- All recipients count (`to` ∪ `cc` ∪ `bcc`); **the worst zone wins**.
- Matching is exact and case-insensitive; a listed domain does not cover its subdomains.
- Addresses are parsed (`Alice <alice@acme.com>` reads as its address); an unparseable address, or
  no recipient, is refused.
- The zone uses `from`, `to`, `cc`, `bcc` only: a custom header naming an envelope field, a
  malformed header name or a multi-line value is refused.

### 4.2 Recipient count

Only a batch emits `batch` and touches its zone risk _and_ the batch risk; a single send emits no
count. A batch of 0 or over 100 emails is refused; its emails are grouped by sending domain, each
group zoned on its own worst recipient.

### 4.3 Broadcasts

Not zoned (members are unknown at classification). `resend.broadcast-send` is self-contained; reach
is controlled by who may change membership and which segments the mission selected. A create or
update asking to send or schedule is refused.

## 5. Risk catalog

Ids are `resend.<name>`; the catalog file holds labels, patterns and vectors.

### 5.1 Reads

`read-email-status` (no body); `read-domains` (with zone lists); `read-segments` (members and the
account's contacts: **personal data**); `read-broadcasts` (campaign metadata, no contact data, so a
campaign is checked without opening the contacts).

### 5.2 Transactional sends

`send-email-internal`, `send-email-allowlist` (at least one allow-listed),
`send-email-external-unbounded` (at least one in no list; the only env-scoped risk, §9), and
`send-batch` touched together with the zone risk. Zone risks are exclusive per domain; a wider zone
does not imply the narrower.

### 5.3 Segments and contacts

`segment-write` (create or delete a list) apart from `contact-write` (contacts and memberships,
**personal data**), worth different gates.

### 5.4 Broadcasts

`broadcast-draft` (no outside effect), `broadcast-send` (bulk, irreversible, the highest risk),
`broadcast-delete` (a sent one loses its record; nothing is recalled).

### 5.5 Domains

`domain-write` (posture change, may break delivery); `domain-verify` (idempotent).

### 5.6 Fallback

`resend.uncategorized-write`: no tool reaches it; seeing it in a refusal means an entry is missing,
and accepting it by hand is never the fix.

### 5.7 Deprecated identifiers

`read-audiences` → `read-segments`, `audience-write` → `segment-write`: resolvable, matched by
nothing.

### 5.8 Limits

Only `broadcast-send` declares a per-minute ceiling (gateway-risk-model §4bis); the 100-email batch
bound is a classification refusal, not a cap.

### 5.9 Presets

- `read-only` — status, domains, campaign metadata; no personal data, no write.
- `developer` — the same plus internal and allow-listed sends; no batch, no personal data, no domain
  change.
- `marketing-operator` — reads with personal data, internal and allow-listed sends, batches,
  contacts, segments, broadcasts; batch sends, segment writes and broadcast sends under approval; no
  domain change.
- `domain-admin` — read and verify domains freely, change them under approval; no send.
- **No preset reaches a recipient outside the zone lists**: the creator adds the qualified risk by
  hand.

## 6. Tools

Resource arguments are explicit (the domain ref, the segment ref, the domain of `from`).
`describe_zones` is answered by the gateway without calling Resend, so an agent sees why a send was
zoned so. Zone lists are never edited through a tool. A domain created by a tool joins no mission
until discovered and selected.

## 7. Classification

A pure function of tool, arguments and mission resources (gateway-risk-model §3, §7); acceptability
is not its decision (§9).

### 7.1 Slice emission rules

1. Slices are rooted at the named resource, so the action's environment is the resource's.
2. **One slice, one named risk**: every slice matches exactly one named entry, never the fallback.
3. **Distinct actions, distinct slices**: a broadcast send or delete ends in a `send` or `delete`
   leaf; without one it is a draft change.
4. A contact named by address is written `*`; identifiers are checked, not escaped (anything but
   plain identifier characters, or dots only, is refused).
5. Refused at classification: a `from` missing, malformed or off the mission; a malformed or missing
   recipient; an attachment or scheduled send (§10); a forbidden header (§4.1); a malformed batch
   (§4.2); a resource outside the mission; a create missing what it creates; a broadcast create,
   update or send asking to send or schedule; an unknown tool.

### 7.2 Multi-slice examples

A batch from two domains emits a zone slice and a batch slice per domain and touches each domain's
zone risk plus `send-batch`; a contact created into a segment emits a contact and a member slice and
touches `contact-write` only.

## 8. Guarantees at execution

1. The call is classified again right before execution; a refused call is not sent.
2. **Only declared arguments reach Resend**; exposing a new field means declaring and classifying
   it.
3. Before reading, updating, sending or deleting a broadcast, the plugin checks it targets the named
   segment.
4. Lists are filtered to the mission.

## 9. Environment qualification

The environment is the owner's label on the resource the action is rooted at.
`send-email-external-unbounded` is acceptable in `staging` and `dev` only:

- from a `staging` or `dev` domain, allowed if the mission accepted that exact qualified id (the
  `staging` one does not allow `dev`);
- from any other label, or an unlabelled domain, **refused whatever the mission accepted**; no other
  risk touched alongside carries it, and one such email refuses the whole batch.
- Every other risk is unscoped: staging versus production for those is done by resource selection.

## 10. Out of scope

- Refused when asked: **attachments**, **scheduled sends**, **scheduled broadcasts**.
- Not exposed: API key management, webhooks, templates, receiving email, editing zone lists,
  per-recipient decisions (a send is decided whole on its worst recipient).

## 11. Open points

- **Preset budgets are provisional**: the cross-provider decision on default quotas, rates and gates
  is not taken.
