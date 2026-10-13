---
title: A claim's "reset the period" resets the claimed risk only; the extension cap stays
status: accepted
date: 2026-10-13
amends:
  - claim-resolutions-as-counter-credits
---

# A claim's "reset the period" resets the claimed risk only; the extension cap stays

> Product owner's decision of 2026-10-13 (question 12 of the final pass). Spec:
> [vaubaan-gateway §3.4](../spec/vaubaan-gateway.md). Handbook:
> [requests, "A claim is about one risk"](../handbook/requests.md#a-claim-is-about-one-risk-and-so-is-its-answer).

## Context

[claim-resolutions-as-counter-credits](./claim-resolutions-as-counter-credits.md)
made "reset the period" zero **every** counter of the mission's current
period, and rejected the narrower reading because it made the reset "a synonym
of extending the quota by everything consumed".

The wide reset had a cost that only showed with two exhausted risks. A claim
names one risk; the creator reads that risk on the request page, with the
others listed as remainders. Granting a reset for "read code" also reopened
"merge to a protected branch" when that one was exhausted too — a grant the
creator was not asked for, on a risk whose own claim sat unanswered in the
same inbox.

## Decision

- **Reset the period** sets the counter of the **claimed risk** to zero for
  the mission's current period. No other risk is touched.
- **Extend the quota** is unchanged: `1 <= amount <= consumed` on the claimed
  risk, current period only. The cap stays.
- A claim never grants anything on a risk it does not name.

The store's claim context offers `resetCounter(periodStart, riskId)` and no
"reset everything": both budget resolutions go through the same conditional
`UPDATE … WHERE consumed >= ?` on one risk.

The `reset` event keeps its shape; `credits` holds the claimed risk alone
(empty when nothing was consumed). Events written before this decision list
several risks and are read as they are.

## Consequences

- The two budget resolutions now differ by the amount (all, or a number) and
  by the event and audit act they leave. The redundancy the earlier ADR
  avoided is accepted: "start this risk's period again" is a sentence a
  creator understands without counting, and it is the label the spec names.
- With several exhausted risks the creator answers several claims. Each is in
  the inbox with its own risk.
- The option's sentence on the request page says how many actions are given
  back, and that the other risks keep what they consumed.
- No migration: counters and events are written the same way.

## Rejected alternatives

- **Keep the wide reset and say so on the page.** The creator would still
  grant, on a claim about one risk, room on risks nobody asked about.
- **Remove "reset the period" and keep the extension alone.** The spec names
  four answers, and a reset needs no number.
- **Lift the extension cap to tell the two apart.** An unbounded extension is
  a change of the mission's policy, which a claim never makes.
- **A second resolution, "reset every risk".** Nobody asked for it; a creator
  who wants a mission with more room edits or re-issues it.
