---
title: Vaubaan Gateway spec §11 — v1 decisions & open questions
status: draft
---

# Vaubaan Gateway spec — §11 v1 decisions & open questions

Part of the [Vaubaan Gateway spec](vaubaan-gateway.md); section numbers are the ones the code and the docs cite ("spec §11").

## 11. v1 decisions & open questions

### 11.1 Settled decisions

The rules above are settled; their reasons live in the ADRs they link, and in
[pivot-v4-to-v5-on-prem-mission-tokens](../decisions/pivot-v4-to-v5-on-prem-mission-tokens.md),
[interface-redesign-vocabulary-and-design-system](../decisions/interface-redesign-vocabulary-and-design-system.md),
[github-sign-in](../decisions/github-sign-in.md),
[gmail-over-imap-with-an-app-password](../decisions/gmail-over-imap-with-an-app-password.md) and the
telemetry decision linked from §9. A question an ADR settles leaves §11.2.

### 11.2 Open questions

Not decided, or a v1 assumption usage may overturn.

- **Local groups.** Without sign-in provider groups, may any user create a group? v1: operator only.
- **Transfer to a group one is not a member of?** v1: no; the operator can through `unowned`.
- **Quantities in shares.** Should a share carry a budget ceiling per risk? v1: no; revisit if
  beneficiaries grant themselves unreasonable budgets.
- **Transitive sharing.** v1: no, only the owner shares.
- **Answering from a notification.** v1: none, not even a refusal. Revisit if creators ask to
  refuse from the lock screen without opening the interface.
- **Notification digest.** v1: one notification per event. A daily mail digest for alerts?
- **Gate in shares**, approved by the account owner? v1: no, the gate lives in the mission.
- **Resources in shares.** v1: no; a beneficiary may touch any resource within the shared risks.
- **Agent label.** How a client transmits it, and whether an orchestrator imposes it on sub-agents.
- **Scope of the management tools.** Missions only in v1; sharing stays a human gesture.
- **Per-tool discovery.** Should plugins declare per tool the risks it can touch, so a mission lists
  only what it can call (§4.1)?
- **Audit export.** Format and scope beyond local retention.
- **Who answers when the creator is away** (research Q4). v1: only the creator (§3.4), which keeps
  one responsible human per mission; a teammate lives an expired request as an outage. Assume it,
  or let the creator name a stand-in among the members? A rule to settle, not to patch.
- **The demo and the local instance** (research Q3). Are the simulated demo and a real instance on
  one computer one thing or two? If the local instance ships with a simulated service already
  connected, the demo becomes the first minute of the real product.
