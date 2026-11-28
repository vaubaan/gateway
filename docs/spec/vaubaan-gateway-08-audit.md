---
title: Vaubaan Gateway spec §8 — Audit
status: draft
---

# Vaubaan Gateway spec — §8 Audit

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §8").

## 8. Audit

One entry per call, allowed or refused, and per administrative act.

- **A call**: timestamp, mission, token and its holder, account and resource ref, tool, argument
  hash, slices executed, risks touched, snapshot of accepted risks (each distinct snapshot stored
  once, [audit-risk-snapshot-stored-once](../decisions/audit-risk-snapshot-stored-once.md)),
  decision and refusal reason, approval consumed, remaining budget after the call for each risk it
  touched, agent label, upstream latency, bytes sent to the service and received from it (a
  forwarded call only: what the arguments or a git push's pack weighed, what the result or a fetch's
  pack weighed; nothing for a refused call), client origin. Risk field shapes:
  [gateway-risk-model](./gateway-risk-model.md) §12.
- **An administrative act**: timestamp, user, act, object, previous and new state when meaningful,
  and, when it came through the `vaubaan` plugin (§4.1 bis), the mission whose key made the call
  (that call is also in the mission's own activity, like any call). Acts include every change of
  account, share, mission (issuance, edit, extension, reset, approval, rotation, a lost or
  regained account naming the human whose act did it, orphaned or restored), member,
  administrator, admin rule, sign-in provider, second factor, master-key recovery and configuration.
  Entries written by the retired management door keep naming its client (history).
- **Who reads what**: a user reads the entries of missions they created, of missions they are a
  member of now (a removed member reads none, past ones included) and of accounts they own; an
  operator reads every entry, and alone those about groups and users; the bootstrap token reads
  administrative entries and no call. Nobody reads arguments; their fingerprint is shown only to who
  answers for the call (the mission's creator, an owner of its account).
- **Retention** is configured, 90 days by default; no cold archive. It also purges mission log history
  (timeline events, counters of periods ended longer ago) and never what the current period rests on
  (its counters, gates opened until it ends, credits given back by granted claims). A one-off
  mission's counters stay as long as the mission. The versions of a mission's configuration
  (§4.2 "History") are not audit: retention never purges them; they stay as long as the mission
  ([mission-versions-kept-with-the-mission](../decisions/mission-versions-kept-with-the-mission.md))
  and are in every backup.
