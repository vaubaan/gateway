---
title: Railway provider adapter (v4)
status: superseded
date: 2026-10-13
superseded-by: providers/railway
---

# Railway provider — v4 adapter (superseded)

This document described the v4 `RailwayAdapter`, its OAuth routes under
`apps/gateway/src/app/api/integrations/railway/` and the hot-path refresh
wired through `persistRefresh`. The plugin migrated to the v5 Plugin SDK in
feature P1.2d; the current handbook is
[`providers/railway.md`](./providers/railway.md) (data model, classifier on
`Resource[]`, catalog and presets, OAuth2 credential spec and refresh,
execution, tests).

What remains of v4 in the code is listed there under "Legacy and removal
plan": `RailwayAdapter`, `railwayAvailableTools`, `railwayRiskCatalog` and
`classifyRailwayV4` stay exported `@deprecated` for the v4 application and
are deleted in P1.6, together with the v4 OAuth routes replaced by the
generic connect driver of P1.4.

Decisions: [[railway-rewrap-remote-mcp]], [[plugin-contract-and-credential-spec]].
