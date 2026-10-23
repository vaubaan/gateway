---
title: Product owner's decisions of 2026-10-13 — what stays as it is, and the small changes
status: accepted
date: 2026-10-13
---

# Product owner's decisions of 2026-10-13 — what stays as it is, and the small changes

> The final pass of v5 left eighteen questions to the product owner. He took
> each recommendation as a decision. The structural ones have an ADR of their
> own (listed at the end); this record holds the others, so that nobody reopens
> them for want of a trace. Spec: [vaubaan-gateway](../spec/vaubaan-gateway.md).

## Context

Several of the eighteen questions were "is this what we want?" about a
behaviour the code already had. The answer was yes, with a reason, and
sometimes with a small change. A behaviour kept on purpose looks exactly like
one nobody thought about unless the reason is written down.

## Decision

### D1. A read-only token may be handed automatically; a write token never is (question 1)

`github.mint-install-token-clone` stays on `auto` in GitHub's Developer
preset; `github.mint-install-token-push` stays on `approval`. The rule of spec
§2.4 becomes: in a preset, a token-handing risk that grants write is gated by
approval; a read-only one may be automatic. A clone token reads what the
mission already reads through the gateway. The rule is checked: a plugin
declares its read-only token-handing risks (`TokenHandout.readOnlyRiskIds`),
any other is taken as write, and `definePlugin` refuses a preset that leaves
it automatic.

### D2. A loopback-only client is admitted without the operator (question 5)

`oauth.client_registration.auto_approve_loopback` stays `true`. A client whose
every redirect URI is on the loopback interface delivers its authorization
code to a program on the machine of the user who is consenting, and nowhere
else; the user still reads the consent screen, and the delegation is theirs
alone. Requiring the operator for every developer's local agent would add a
queue and no control. An operator who wants the queue sets the key to `false`.
Threat model, accepted risk A24.

### D3. The surface rate limit stays per mission (question 8)

One window for all the tokens of a mission. The limit protects the instance
and the provider from one mission; who among its holders spends it is the
creator's matter, like the budget, which is shared the same way. A per-holder
limit would multiply the mission's ceiling by its number of tokens. Accepted
consequence: one holder can use up the window for the others (A26).

### D4. The add-member picker lists every active user (question 9)

A creator adds a member by picking among the active users of the instance, by
email. The instance is one company's: its users are colleagues who already see
each other in the identity provider. A free-text field would turn a typo into
an error message that confirms or denies an address, which is no better (A25).

### D5. One connection per provider in a mission, said plainly (question 10)

Kept for now: the policy and the budget of a mission are keyed by `RiskId`,
which names the provider and not the connection. The refusal now names the two
connections, says why, and says what to do instead.

### D6. A mission does not expire unless its creator says so (question 11)

The default expiry of the issuance form stays "never". A mission is bounded by
its budget per period, its gates and its revocation; a default expiry would
stop agents that work on schedule, at a date nobody chose. Accepted
consequence: a forgotten mission keeps its tokens valid (A27); the mission
page shows when each token was last used.

### D7. The share dialog names what it would restore (question 14)

Before a share is made, the dialog lists the orphaned missions it would bring
back and the owner confirms that list. Handbook
[authority](../handbook/authority.md).

### D8. `retention_days` covers the session history (question 16)

The timeline events and the counters of past periods leave with the audit
entries of the same age; what a current period rests on stays. Handbook
[audit](../handbook/audit.md).

### D9. Telemetry waits for the pilot (question 17)

Off by default, and nothing is sent even when enabled while the collector URL
is the placeholder. The collector is not deployed and is not worked on before
the pilot has run. [Known limitations](../handbook/known-limitations.md).

> Later (2026-10-23): the collector is published and the placeholder gate is
> lifted; telemetry stays off by default. See the amendment of
> [[telemetry-collector-shape]].

### D10. Release settings and governance: nothing now (question 18)

The placeholders stay.

## Consequences

- The four accepted risks A24–A27 are in the
  [threat model](../handbook/threat-model.md), each with what limits it.
- §11.2 of the spec no longer lists as open what these decisions settle.
- The structural decisions are elsewhere:
  [supabase-managed-schemas-read-risk](./supabase-managed-schemas-read-risk.md) (2),
  [mission-token-sha256-digest](./mission-token-sha256-digest.md) (3),
  [delegation-absolute-lifetime](./delegation-absolute-lifetime.md) (4),
  [provider-side-revocation-on-connection-revoke](./provider-side-revocation-on-connection-revoke.md) (6),
  [audit-visibility-members-and-operators](./audit-visibility-members-and-operators.md) (7, 15),
  [claim-reset-is-the-claimed-risk-only](./claim-reset-is-the-claimed-risk-only.md) (12),
  [one-approval-request-covers-the-call](./one-approval-request-covers-the-call.md) (13).

## Rejected alternatives

- **Gate the clone token too.** Every `git clone` of an agent would wait for a
  human, for a read the mission already has.
- **Operator approval for loopback clients.** See D2.
- **A rate limit per token.** See D3.
- **A free-text email to add a member.** See D4.
- **Several connections of one provider now.** It needs the connection in the
  key of the policy and of the counters, and a way for a call to say which
  connection it means: a model change, not a message.
- **A default expiry of 30 or 90 days.** See D6.
