---
title: Stripe provider plugin
tracks:
  - plugins/stripe/src/
  - plugins/stripe/README.md
last_reviewed: 2026-10-27
---

# Stripe provider plugin — handbook

`@vaubaan/plugin-stripe`: one connection holds an optional test key and an optional live key;
discovery writes one resource per mode (`acct_…/test`, `acct_…/live`).

## Start here

- [`src/resources.ts`](../../../plugins/stripe/src/resources.ts) — the mode of a resource,
  `resolveStripeResource`, the id grammars.
- [`src/classify.ts`](../../../plugins/stripe/src/classify.ts) — pure; slices rooted at
  `account[<ref>].mode[<mode>]`.
- [`src/execute.ts`](../../../plugins/stripe/src/execute.ts) — `ROUTES`, form-urlencoded bodies,
  discovery.

## Invariants

- **The mode comes from the key, never from the `env` label**: `modeOf` reads the ref suffix, then
  `metadata.mode`; `execute` picks the key from the mode. A resource whose mode cannot be read is
  refused in classify and execute.
- **The label must equal the mode**: every risk is env-scoped on `[test, live]` and the engine
  qualifies from the label, so the classifier refuses a resource whose label is absent or differs,
  and a live call is never judged as `stripe[test].…`. Both layers are pinned in `policy.test.ts`;
  the host keeps the plugin-set label read-only.
- The fallback is env-scoped too, so a mission on the test mode never accepts a live write.
- **Only declared arguments**: the classifier refuses any key outside `declaredArgsOf(tool)`;
  declaring a property means deciding its cost in `classify.ts`.
- **Customer PII overlay**: every read whose answer carries customer fields (invoices, charges,
  payment intents, events embedding their object) also emits `customer[C].pii.R`, so billing history
  is grantable without identities. `list_events` drops it only for a `type` naming a family without
  customer payload.
- **Only "absent or an explicit no" avoids the stronger slice**: a `cancel_at_period_end` other than
  `false` or a non-empty `cancel_at` makes an update a cancellation; `auto_advance` other than
  `false` makes `create_invoice` a finalization. `execute` sends `auto_advance=false` when unset,
  whatever the account's API version defaults to.
- `STRIPE_ID` must start with a letter or digit: `/customers/..` would reach `/v1/`. It also admits
  account-chosen ids (`SUMMER-25`)
  ([ADR](../../decisions/plugin-identifiers-one-grammar-for-classify-and-execute.md)).

## Traps

- A trailing `[**]` in the catalog matches zero identifiers too, so one slice can touch two entries
  (e.g. `subscription.W` touches create and update); `risk-catalog.test.ts` pins the sets.
- The answer of a write is not modelled as a read.
- `account` is consumed by the gateway, never sent.

## Outside the repo

- Paste the secret key of the sandbox (`sk_test_…`) and/or of live mode in their own fields; the
  guide asks for secret keys (a restricted key fails tool by tool). Checked at paste with
  `GET /v1/account` per key; a restricted key that may not read its account is refused.

## Debug

- `account: argument missing and the mission touches 2 Stripe resources` → the mission holds test
  and live; pass `account`.
- `this connection has no live-mode key` → re-run discovery.
- `… is a live-mode resource but its environment label is not 'live'` → label and key mode diverge;
  re-run discovery.
- `list_invoices` refused with `read-customer-pii` missing → the PII overlay; `read-only` leaves it
  out.
- `uncategorized-write` missing → a catalog entry is missing.
