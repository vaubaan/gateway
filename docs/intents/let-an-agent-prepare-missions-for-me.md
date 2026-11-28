---
title: Let an agent prepare missions for me
status: proposed
actors: [developer]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-22
---

# Let an agent prepare missions for me

As a user, I want an agent holding a mission on my Vaubaan account to issue and manage missions
for other agents in my name, so that I delegate the set-up without ever giving it more than I hold,
nor anything that outlives my control of it.

## Issue missions through an agent

### Issue a mission in my name from an agent

status: implemented
delivers: my-agent-works-alone-on-real-things
requires: mission
creates: mission
anchors: apps/gateway/src/server/vaubaan/acts.ts, apps/gateway/src/server/vaubaan/acts.test.ts, apps/gateway/src/server/vaubaan/hard-deny.test.ts
spec: ../spec/vaubaan-gateway-04-surfaces.md#41-bis-management-surface-the-vaubaan-plugin

### Keep a prepared mission within the life of the mission that prepared it

status: implemented
requires: mission
anchors: apps/gateway/src/server/vaubaan/acts.ts, apps/gateway/src/server/vaubaan/acts.test.ts
spec: ../spec/vaubaan-gateway-04-surfaces.md#41-bis-management-surface-the-vaubaan-plugin

## Take back what an agent prepared

### Revoke the missions a revoked mission prepared

status: proposed
requires: mission
spec: ../spec/vaubaan-gateway-04-surfaces.md#41-bis-management-surface-the-vaubaan-plugin
acceptance:

- Revoking a mission that issued missions offers, on the same screen, to revoke them too, and says how many are still active
- Revoking from the agent's side (`vaubaan__revoke_mission`) never revokes the calling mission's own children without the person
- The audit records each revocation with the mission that triggered it

### Change only the missions this mission prepared

status: proposed
requires: mission
spec: ../spec/vaubaan-gateway-04-surfaces.md#41-bis-management-surface-the-vaubaan-plugin
acceptance:

- `vaubaan__edit_mission` and `vaubaan__revoke_mission` refuse a mission the calling mission did not issue, as rotation already does
- The refusal names the mission and says the person changes it in the web interface
