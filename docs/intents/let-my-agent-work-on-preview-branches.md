---
title: Let my agent work on a project's preview branches
status: implemented
actors: [developer]
spec: ../spec/vaubaan-gateway.md
last_reviewed: 2026-11-26
---

# Let my agent work on a project's preview branches

As a developer whose service opens a preview copy of a project for each pull request, I want my
agent to reach those copies through its mission, so that it can check and repair a preview without
me doing it by hand.

## Reach a preview branch from a mission

### Find a Supabase preview branch among the account's resources

status: implemented
requires: account
creates: resource
anchors: plugins/supabase/src/execute.ts, plugins/supabase/tests/unit/plugin.test.ts
relieves: a-permission-that-silently-needs-a-label
spec: ../spec/vaubaan-gateway.md#0-vocabulary

### Run a call on a Supabase preview branch by its ref

status: implemented
requires: mission, resource
anchors: plugins/supabase/src/classify.ts, plugins/supabase/tests/unit/classify.test.ts
relieves: an-agent-that-keeps-hitting-walls
spec: ../spec/vaubaan-gateway-03-authority.md#31-the-chain

## Manage the branches of a mission's project

### List a project's preview branches

status: implemented
requires: mission, resource
anchors: plugins/supabase/src/execute.ts, apps/gateway/src/server/accounts/discovery-after-call.ts, plugins/supabase/tests/unit/execute.test.ts, apps/gateway/src/server/accounts/discovery-after-call.test.ts
relieves: an-agent-that-keeps-hitting-walls
spec: ../spec/vaubaan-gateway-04-surfaces.md#41-execution-surface

### Read a preview branch's database settings

status: implemented
requires: mission, resource
anchors: plugins/supabase/src/redact.ts, plugins/supabase/tests/unit/redact.test.ts
relieves: an-agent-that-keeps-hitting-walls
spec: ../spec/vaubaan-gateway-02-domain.md#24-the-cross-cutting-invariant--the-executor-never-sees-a-service-credential

### Delete or reset a preview branch

status: implemented
requires: mission, resource
creates: event
anchors: plugins/supabase/src/risk-catalog.yaml, plugins/supabase/src/execute.ts, plugins/supabase/tests/unit/execute.test.ts, plugins/supabase/tests/unit/risk-catalog.test.ts
relieves: an-agent-that-keeps-hitting-walls
spec: ../spec/vaubaan-gateway-03-authority.md#32-the-budget
