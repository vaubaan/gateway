---
title: Resend provider plugin
tracks:
  - plugins/resend/src/
  - plugins/resend/README.md
last_reviewed: 2026-10-27
---

# Resend provider plugin — handbook

`@vaubaan/plugin-resend`: sends, domains, contacts, segments and broadcasts. Zones, envelope headers
and the catalog rationale are product rules: spec [`resend.md`](../../spec/resend.md).

## Start here

- [`src/zones.ts`](../../../plugins/resend/src/zones.ts) — `parseAddress`, the zone of an address,
  the worst zone of a send.
- [`src/resources.ts`](../../../plugins/resend/src/resources.ts) — resource kinds and every
  identifier grammar, shared by classify and execute.
- [`src/classify.ts`](../../../plugins/resend/src/classify.ts) — pure; `from` **is** the resource.
- [`src/execute.ts`](../../../plugins/resend/src/execute.ts) — re-runs the classifier, builds each
  request field by field.

## Invariants

- **One string is one address**: the field is zoned on the parsed address and sent as given, so a
  string a mail API could split into several recipients is refused (no `,` `;` `@` `"` `\`, angle
  bracket or control character in the display name; no `,` `;` in the local part). Several
  recipients are an array.
- Empty zone lists make every recipient `external-unbounded` (fail closed).
- The env refusal of an external send is the **engine's** (`risk-not-accepted`), not the
  classifier's: the env list lives once, in the catalog, and a touched env-scoped risk is never
  dropped. Pinned by `tests/unit/mission-evaluation.test.ts`.
- A single send carries no recipient-count marker: a `single` / `multi` marker would hit the
  fallback, which no macro-action carries.
- Undeclared arguments are **ignored, not refused**: only what the tool's `inputSchema` declares is
  forwarded (`declaredFieldsOf`, per batch email too); resource arguments go in the path or are
  re-resolved, never copied into the body.
- Ids are interpolated as they are, never repaired
  ([ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md));
  `encodeURIComponent` would leave `..`, and `/emails/..` becomes `/`. Only a contact address is
  percent-encoded. The contact id Resend answers to `POST /contacts` is checked before the
  membership call.
- A broadcast named by `id` is first read, and the call declined when its `segment_id`
  (`audience_id` on older payloads) differs from the mission's. `send` on a broadcast create or
  update is refused, even `false`.
- `list_domains` / `list_segments` / `list_broadcasts` are filtered to the mission; `list_contacts`
  is not (contacts are account-level).

## Traps

- Resend renamed audiences to segments (Nov 2025); the old risk ids stay as deprecated with
  `replaced_by`.
- A 403 is a `validation_error` when the `from` domain is unverified, not an auth failure; any other
  403 is `UpstreamAuthError`.
- The created-resource hook reads the new domain or segment from Resend's answer; a new domain has
  empty zone lists, so it sends externally to nobody until the owner fills them.
- `create_contact` with `segment_id` is two calls; an answer without a valid `id` stops before the
  second.

## Outside the repo

- A **Full access** API key, checked at paste with `GET /domains` (the domains name the account); a
  Sending access key answers `401 restricted_api_key` and is refused with the permission to choose.
- The owner labels each sending domain and fills its zone lists in the gateway; nothing in Resend
  holds them.

## Debug

- `from: 'x' is not a sending domain of this mission` → select the domain; a subdomain is not the
  verified domain.
- Every send is `external-unbounded` → zone lists empty or the recipient domain not listed exactly;
  `describe_zones` shows what the classifier sees.
- `carries no domain_id` → refresh the account's resources.
- `… acceptable only in [staging, dev]` → add the recipient to the zone lists, or send from a
  `staging` / `dev` domain.
- A field missing upstream → not declared in `tools.ts`; declare and classify it.
