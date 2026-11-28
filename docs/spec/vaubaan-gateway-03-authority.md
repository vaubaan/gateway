---
title: Vaubaan Gateway spec §3 — Authority — composing restrictions
status: draft
---

# Vaubaan Gateway spec — §3 Authority — composing restrictions

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §3").

## 3. Authority — composing restrictions

### 3.1 The chain

```
Account owner              authority = the service's full risk catalog
   │ share (restriction R1)
   ▼
Beneficiary (user or group)   authority = R1
   │ issues a mission (accepted_risks A1 ⊆ R1)
   ▼
Mission                       authority = A1, budget B1
   │ presented by every agent of the mission
   ▼
Executor(s)                   same token, same budget, optional agent label
```

- **Monotonicity.** Each stage is a subset of the one above; exceeding it is refused at issuance
  with the explicit list of uncovered `RiskId`s.
- **Enumeration.** No stage says "everything". "Select all" and `everything-i-hold` record the list
  resolved at the click or at issuance; a risk added to the risk catalog, or a widened authority, later
  does not widen the mission.
- **Union of shares.** Several shares on one account (direct and through groups) give the union
  of the restrictions.
- **The owner needs no share** to issue missions on their account.
- **Several accounts of one service in a mission**, each checked against the creator's authority
  there, each with its own resources, sets and budget. A call runs with **the account holding the
  resource it names**, or the account the agent names (`vaubaan_account`, §4.1); a call that names
  neither while two accounts of its service could serve it is refused `account-ambiguous` (§4.1),
  never sent to one of them by default; so is a call naming resources of two of them.
- **Resource sets.** Within one account, a mission can give different resources different
  policies and budgets. Each resource belongs to one set. A call that cannot be placed in one set is
  judged by the strictest of its candidate sets (risk model §4.7).
- **Resource selection.** A mission names, per account and per set, the resources it may touch:
  an explicit list, all of one environment (a label, or none). A call citing a resource outside it is refused
  `resource-not-in-mission` before any risk is evaluated. **What a mission creates, it reaches**: a
  resource it creates through the gateway with a declared creating tool joins its selection right
  after that call, marked "created by this mission" and audited
  ([created-resources-join-the-mission](../decisions/created-resources-join-the-mission.md)). One
  first seen less than 15 minutes ago is not dropped by a discovery that does not list it yet. Any
  other later resource is not covered until the creator edits the mission — unless the set has
  **future resources** on, chosen explicitly and never a default: then a resource that later
  appears with the set's environment (discovered, or relabelled into it), neither hidden nor the
  instance's own nor held by another set of the mission, is written into the set's list and audited
  on the mission. A resource relabelled out of a set's environment leaves the set; it joins the set
  of its new environment with future on, else it leaves the mission
  ([resource-set-is-one-environment-with-optional-future-resources](../decisions/resource-set-is-one-environment-with-optional-future-resources.md)).
  An unlabelled resource enters a set only on a service whose risk catalog has no env-qualified risk.
  Environment-qualified risks are checked at issuance against the resources known then.
- **The instance's own resources** — what hosts or runs the instance (where the plugin can tell, or
  as the operator lists in the configuration) — are never mission resources: not offered, a draft
  selecting one refused, a call citing one refused `resource-not-in-mission`, and the account page
  says why; on an account that hosts the instance, a tool that cannot be bound to one resource is
  refused
  ([self-resources-never-reachable-by-a-mission](../decisions/self-resources-never-reachable-by-a-mission.md)).

### 3.2 The budget

A policy is complete only with budget and gate for every accepted risk: the gateway refuses to issue
a mission whose accepted risk has no resolved budget.

- **Unit.** One action = one allowed call touching the `RiskId`. A call touching N risks decrements
  N counters; a refused call decrements nothing.
- **Quota.** Actions per period, always a number: no infinite budget. At zero the risk is
  `exhausted` until the next period or a granted claim.
- **Rate limit.** The mission-level value of the risk catalog's speed cap
  ([gateway-risk-model](./gateway-risk-model.md) §4bis), bounded by the risk catalog.
- **Macro-actions and trust levels**
  ([macro-actions-and-trust-levels-prefill-the-policy](../decisions/macro-actions-and-trust-levels-prefill-the-policy.md)).
  At issuance the creator ticks macro-actions per account, each at a trust level (or duplicates a
  mission); the policy is pre-filled with their risks, gates and budgets, intersected with the
  creator's authority, then adjusted risk by risk. The persisted policy never references a
  macro-action or a trust level, so a changed risk catalog alters no mission; the trust levels are recorded with the
  mission only to redraw the form. The interface shows what each macro-action yields at its trust level
  (how many run freely, ask first, are left out) and the account's highest row.
- **`everything-i-hold`**
  ([preset-everything-i-hold-expands-explicitly](../decisions/preset-everything-i-hold-expands-explicitly.md)).
  At preview and issuance it expands to one line per non-deprecated `RiskId` the creator's authority
  covers now and the selected resources can reach (an environment-qualified id only when a selected
  resource carries that label, own or default, or the plugin derives the environment), the fallback
  included and named. Each line gets the risk catalog's rate ceiling (else its base budget's rate at
  Autonomous, else a value by row), its base budget's quota at Autonomous (else by row) sized
  for a daily period, and gate `auto`. The preview states the line count, the hardest to repair,
  which lines that cannot be repaired (row 4) run freely, and the fallback; no gate is added silently.
- **Editing a mission**
  ([mission-editable-after-issuance](../decisions/mission-editable-after-issuance.md)). The creator
  may edit a mission while it is not revoked or orphaned — never an agent: name, expiry,
  accounts, per account the resources, permissions, and per permission its quota, rate limit
  and gate. **Never its period**: a mission needing another is duplicated. The gates of an expired
  mission stay editable. An edit is judged by issuance's own check applied to what it moves, with
  the words a creation asking the same would get; a fact unrelated to the change does not refuse
  narrowing. It applies at once to the same tokens, mission log and counters: consumed stays consumed
  (even when a removed permission is added again), a quota lowered below it leaves the risk
  `exhausted` until the next period, an added permission starts at zero, a removed one is refused
  from the next decision; a call reads the limits and gates in force when it is decided. Setting
  `approval` on a gate opened for the period ends the opening. Requests a removal makes moot are
  closed with that reason. An edit started from a mission that changed meanwhile is refused. Every
  edit is one administrative act carrying before and after per section moved.
- **One budget per mission**, however many agents or tokens. Distinct budgets mean two missions.

### 3.3 The mission log and the remaining budget

- Born on the first call with the mission's token.
- Holds, per `RiskId` and period, the actions consumed; the remainder is computed without re-reading
  the audit.
- Period rollover is computed on read, never by a background task.
- The mission log is the truth for the budget, the audit for what happened; they must agree (§10).

### 3.3 bis Editing permissions and asking for a missing permission

- The creator adds and removes permissions by editing the mission (§3.2); additions need explicit
  limits and a gate, validated against the creator's current authority.
- A missing-permission refusal opens no request. The agent may request its missing permissions,
  citing that refusal's reference (valid 15 minutes, bound to the authenticated mission and token)
  and saying why the task needs them
  ([permission-request-asked-by-the-agent](../decisions/permission-request-asked-by-the-agent.md)).
  The request holds the observed tool and missing permissions; the justification is marked as the
  agent's text.
- Only the creator answers: add the permissions with explicit budgets and gates, or refuse. An
  answer never executes the call; the agent retries.
- An open request with the same mission, holder and missing permissions is reused; a used reference
  returns its existing request, even after a decision. At most ten new permission requests per
  mission per rolling 24 hours.

### 3.4 Requests to the creator — the claim

Claims and approval requests are automatic: the gateway refuses the call, drops a request in the
creator's inbox and puts its URL in the refusal. The executor or its human forwards the URL.

- The request page requires a sign-in and checks the user is **the mission creator**; anyone else is
  refused, a beneficiary of the same share or a member included.
- The creator sees the mission log, the risk, the other risks' remainders, and chooses: reset
  the period, extend the quota, extend the expiry, or refuse. **A claim is about one risk, and so is
  its answer**: reset zeroes that risk's counter for the current period; extend gives back at most
  what the period consumed on it. A larger quota, or room on another risk, is an edit (§3.2).
- The claim produces an event; the token does not change; the executor replays. A refused or expired
  claim leaves the risk `exhausted` until the next period.

### 3.5 Requests to the creator — the approval

- A call touching a risk gated `approval` is refused `approval-required` with the URL of an approval
  request; nothing executes, nothing is held. A call touching several risks, one gated, is refused
  as a whole; several gated risks make **one request** listing them all
  ([one-approval-request-covers-the-call](../decisions/one-approval-request-covers-the-call.md)).
- The request shows the tool, the **arguments in clear**, the slices touched, the remaining budget —
  an argument the plugin declares secret is shown as a short fingerprint
  ([secret-arguments-masked-in-the-approval-view](../decisions/secret-arguments-masked-in-the-approval-view.md)).
  Arguments are kept encrypted for the request's lifetime, then erased; only their fingerprint stays
  in the audit.
- A grant produces an approval bound to `(mission, tool, argument fingerprint)`, covering only the
  gated risks the request listed, single-use, valid a short configured time from the grant. The
  executor replays **identically**; arguments different by one byte ask again.
- The creator may instead **open the gate for the rest of the period**: the risk is `auto` until the
  next reload (a mission log event).
- The gate does not replace the budget: an approved action counts against quota and rate limit.
- All requests share the inbox, sign-in, states and expiry delay; an unanswered approval request
  expires like a claim, its arguments erased then. A request on an orphaned mission cannot be
  granted and expires on the same delay.

Every refusal calling for more authority goes to a human: `budget-exhausted` through a claim,
`approval-required` through an approval request, `risk-not-accepted` through a permission request or
an edit.
