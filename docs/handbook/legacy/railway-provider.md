---
title: Railway provider adapter (v4)
status: legacy
date: 2026-10-13
superseded_by: ../providers/railway.md
---

> **Legacy v4 document.** Kept for history; superseded by the v5 spec and the current handbooks. Not maintained.

# Railway provider — v4 adapter (superseded)

This document described the v4 `RailwayAdapter`, its OAuth routes under
`apps/gateway/src/app/api/integrations/railway/` and the hot-path refresh
wired through `persistRefresh`. The plugin migrated to the v5 Plugin SDK in
feature P1.2d; the current handbook is
[`providers/railway.md`](../providers/railway.md) (data model, classifier on
`Resource[]`, catalog and presets, OAuth2 credential spec and refresh,
execution, tests).

Nothing of v4 remains in the code: `RailwayAdapter`, `railwayAvailableTools`,
`railwayRiskCatalog`, `classifyRailwayV4` and the v4 OAuth routes are
deleted. The connect flow is the generic driver documented in
[`connections.md`](../connections.md), which reads `railwayCredentialSpec`.

Decisions: [[railway-rewrap-remote-mcp]], [[plugin-contract-and-credential-spec]].
