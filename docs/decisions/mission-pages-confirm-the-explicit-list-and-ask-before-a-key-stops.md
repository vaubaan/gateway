---
title: The mission pages confirm the explicit list before creating, and ask before a key stops
status: accepted
date: 2026-10-13
---

# The mission pages confirm the explicit list before creating, and ask before a key stops

> Decided while the mission pages were rebuilt on the design system (step R2b of
> [interface-redesign-vocabulary-and-design-system](interface-redesign-vocabulary-and-design-system.md)).
> Handbook: [missions](../handbook/missions.md), "The mission pages". Spec:
> [style-guide](../spec/style-guide.md) §1, §5.

## Context

The redesign moved the mission pages from "everything on the page" to "what a person
acts on, the rest one click away". Four points had to be settled where the mock-ups,
the attention budget and what the gateway can do today pulled in different directions.

1. **Where is the explicit list read before a mission exists?** The rail of "New
   mission" sums a policy up in three lines per account, as the mock-ups draw it, and
   the attention budget holds a default view to about twenty data points. The security
   property is the opposite pull: a person must be able to see exactly what a key will
   allow, permission by permission, in what quantity, before it is created — and a
   preset must never stand for a list nobody read.
2. **Replacing a key.** The cold audit found that rotating a key revoked the old one at
   once, without a question. The mock-up answers with a dialog that offers two ways:
   "stop the current key now" or "keep it working for one hour". The gateway has one
   behaviour: a replaced key is retired in the same transaction as the new one is
   stored.
3. **A machine key** has no "replace": the server knows "revoke" and "create", and a
   name identifies one working key.
4. **Whose words are the reasons a draft cannot be created?** `PreviewIssue.message` is
   written by `previewDraft`, which also answers an agent on the management door. It
   says "connection", "risk", "authority", "budget".

## Decision

1. **"Create mission" asks once, and what is confirmed is the explicit list.** The
   button of the rail opens a dialog whose body lists every permission of the draft, by
   account, with its limit per period and per minute and whether it asks first; that
   list is what is sent and what the server checks again. The rail stays a summary that
   counts. The editor stays one click from any preset.
2. **Replacing a key always asks first and states the one consequence that exists**: the
   current key stops working at once, for whom, and what does not change. The dialog
   offers no grace period, because the gateway has none to offer. A first key
   ("Generate my key") is not confirmed: nothing stops.
3. **"Replace key" on a machine key is two requests from the page** — revoke, then
   create a key of the same name — behind the same confirmation. If the second fails
   the dialog says so; the key is then revoked and the name is free.
4. **The page words the reasons itself, from the code and the fields of the issue**
   (`issueSentence`), and prints the server's message when it has no sentence of its
   own. The protocol's messages do not change.
5. **What cannot be undone is typed**: stopping a mission (its name), removing a
   teammate and revoking someone's key (their address), revoking a machine key (its
   name).
6. **The kit's instructions for the agent use the interface's words** — key, permission,
   limit, account, "asks the mission creator first" — around the protocol's names, which
   do not move: the refusal codes, the fields (`missing_risks`, `claim_url`,
   `token.holder`), the variable `VAUBAAN_MISSION_TOKEN`, the MCP configuration.

## Consequences

- One more click to create a mission than in the mock-up, on the one act that hands
  out authority. The browser test reads the list in the dialog (a permission by its
  name and its id, an adjusted limit, what asks first) before it confirms.
- The dialog of "Replace key" is shorter than the mock-up's. A grace period would be a
  capability of the gateway — a retired key that still authenticates until an instant —
  with its own threat analysis; it is listed as an open point, not simulated in the
  page.
- Replacing a machine key is not atomic. The window is one request long and ends with
  the old key revoked in every case, which is what the person asked for; the audit
  holds two entries (a revocation, an issuance) instead of one rotation.
- Two wordings of the same refusal exist: the server's, for an agent, and the page's,
  for a person. A new issue code is shown with the server's words until the page gets
  its sentence; a unit test checks that the sentences of the page hold no protocol
  word.
- `/agent-bootstrap.md`, the generic companion of the kit, still uses the earlier
  words. It is served to agents, belongs to no page of this step, and is left to the
  finishing step.
- A teammate cannot leave a mission by themselves: no such act exists on the server.
  They revoke their own key; the creator removes them.

## Rejected alternatives

- **The explicit list always open in the rail.** Twenty-six rows in a column of 300 px
  bury the summary and the button the rail exists for, on every keystroke.
- **The explicit list behind a disclosure of the rail, without a confirmation.** It
  keeps the property reachable and lets a person create a mission without ever having
  seen the list.
- **A second page ("Review") before creating.** It loses the form's state on a
  browser's Back and adds a route for what is one question.
- **Drawing the two options of the mock-up and treating "keep one hour" as "stop
  now".** A dialog that states a consequence the system does not honour is worse than
  the missing confirmation the audit found.
- **Hiding "Replace key" on machine keys.** The person would have to discover "revoke,
  then create with the same name" by themselves, which is the procedure the page can
  state and run.
- **Rewriting `PreviewIssue.message` in the interface's words.** The same text answers
  agents on the management door, where "risk" and "connection" are the names of the
  fields they fill.
