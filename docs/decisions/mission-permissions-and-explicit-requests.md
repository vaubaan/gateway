---
title: Creators edit mission permissions and answer explicit agent requests
status: accepted
date: 2026-10-17
extends:
  - mission-limits-editable-after-issuance
  - permission-request-asked-by-the-agent
---

# Creators edit mission permissions and answer explicit agent requests

## Context

A missing permission currently requires a new mission and new keys. The product
owner approved implementing direct creator edits and deliberate agent requests
together on 2026-10-17. The earlier permission-request ADR was a proposal.

## Decision

The signed-in creator may add or remove explicit permissions on the existing
accounts and resources. Additions carry a quota, rate and gate and pass the same
current-authority and catalog checks as issuance. Keys, session, counters and
history survive. Removed permissions retain their usage if added again.
Every holder receives the same change. Revoked or orphaned missions cannot be
edited. Concurrent edits must not silently overwrite another creator change.

A missing-permission refusal creates no inbox item. It provides a short-lived
reference bound to the authenticated mission and token. The agent deliberately
calls `vaubaan__request_permission` with that reference and a justification of
1–1000 characters. The creator sees the observed tool, missing permissions and
the justification labelled as the agent's words. They may add permissions with
explicit budgets and gates, or refuse. Granting uses the same validation and
write as a direct edit and does not execute the refused call.

References last 15 minutes. Open requests for the same mission, holder and set
of missing permissions are reused. At most ten new requests per mission are
created in a rolling 24 hours. Reusing a reference returns its existing request,
including a closed decision. Requests expire using the instance's existing
request lifetime. Creation, changes and decisions are recorded.

The execution and management credentials cannot edit or answer requests.
Permissions removed before a call's budget decision cannot be used by that
call. An upstream action already authorized is not cancelled retroactively.

## Consequences

The agent retries with its existing key after the creator's decision. Both
entry points share permission validation and preserve consumed budgets.
Request references and deduplication require persistent state. The interface
must make additions and removals, and their effect on all holders, explicit.

## Rejected alternatives

- Automatically request every refused permission: ordinary agent exploration
  would fill the inbox; a refusal stays a refusal until deliberately escalated.
- Reissue every mission: forces key replacement for a forgotten permission.
- Let an agent edit the mission: would let it authorize its own escalation.
- Include a one-call exception in this change: the accepted scope is editing
  the mission and requesting that edit. Single-use exceptions remain separate
  from adding a permission with an explicit budget.

## References

- [Specification](../spec/vaubaan-gateway.md)
- [Missions](../handbook/missions.md)
- [Requests](../handbook/requests.md)
