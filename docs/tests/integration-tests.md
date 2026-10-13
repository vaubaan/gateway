---
title: Integration tests
status: current
date: 2026-10-13
last_synced: 2026-10-13
tracks:
  - vitest.config.ts
  - scripts/release-lib.test.mjs
  - scripts/audit-gate.test.mjs
  - packages/policy-engine/tests/
  - packages/plugin-sdk/tests/
  - plugins/_template/tests/
  - plugins/github/tests/
  - plugins/vercel/tests/
  - plugins/supabase/tests/
  - plugins/railway/tests/
  - plugins/ssh/tests/
  - plugins/resend/tests/
  - plugins/upstash-redis/tests/
  - plugins/cloudflare-dns/tests/
  - plugins/gmail/tests/
  - plugins/stripe/tests/
  - packages/gateway-core/tests/
  - apps/gateway/tests/
  - apps/gateway/src/server/
  - apps/gateway/src/app/
  - apps/gateway/migrations/
  - packages/telemetry/src/
  - deploy/collector/
  - packages/shared/src/
---

# Integration tests

Vitest, headless. No browser, no database server, no real provider.
Discovery is centralised in
`vitest.config.ts` (`test.include`):

```
apps/*/tests/unit/**/*.test.ts         apps/*/tests/unit/**/*.test.tsx
apps/*/tests/integration/**/*.test.ts
packages/*/tests/unit/**/*.test.ts     packages/*/tests/unit/**/*.test.tsx
packages/*/tests/integration/**/*.test.ts
plugins/*/tests/unit/**/*.test.ts
packages/*/src/**/*.test.ts            apps/*/src/**/*.test.ts
scripts/*.test.mjs
```

`apps/*/tests/e2e/**` is excluded (Playwright, see
[`e2e-tests.md`](./e2e-tests.md)), and so is `apps/gateway/tests/manual/`
(no `*.test.ts` there). Every test runs in the `node` environment. No test
reaches a provider: the v4 suites that could (and the `SKIP_LIVE` switch
that guarded them) were deleted with the v4 application. One suite opens a
socket, on loopback only: `plugins/ssh/tests/unit/host-key-pinning.test.ts`
drives the real SSH transport against an ssh server started in the test
process.

## Map — spec §10 to this file

The scenarios below are grouped by v5 subsystem, one section per package or
server module, each appended to by the feature that built it. Spec
[vaubaan-gateway](../spec/vaubaan-gateway.md) §10 lists what must be tested;
this table says where each requirement lives, and what is not written yet.

| Spec §10                                                                 | Section                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit — each plugin's classifier                                          | [Provider plugins](#scenarios--provider-plugins)                                                                                                                                                                                    |
| Unit — authority composition, resource selection, environment resolution | [Policy engine](#scenarios--policy-engine), [Missions](#scenarios--missions), [Execution door](#scenarios--execution-door)                                                                                                          |
| Unit — the budget                                                        | [Budget and sessions](#scenarios--budget-and-sessions)                                                                                                                                                                              |
| Unit — the approval                                                      | [Budget and sessions](#scenarios--budget-and-sessions) (fingerprint, lookup, consumption), [Approval gate](#scenarios--approval-gate) (decision, gate opening, erasure)                                                             |
| Unit — structured refusals                                               | [gateway-core](#scenarios--gateway-core), [Execution door](#scenarios--execution-door)                                                                                                                                              |
| Unit — credential separation                                             | [gateway-core](#scenarios--gateway-core), [Execution door](#scenarios--execution-door), [Authorization server](#scenarios--authorization-server-of-the-management-door)                                                             |
| Integration — connection                                                 | [Connections](#scenarios--connections-resources-provider-apps)                                                                                                                                                                      |
| Integration — share                                                      | [Authority, shares, groups](#scenarios--authority-shares-groups)                                                                                                                                                                    |
| Integration — issuance                                                   | [Missions](#scenarios--missions)                                                                                                                                                                                                    |
| Integration — claim and replay                                           | [Requests](#scenarios--requests), [Execution door](#scenarios--execution-door)                                                                                                                                                      |
| Integration — approval and replay                                        | [Approval gate](#scenarios--approval-gate)                                                                                                                                                                                          |
| Integration — revocation flows, `orphaned` states                        | [Authority, shares, groups](#scenarios--authority-shares-groups), [Missions](#scenarios--missions), [Connections](#scenarios--connections-resources-provider-apps)                                                                  |
| Integration — OAuth delegation, issuance by an MCP client                | [Authorization server](#scenarios--authorization-server-of-the-management-door) (delegation by the official MCP client); [Management door tools](#scenarios--management-door-tools) (issuance within the authority, refusal beyond) |
| Integration — simulated IdP                                              | [Human authentication](#scenarios--human-authentication)                                                                                                                                                                            |
| Structural — telemetry report without forbidden fields                   | [Community telemetry](#scenarios--community-telemetry)                                                                                                                                                                              |
| Structural — session counters agree with the audit                       | [Execution door](#scenarios--execution-door), [Budget and sessions](#scenarios--budget-and-sessions)                                                                                                                                |
| Structural — no configuration value hard-coded                           | [Instance configuration](#scenarios--instance-configuration-crypto-composition-root)                                                                                                                                                |
| Structural — enumerated lists, never a wildcard or a preset reference    | [Plugin SDK](#scenarios--plugin-sdk), [Store](#scenarios--store), [Missions](#scenarios--missions), [The structural suite](#scenarios--the-structural-suite-and-the-dependency-audit)                                               |
| Structural — every plugin ships a preset of its own catalog              | [Plugin SDK](#scenarios--plugin-sdk), [Provider plugins](#scenarios--provider-plugins), [The structural suite](#scenarios--the-structural-suite-and-the-dependency-audit)                                                           |
| Structural — authority recomputed from current membership                | [Authority, shares, groups](#scenarios--authority-shares-groups), [Human authentication](#scenarios--human-authentication)                                                                                                          |
| End to end — the cutover acceptance scenario                             | [`e2e-tests.md`](./e2e-tests.md): manual, with an automated browser smoke before it                                                                                                                                                 |

## Coverage

| Suite                                                                                                     |    Tests |
| --------------------------------------------------------------------------------------------------------- | -------: |
| `apps/gateway/src/app/(app)/missions/[id]/session/event-words.test.ts`                                    |        8 |
| `apps/gateway/src/app/(app)/missions/message-of.test.ts`                                                  |        2 |
| `apps/gateway/src/app/(app)/missions/mission-view.test.ts`                                                |       15 |
| `apps/gateway/src/app/(app)/missions/new/form-state.test.ts`                                              |       40 |
| `apps/gateway/src/components/auth/principal.test.ts`                                                      |        2 |
| `apps/gateway/src/components/connections/shape.test.ts`                                                   |        5 |
| `apps/gateway/src/server/audit/filters.test.ts`                                                           |       24 |
| `apps/gateway/src/server/audit/session-event-detail.test.ts`                                              |       10 |
| `apps/gateway/src/server/auth/admin-rule.test.ts`                                                         |        5 |
| `apps/gateway/src/server/auth/bootstrap.test.ts`                                                          |        3 |
| `apps/gateway/src/server/auth/claims.test.ts`                                                             |       22 |
| `apps/gateway/src/server/auth/guard.test.ts`                                                              |       10 |
| `apps/gateway/src/server/auth/handlers.test.ts`                                                           |        9 |
| `apps/gateway/src/server/auth/idp-settings.test.ts`                                                       |        8 |
| `apps/gateway/src/server/auth/origin.test.ts`                                                             |        5 |
| `apps/gateway/src/server/auth/session-service.test.ts`                                                    |       11 |
| `apps/gateway/src/server/authority/authority-service.test.ts`                                             |       20 |
| `apps/gateway/src/server/authority/mission-grounds.test.ts`                                               |       27 |
| `apps/gateway/src/server/compose/compose.test.ts`                                                         |       17 |
| `apps/gateway/src/server/config/duration.test.ts`                                                         |        2 |
| `apps/gateway/src/server/config/keys-doc.test.ts`                                                         |       35 |
| `apps/gateway/src/server/config/load.test.ts`                                                             |       54 |
| `apps/gateway/src/server/connections/codec-and-keypair.test.ts`                                           |       12 |
| `apps/gateway/src/server/connections/credentials.test.ts`                                                 |       15 |
| `apps/gateway/src/server/connections/input.test.ts`                                                       |       23 |
| `apps/gateway/src/server/connections/install-verification.test.ts`                                        |        5 |
| `apps/gateway/src/server/connections/mapping.test.ts`                                                     |        3 |
| `apps/gateway/src/server/connections/oauth2.test.ts`                                                      |       28 |
| `apps/gateway/src/server/connections/pending.test.ts`                                                     |        7 |
| `apps/gateway/src/server/connections/provider-revocation.test.ts`                                         |       16 |
| `apps/gateway/src/server/connections/service.test.ts`                                                     |       33 |
| `apps/gateway/src/server/connections/shipped-providers.test.ts`                                           |        7 |
| `apps/gateway/src/server/crypto/aead.test.ts`                                                             |       12 |
| `apps/gateway/src/server/execution/execution.test.ts`                                                     |       21 |
| `apps/gateway/src/server/groups/service.test.ts`                                                          |       15 |
| `apps/gateway/src/server/http/client-ip.test.ts`                                                          |       11 |
| `apps/gateway/src/server/http/document.test.ts`                                                           |        6 |
| `apps/gateway/src/server/http/healthz.test.ts`                                                            |        4 |
| `apps/gateway/src/server/now/derive.test.ts`                                                              |        5 |
| `apps/gateway/src/server/logging/logging.test.ts`                                                         |        6 |
| `apps/gateway/src/server/management/door.test.ts`                                                         |        4 |
| `apps/gateway/src/server/management/hard-deny.test.ts`                                                    |       16 |
| `apps/gateway/src/server/management/output-schemas.test.ts`                                               |       10 |
| `apps/gateway/src/server/management/tools.test.ts`                                                        |       32 |
| `apps/gateway/src/server/missions/bootstrap-kit.test.ts`                                                  |       16 |
| `apps/gateway/src/server/missions/catalog-view.test.ts`                                                   |       21 |
| `apps/gateway/src/server/missions/orphan-reason.test.ts`                                                  |        4 |
| `apps/gateway/src/server/missions/preview.test.ts`                                                        |       44 |
| `apps/gateway/src/server/missions/summary.test.ts`                                                        |        8 |
| `apps/gateway/src/server/missions/token-name.test.ts`                                                     |       23 |
| `apps/gateway/src/server/missions/token.test.ts`                                                          |       10 |
| `apps/gateway/src/server/oauth-as/authorization.test.ts`                                                  |       41 |
| `apps/gateway/src/server/oauth-as/client-metadata-document.test.ts`                                       |       91 |
| `apps/gateway/src/server/oauth-as/clients.test.ts`                                                        |       40 |
| `apps/gateway/src/server/oauth-as/delegation-lifetime.test.ts`                                            |        5 |
| `apps/gateway/src/server/oauth-as/delegations.test.ts`                                                    |       28 |
| `apps/gateway/src/server/oauth-as/endpoints.test.ts`                                                      |       15 |
| `apps/gateway/src/server/oauth-as/pages.test.ts`                                                          |       13 |
| `apps/gateway/src/server/oauth-as/pkce.test.ts`                                                           |       13 |
| `apps/gateway/src/server/oauth-as/redirect-uri.test.ts`                                                   |       52 |
| `apps/gateway/src/server/oauth-as/secrets.test.ts`                                                        |        6 |
| `apps/gateway/src/server/oauth-as/token-service.test.ts`                                                  |       66 |
| `apps/gateway/src/server/provider-apps/service.test.ts`                                                   |       15 |
| `apps/gateway/src/server/providers/planes.test.ts`                                                        |        9 |
| `apps/gateway/src/server/providers/reference.test.ts`                                                     |       20 |
| `apps/gateway/src/server/requests/approval.test.ts`                                                       |       33 |
| `apps/gateway/src/server/requests/asker.test.ts`                                                          |        4 |
| `apps/gateway/src/server/requests/claim.test.ts`                                                          |       38 |
| `apps/gateway/src/server/requests/client-ip.test.ts`                                                      |        2 |
| `apps/gateway/src/server/requests/events.test.ts`                                                         |        7 |
| `apps/gateway/src/server/requests/state.test.ts`                                                          |        9 |
| `apps/gateway/src/server/requests/sweeper.test.ts`                                                        |        4 |
| `apps/gateway/src/server/shares/errors.test.ts`                                                           |        4 |
| `apps/gateway/src/server/shares/restriction.test.ts`                                                      |        8 |
| `apps/gateway/src/server/shares/service.test.ts`                                                          |       24 |
| `apps/gateway/src/server/store/membership.test.ts`                                                        |       12 |
| `apps/gateway/src/server/telemetry/outcome.test.ts`                                                       |       30 |
| `apps/gateway/src/server/telemetry/settings.test.ts`                                                      |        7 |
| `apps/gateway/src/server/telemetry/stats.test.ts`                                                         |       11 |
| `apps/gateway/tests/integration/audit/admin-mutations.test.ts`                                            |       52 |
| `apps/gateway/tests/integration/audit/audit-query.test.ts`                                                |       35 |
| `apps/gateway/tests/integration/audit/events-agent-label.test.ts`                                         |        3 |
| `apps/gateway/tests/integration/audit/mission-session.test.ts`                                            |       21 |
| `apps/gateway/tests/integration/audit/retention.test.ts`                                                  |       10 |
| `apps/gateway/tests/integration/audit/session-history-retention.test.ts`                                  |       11 |
| `apps/gateway/tests/integration/auth/deactivate-user.test.ts`                                             |       12 |
| `apps/gateway/tests/integration/auth/oidc-login.test.ts`                                                  |       22 |
| `apps/gateway/tests/integration/authority/close-orphaned.test.ts`                                         |       11 |
| `apps/gateway/tests/integration/authority/door-latency.bench.test.ts`                                     |        1 |
| `apps/gateway/tests/integration/authority/handlers.test.ts`                                               |       11 |
| `apps/gateway/tests/integration/authority/missions-on-connection.test.ts`                                 |        8 |
| `apps/gateway/tests/integration/authority/ownership.test.ts`                                              |       13 |
| `apps/gateway/tests/integration/authority/rules-read-by-pages.test.ts`                                    |        7 |
| `apps/gateway/tests/integration/authority/share-and-orphan.test.ts`                                       |       19 |
| `apps/gateway/tests/integration/authority/share-restores.test.ts`                                         |       11 |
| `apps/gateway/tests/integration/budget/pipeline-consistency.test.ts`                                      |        6 |
| `apps/gateway/tests/integration/budget/session-service.test.ts`                                           |       20 |
| `apps/gateway/tests/integration/compose/boot.test.ts`                                                     |        4 |
| `apps/gateway/tests/integration/connections/connect-flow.test.ts`                                         |        6 |
| `apps/gateway/tests/integration/connections/reassign-and-settle.test.ts`                                  |        5 |
| `apps/gateway/tests/integration/connections/repository-status.test.ts`                                    |        6 |
| `apps/gateway/tests/integration/demo/build-stamp.test.ts`                                                 |       10 |
| `apps/gateway/tests/integration/demo/demo-safety.test.ts`                                                 |       13 |
| `apps/gateway/tests/integration/demo/demo-smoke.test.ts`                                                  |       17 |
| `apps/gateway/tests/integration/demo/demo-vercel.test.ts`                                                 |        3 |
| `apps/gateway/tests/integration/execution/agent-label.test.ts`                                            |        6 |
| `apps/gateway/tests/integration/execution/approval-door.test.ts`                                          |        8 |
| `apps/gateway/tests/integration/execution/counters-vs-audit.test.ts`                                      |        4 |
| `apps/gateway/tests/integration/execution/door-http.test.ts`                                              |       23 |
| `apps/gateway/tests/integration/execution/pipeline.test.ts`                                               |       24 |
| `apps/gateway/tests/integration/execution/streaming.test.ts`                                              |       13 |
| `apps/gateway/tests/integration/execution/team-door.test.ts`                                              |       11 |
| `apps/gateway/tests/integration/management/hard-deny.test.ts`                                             |        6 |
| `apps/gateway/tests/integration/management/management-door.test.ts`                                       |       34 |
| `apps/gateway/tests/integration/management/output-schemas.test.ts`                                        |        9 |
| `apps/gateway/tests/integration/missions/gate.test.ts`                                                    |       20 |
| `apps/gateway/tests/integration/missions/mission-handlers.test.ts`                                        |        8 |
| `apps/gateway/tests/integration/missions/mission-lifecycle.test.ts`                                       |       33 |
| `apps/gateway/tests/integration/missions/team-interleaving.test.ts`                                       |        6 |
| `apps/gateway/tests/integration/missions/team.test.ts`                                                    |       28 |
| `apps/gateway/tests/integration/now/now.test.ts`                                                          |       11 |
| `apps/gateway/tests/integration/oauth-as/credential-separation.test.ts`                                   |       19 |
| `apps/gateway/tests/integration/oauth-as/http-surface.test.ts`                                            |       66 |
| `apps/gateway/tests/integration/oauth-as/mcp-client-flow.test.ts`                                         |        4 |
| `apps/gateway/tests/integration/oauth-as/routes.test.ts`                                                  |       16 |
| `apps/gateway/tests/integration/requests/approval-access.test.ts`                                         |       29 |
| `apps/gateway/tests/integration/requests/approval.test.ts`                                                |       51 |
| `apps/gateway/tests/integration/requests/request-handlers.test.ts`                                        |       14 |
| `apps/gateway/tests/integration/requests/request-service.test.ts`                                         |       36 |
| `apps/gateway/tests/integration/standalone-native-addons.test.ts`                                         |        3 |
| `apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts`                                       |        3 |
| `apps/gateway/tests/integration/store/approval-decisions.test.ts`                                         |       20 |
| `apps/gateway/tests/integration/store/audit-guarded-append.test.ts`                                       |       10 |
| `apps/gateway/tests/integration/store/audit.test.ts`                                                      |       15 |
| `apps/gateway/tests/integration/store/config.test.ts`                                                     |        7 |
| `apps/gateway/tests/integration/store/connections-shares.test.ts`                                         |       13 |
| `apps/gateway/tests/integration/store/corrupt-rows.test.ts`                                               |       14 |
| `apps/gateway/tests/integration/store/delegations.test.ts`                                                |       20 |
| `apps/gateway/tests/integration/store/identities.test.ts`                                                 |       11 |
| `apps/gateway/tests/integration/store/missions.test.ts`                                                   |       18 |
| `apps/gateway/tests/integration/store/oauth-clients.test.ts`                                              |       16 |
| `apps/gateway/tests/integration/store/ownership-and-orphans.test.ts`                                      |       13 |
| `apps/gateway/tests/integration/store/request-covers-the-call-migration.test.ts`                          |        1 |
| `apps/gateway/tests/integration/store/requests-approvals.test.ts`                                         |       14 |
| `apps/gateway/tests/integration/store/schema.test.ts`                                                     |        6 |
| `apps/gateway/tests/integration/store/sessions.test.ts`                                                   |       11 |
| `apps/gateway/tests/integration/store/token-holders.test.ts`                                              |        4 |
| `apps/gateway/tests/integration/store/users-issuer.test.ts`                                               |       14 |
| `apps/gateway/tests/integration/store/web-sessions.test.ts`                                               |        8 |
| `apps/gateway/tests/integration/telemetry/telemetry.test.ts`                                              |       18 |
| `apps/gateway/tests/unit/app/admin-guard.test.ts`                                                         |       63 |
| `apps/gateway/tests/unit/app/app-guard.test.ts`                                                           |      136 |
| `apps/gateway/tests/unit/app/build-footer.test.tsx`                                                       |        3 |
| `apps/gateway/tests/unit/app/design-system.test.tsx`                                                      |       33 |
| `apps/gateway/tests/unit/app/design-tokens.test.ts`                                                       |       62 |
| `apps/gateway/tests/unit/app/field.test.tsx`                                                              |        6 |
| `apps/gateway/tests/unit/app/now-and-waiting.test.tsx`                                                    |       28 |
| `apps/gateway/tests/unit/app/risk-explain.test.tsx`                                                       |        9 |
| `apps/gateway/tests/unit/app/shell-and-vocabulary.test.ts`                                                |       23 |
| `apps/gateway/tests/unit/server/auth/mutation-guard.test.ts`                                              |      287 |
| `apps/gateway/tests/unit/server/budget/decide.test.ts`                                                    |       20 |
| `apps/gateway/tests/unit/server/budget/gates.test.ts`                                                     |        9 |
| `apps/gateway/tests/unit/server/budget/mission-state.test.ts`                                             |        7 |
| `apps/gateway/tests/unit/server/budget/period.test.ts`                                                    |        8 |
| `apps/gateway/tests/unit/server/connections/provider-app-handler.test.ts`                                 |        4 |
| `apps/gateway/tests/unit/server/rate-limit/sliding-window.test.ts`                                        |        8 |
| `apps/gateway/tests/unit/server/store/db.test.ts`                                                         |        2 |
| `apps/gateway/tests/unit/server/store/ids.test.ts`                                                        |        6 |
| `apps/gateway/tests/unit/server/store/migrate.test.ts`                                                    |        9 |
| `apps/gateway/tests/unit/structural/authority-not-snapshotted.test.ts`                                    |       27 |
| `apps/gateway/tests/unit/structural/base-images-pinned.test.ts`                                           |        5 |
| `apps/gateway/tests/unit/structural/catalog-caps-enforced.test.ts`                                        |       12 |
| `apps/gateway/tests/unit/structural/example-config-providers.test.ts`                                     |       10 |
| `apps/gateway/tests/unit/structural/index.test.ts`                                                        |      100 |
| `apps/gateway/tests/unit/structural/no-arguments-in-logs.test.ts`                                         |        3 |
| `apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`                                          |      377 |
| `apps/gateway/tests/unit/structural/persisted-enumerations.test.ts`                                       |       10 |
| `apps/gateway/tests/unit/structural/plugin-identifier-tests.test.ts`                                      |       25 |
| `apps/gateway/tests/unit/structural/shipped-presets.test.ts`                                              |       41 |
| `apps/gateway/tests/unit/structural/telemetry-collector-schema.test.ts`                                   |        7 |
| `apps/gateway/tests/unit/structural/telemetry-report-shape.test.ts`                                       |        3 |
| `apps/gateway/tests/unit/structural/version-single-source.test.ts`                                        |        4 |
| `packages/gateway-core/tests/unit/audit.test.ts`                                                          |        2 |
| `packages/gateway-core/tests/unit/authenticate.test.ts`                                                   |       11 |
| `packages/gateway-core/tests/unit/cache.test.ts`                                                          |        7 |
| `packages/gateway-core/tests/unit/errors.test.ts`                                                         |       31 |
| `packages/gateway-core/tests/unit/fingerprint.test.ts`                                                    |       12 |
| `packages/gateway-core/tests/unit/pipeline.test.ts`                                                       |       38 |
| `packages/gateway-core/tests/unit/risk-gateway.test.ts`                                                   |        9 |
| `packages/gateway-core/tests/unit/token-holder.test.ts`                                                   |        3 |
| `packages/plugin-sdk/tests/unit/arguments.test.ts`                                                        |       10 |
| `packages/plugin-sdk/tests/unit/catalog-loader.test.ts`                                                   |       31 |
| `packages/plugin-sdk/tests/unit/catalog-path.test.ts`                                                     |        4 |
| `packages/plugin-sdk/tests/unit/define-plugin.test.ts`                                                    |       32 |
| `packages/plugin-sdk/tests/unit/env-of.test.ts`                                                           |        8 |
| `packages/plugin-sdk/tests/unit/identifiers-kit.test.ts`                                                  |        9 |
| `packages/plugin-sdk/tests/unit/registry.test.ts`                                                         |       11 |
| `packages/plugin-sdk/tests/unit/slices.test.ts`                                                           |       21 |
| `packages/plugin-sdk/tests/unit/streaming.test.ts`                                                        |        9 |
| `packages/plugin-sdk/tests/unit/testing-kit.test.ts`                                                      |       14 |
| `packages/policy-engine/tests/unit/budget.test.ts`                                                        |       25 |
| `packages/policy-engine/tests/unit/qualify.test.ts`                                                       |       33 |
| `packages/policy-engine/tests/unit/risk-evaluator.test.ts`                                                |       20 |
| `packages/policy-engine/tests/unit/risk-policy.test.ts`                                                   |        9 |
| `packages/policy-engine/tests/unit/risk-runtime.test.ts`                                                  |       33 |
| `packages/policy-engine/tests/unit/slice-dsl.test.ts`                                                     |       23 |
| `packages/policy-engine/tests/unit/slice-matcher.test.ts`                                                 |       29 |
| `packages/shared/src/api-key.test.ts`                                                                     |       12 |
| `packages/shared/src/data-model.test.ts`                                                                  |        4 |
| `packages/shared/src/mcp.test.ts`                                                                         |       10 |
| `packages/shared/src/risk-id.test.ts`                                                                     |       20 |
| `packages/shared/src/session-events.test.ts`                                                              |       30 |
| `packages/telemetry/src/client.test.ts`                                                                   |       24 |
| `packages/telemetry/src/queue.test.ts`                                                                    |       12 |
| `packages/telemetry/src/report.test.ts`                                                                   |       24 |
| `plugins/_template/tests/unit/plugin.test.ts`                                                             |       26 |
| `plugins/cloudflare-dns/tests/unit/classify.test.ts`                                                      |       33 |
| `plugins/cloudflare-dns/tests/unit/data-model.test.ts`                                                    |        9 |
| `plugins/cloudflare-dns/tests/unit/identifiers.test.ts`                                                   |       59 |
| `plugins/cloudflare-dns/tests/unit/plugin.test.ts`                                                        |       51 |
| `plugins/cloudflare-dns/tests/unit/risk-catalog.test.ts`                                                  |       38 |
| `plugins/github/tests/unit/classify.test.ts`                                                              |       69 |
| `plugins/github/tests/unit/data-model.test.ts`                                                            |        1 |
| `plugins/github/tests/unit/execute.test.ts`                                                               |       25 |
| `plugins/github/tests/unit/injection.test.ts`                                                             |      415 |
| `plugins/github/tests/unit/plugin.test.ts`                                                                |       16 |
| `plugins/github/tests/unit/risk-catalog.test.ts`                                                          |       56 |
| `plugins/github/tests/unit/token-cache.test.ts`                                                           |        5 |
| `plugins/gmail/tests/unit/classify.test.ts`                                                               |      108 |
| `plugins/gmail/tests/unit/data-model.test.ts`                                                             |        5 |
| `plugins/gmail/tests/unit/injection.test.ts`                                                              |      190 |
| `plugins/gmail/tests/unit/plugin.test.ts`                                                                 |       27 |
| `plugins/gmail/tests/unit/q-parser.test.ts`                                                               |       32 |
| `plugins/gmail/tests/unit/risk-catalog.test.ts`                                                           |       45 |
| `plugins/railway/tests/unit/classify.test.ts`                                                             |       22 |
| `plugins/railway/tests/unit/data-model.test.ts`                                                           |        1 |
| `plugins/railway/tests/unit/identifier-injection.test.ts`                                                 |      294 |
| `plugins/railway/tests/unit/plugin.test.ts`                                                               |       31 |
| `plugins/railway/tests/unit/policy.test.ts`                                                               |       39 |
| `plugins/railway/tests/unit/risk-catalog.test.ts`                                                         |       19 |
| `plugins/resend/tests/unit/addresses.test.ts`                                                             |       13 |
| `plugins/resend/tests/unit/classify.test.ts`                                                              |       64 |
| `plugins/resend/tests/unit/data-model.test.ts`                                                            |        6 |
| `plugins/resend/tests/unit/identifiers.test.ts`                                                           |       58 |
| `plugins/resend/tests/unit/mission-evaluation.test.ts`                                                    |       15 |
| `plugins/resend/tests/unit/plugin.test.ts`                                                                |       44 |
| `plugins/resend/tests/unit/risk-catalog.test.ts`                                                          |       33 |
| `plugins/ssh/tests/unit/adversarial.test.ts`                                                              |      181 |
| `plugins/ssh/tests/unit/classify.test.ts`                                                                 |       90 |
| `plugins/ssh/tests/unit/data-model.test.ts`                                                               |        2 |
| `plugins/ssh/tests/unit/host-key-pinning.test.ts`                                                         |       37 |
| `plugins/ssh/tests/unit/injection.test.ts`                                                                |       87 |
| `plugins/ssh/tests/unit/plugin.test.ts`                                                                   |      300 |
| `plugins/stripe/tests/unit/classify.test.ts`                                                              |       48 |
| `plugins/stripe/tests/unit/data-model.test.ts`                                                            |        8 |
| `plugins/stripe/tests/unit/execute.test.ts`                                                               |       23 |
| `plugins/stripe/tests/unit/identifiers.test.ts`                                                           |       59 |
| `plugins/stripe/tests/unit/plugin.test.ts`                                                                |       32 |
| `plugins/stripe/tests/unit/policy.test.ts`                                                                |       30 |
| `plugins/stripe/tests/unit/risk-catalog.test.ts`                                                          |       20 |
| `plugins/supabase/tests/unit/classify.test.ts`                                                            |      134 |
| `plugins/supabase/tests/unit/data-model.test.ts`                                                          |        1 |
| `plugins/supabase/tests/unit/execute.test.ts`                                                             |       42 |
| `plugins/supabase/tests/unit/identifier-injection.test.ts`                                                |     1337 |
| `plugins/supabase/tests/unit/mission-evaluation.test.ts`                                                  |       39 |
| `plugins/supabase/tests/unit/plugin.test.ts`                                                              |       23 |
| `plugins/supabase/tests/unit/query-sql.test.ts`                                                           |      118 |
| `plugins/supabase/tests/unit/risk-catalog.test.ts`                                                        |       46 |
| `plugins/upstash-redis/tests/unit/classify.test.ts`                                                       |       31 |
| `plugins/upstash-redis/tests/unit/command-table.test.ts`                                                  |      105 |
| `plugins/upstash-redis/tests/unit/data-model.test.ts`                                                     |        1 |
| `plugins/upstash-redis/tests/unit/execute.test.ts`                                                        |       33 |
| `plugins/upstash-redis/tests/unit/identifiers.test.ts`                                                    |       42 |
| `plugins/upstash-redis/tests/unit/plugin.test.ts`                                                         |       27 |
| `plugins/upstash-redis/tests/unit/policy.test.ts`                                                         |       25 |
| `plugins/upstash-redis/tests/unit/risk-catalog.test.ts`                                                   |       49 |
| `plugins/vercel/tests/unit/binding.test.ts`                                                               |       50 |
| `plugins/vercel/tests/unit/classify.test.ts`                                                              |       43 |
| `plugins/vercel/tests/unit/data-model.test.ts`                                                            |        1 |
| `plugins/vercel/tests/unit/firewall.test.ts`                                                              |       11 |
| `plugins/vercel/tests/unit/identifier-injection.test.ts`                                                  |      315 |
| `plugins/vercel/tests/unit/plugin.test.ts`                                                                |       49 |
| `plugins/vercel/tests/unit/risk-catalog.test.ts`                                                          |       55 |
| `plugins/vercel/tests/unit/team-pin.test.ts`                                                              |       99 |
| `scripts/audit-gate.test.mjs`                                                                             |       29 |
| `scripts/release-lib.test.mjs`                                                                            |       50 |
| **TOTAL** (`npx vitest run --reporter=json`, 2026-10-14, with a build; 277 files; 9746 passed, 1 skipped) | **9747** |

The table is generated from the JSON report of one run of the whole suite
(`npx vitest run --reporter=json`). A count is the number of tests the file
declares, `it.each` expanded, **skipped tests included**: the TOTAL is the
report's number of tests, of which 9746 passed and 1 was skipped in that
run, made with a build (as `npm run ci` does). The one skipped whatever the
build is the latency measurement of the authority re-check
(`door-latency.bench.test.ts`, run with `VAUBAAN_BENCH=1`). Without a build 27
more are skipped, which need `.next/standalone`: the six standalone tests
(`standalone-native-addons` 3, `standalone-plugin-catalogs` 3), `demo-smoke`
(17) and four tests of
`demo-safety`; `npm run ci` builds first, so they run there. Each plugin has one
classifier suite, `classify.test.ts`, on its v5 entry point
`classify(tool, args, resources)`, and its adapter scenarios in
`execute.test.ts` / `plugin.test.ts` on `plugin.execute` with `mockFetch`.
The plugins with env-scoped risks or a binding to enforce also carry a suite
that evaluates calls through the real catalog and the policy engine
(`policy.test.ts`, `mission-evaluation.test.ts`, and the per-concern suites
listed under "Scenarios — Provider plugins"), and every plugin has a suite
that feeds hostile identifiers to its classifier and to its executor.

## Run

```bash
npm run test                              # full suite, headless
npm run test:watch                        # file-watcher mode for local dev
npx vitest run packages/policy-engine     # one package
```

## Scenarios — Policy engine

> Covers: `docs/spec/gateway-risk-model.md` §3 (DSL), §4 (catalog), §8
> (runtime). Handbook [[policy-engine]]. The package is a dependency of
> gateway-core and the plugin SDK.

`packages/policy-engine/tests/unit/`.

- **`slice-dsl.test.ts`** (23) — `parseSlice` happy path and every error branch
  (missing provider/action, invalid action, unterminated bracket, empty
  bracket, double dot, list with empty entry); `serializeSlice` round trip
  (simple, glob, list, wild-rec, the canonical examples of the spec).
- **`slice-matcher.test.ts`** (29) — `matches` simple/wild/list/glob, `covers`
  (`**` vs `*` partial order), symmetric `intersects` with glob × glob,
  asymmetric cases on `wild-rec`; glob charset regression (`release-*`
  matches `release-1.2`: the parser and the glob share one identifier
  charset).
- **`risk-evaluator.test.ts`** (20) — `risksTouchedBy` (code read, feature
  branch, merge-protected + fallback, branch protection, provider mismatch
  → empty), `risksTouchedByAll` (deduplicated union, stable order),
  `indexCatalog` (rejects a pattern of the wrong provider and an
  unparseable one), `findRiskEntry`.
- **`risk-policy.test.ts`** (9) — `checkAcceptableInEnv` (no env, env not in
  the list, ok) + `prepareCatalog` (duplicate id, regex failure, fallback
  warning through the injectable `warn`, `hasFallbackRisk`).
- **`risk-runtime.test.ts`** (33) — `evaluateCall` allow (feature branch
  alone, an uncategorized write needing the fallback and only it, read
  code), deny (missing risk, explicit deny, empty slices, no catalog match),
  multi-slice (all risks covered, one missing fails), env qualification
  through `resourceEnvResolver` (staging vs prod resource), the unqualified
  mode named by `envResolver: 'unqualified'` and never inferred from which
  resolver object is passed, every denial carries
  `code: 'risk-not-accepted'`, `evaluateCallSimple` happy path.
  **Regression block — an env-scoped risk touched outside its acceptable
  environments refuses the call**: on a labelled resource the specific risk
  is required on top of the broad one; on a resource with no label, or a
  label outside `acceptable_in_envs`, a broad co-touched risk no longer
  carries the call alone; a multi-slice call is refused whole; holding the
  unqualified id does not open an unlabelled resource; the same slices pass
  where every touched risk is acceptable and accepted. **An executed slice
  carries no glob in an identifier** (ADR
  [[decision-stages-fail-closed-and-audited]] D4): `feature/*`, `ma*n`, a
  list entry holding a `*` or a `*` as a list entry are refused
  `risk-not-accepted` with no missing risk and a hint naming the `*`,
  whatever the mission accepts; the whole-segment `[*]` and `[**]` a
  classifier emits for "any", and the `*` placeholder identifier, still
  pass. **A slice no catalog entry matches denies the call** although
  another slice is covered and accepted, and a slice of another provider is
  not dropped: it denies.
- **`qualify.test.ts`** (33) — `isEnvScopedEntry` (true when
  `acceptable_in_envs` is non-empty), `qualifyRiskId` (injects `[env]`
  before the first `.`, idempotent, no-op when account-scoped, env-scoped
  cases via `test.each`), `unqualifyRiskId` (strip + idempotent), round-trip
  property, `resourceEnvResolver` / `noEnvResolver` (ref match, provider
  mismatch, no env label; **the resources one slice cites must agree**: two
  identifiers or list values naming resources of different environments, or
  a labelled and an unlabelled one, resolve to no environment, several of
  one environment keep it), `envResolverFor` (the plugin hook first, the
  resource label next; **`NO_SINGLE_ENV` from the hook resolves to none and
  the label does not stand in**, while `undefined`, `null` or an empty
  string defer to the label), `resolveVector` (the override of the env replaces
  its axes, the others inherit, the base vector is not mutated).
- **`budget.test.ts`** (25) — the one budget rule every catalog reader
  shares: `isPositiveInteger`; `budgetIssues` accepts a legal budget with
  either gate, refuses a quota that is infinite, zero, negative, fractional,
  `NaN` or not a number, a rate limit that is not `{ max, window_seconds }`
  of positive integers, and any gate outside the closed set, listing every
  illegal field in field order; `ratePerMinute` / `exceedsRateCeiling`
  (normalised to one minute, strictly above the ceiling only).

## Scenarios — Plugin SDK

> Covers: `docs/spec/vaubaan-gateway.md` §5 (plugins), §3.2 (presets), §10
> (structural tests: at least one preset per plugin, every preset entry a
> risk of its own catalog, never a wildcard). ADR
> [[plugin-contract-and-credential-spec]]. Handbook [[plugin-sdk]].

`packages/plugin-sdk/tests/unit/`. The template plugin's own suite is under
"Scenarios — Provider plugins".

- **`catalog-loader.test.ts`** (31) — loads the `acme` fixture YAML (provider,
  `catalog_version`, date scalar kept as a string, optional fields,
  presets with default gate); collected, path-qualified errors: duplicate
  id, malformed id, id of another provider, malformed slice pattern,
  missing fallback (error, or accepted with `requireFallback: false`),
  zero presets (error, or accepted with `requirePresets: false`), preset
  entry referencing a foreign or unknown risk, env-qualified entry on a
  non-env-scoped risk or outside `acceptable_in_envs`, wildcard or
  sentinel in a preset entry (`wildcardIssues`: risk ids and preset entries
  each reported by their own rule), non-integer budget or unknown gate,
  an unknown key inside `rate_limit` reported at its path, a preset id
  declared twice or a risk repeated inside one preset, `caps` and
  `infra_limits` parsed into typed values (known keys, positive integers),
  a vector that must name its six axes while an override may name a subset
  (`isCompleteVector`),
  deprecated risk in a preset, unknown keys and bad enum values, provider
  slug, YAML syntax error naming the source; the fallback rules (exactly
  one entry by flag, pattern or id, which must match the catch-all write
  whatever made it the fallback; the `uncategorized-` id convention needs
  its dash; `fallback: false` opts out; a preset
  entry on the fallback is an error; an entry recognised by convention
  without `fallback: true` loads with a warning through `warn` and is
  still indexed as the fallback).
- **`registry.test.ts`** (11) — ids in registration order, `has/get/require`,
  `providerForTool` (exact name, prefix rule for unlisted tools, null),
  `toolDeclarations`, `labels` (with `experimental`, and `summary` when the plugin has one), `idEnum` (non-empty tuple, throws when
  empty), `catalogOf` indexed, `presetsOf`; conflicts: same id twice, tool
  outside the plugin prefix, ill-formed plugin reported with its id.
- **`define-plugin.test.ts`** (32) — fixture well-formed and frozen; `summary` optional, a non-empty paragraph of at most 600 characters when present; a `tokenHandouts` entry names a declared tool and risks of the catalog; **a preset that leaves a token-handing risk on `auto` is refused unless the plugin declares that risk read-only** (`readOnlyRiskIds`, a list of the handout's own risks; undeclared means write; refused where it is on `auto`, per preset and environment); every issue
  collected (id grammar, semver, tool prefix and duplicates, data-model
  and catalog provider mismatch); catalog rules through the definition;
  data-model referential integrity; credential spec rules per kind
  (api-key secret field, oauth2 https + PKCE for public clients +
  `refreshable` needs `refresh()`, app-install, ssh-key, unknown kind);
  the `app-install` `userVerification` block (well-formed with and without
  pagination, every malformed member named by path, `client_id` /
  `client_secret` required among the app settings);
  missing functions; `expectCredentialKind`; `normalizeArgsIfEnabled`
  (off by default, on with the flag, no hook no change); **budget rules on
  a TypeScript catalog**: a preset entry with an infinite quota, a negative
  rate or an unknown gate is refused like its YAML twin, every illegal value
  of one entry listed.
- **`identifiers-kit.test.ts`** (9) — **`assertIdentifiersRefused`, the
  behavioural proof of "what is executed is what was classified"**: passes a
  plugin whose `classify` and `execute` share one grammar and reports what it
  ran (tools, arguments, hostile calls, the path identifiers **found by
  running the samples**); **finds the fixture plugin, which interpolates its
  arguments**; finds a grammar applied in `classify` only (refused, yet
  sent — one finding per hostile value and position); finds a dot segment
  escaping left in place and accepts what escaping names exactly; finds an
  accepted value the request does not name (repair instead of refusal); a
  classifier that throws is a finding; **refuses to pass on nothing** (no
  identifier seen in a path must be stated with its reason, and a wrong
  statement is refused too); leaves out refused samples, undeclared tools
  and exempt arguments; reads a request reached after an answer when the
  routes give it. Each of the ten plugin directories runs it on its own
  samples in `plugin.test.ts` (no finding; GitHub: `owner`, `repo`,
  `branch`, `path`, `sha`, `workflow_id`; Supabase: `project_ref`,
  `function_slug`, `provider_id`, `tpa_id`, `type`; Vercel: `projectId`,
  `deploymentId`, `idOrUrl`, `domain`, `id`; Cloudflare: `zone_id`,
  `record_id`; Stripe: `id`; Resend: `id`, `segment_id`; Upstash:
  `databaseId`; Railway and SSH state why they have none in a path).
- **`testing-kit.test.ts`** (14) — `assertCatalogCoverage` on the fixture
  (touched risks in catalog order; `risksUntouched` leaves the fallback
  out — reachable by design only; `fallbackHits` names the samples only
  the fallback covered), every failure branch (tool without sample, sample
  for an undeclared tool, unexpected denial, expected denial not met, no
  slice, foreign provider, slice no risk matches), `PluginAssertionError`
  with every finding; `assertNoWildcard` on lists, catalogs and plugins;
  `assertPresetsValid`; `assertPluginWellFormed` (definition issues plus
  the fallback flag: a catch-all recognised by convention only fails);
  `mockFetch` (routes by method / URL / predicate, recorded calls, `times`,
  unmatched request rejects).
- **`streaming.test.ts`** (9) — **streamed results**: `appendPart` merges
  consecutive text parts and keeps every other boundary; `streamToolResult`
  returns the complete result without a sink, hands each part to the sink in
  order **before reading the next one**, propagates a provider failure after
  the parts already sent, and ends the iteration when the sink rejects (the
  provider is released); `textParts` yields one part per chunk, decodes a
  character split across two chunks, cancels the body on an early exit and
  throws when the body errors midway.
- **`catalog-path.test.ts`** (4) — `catalogPathNextTo`: default file name,
  `URL` input, the fixture resolving to a readable file, the two Turbopack
  rewrite shapes raising the named error.
- **`env-of.test.ts`** (8) — `envFromSliceSegment`: the identifier after the
  named entity; `undefined` when the entity is absent, terminal or followed
  by another entity; **`NO_SINGLE_ENV` when the environment segment is a
  wildcard, a recursive wildcard, a glob or a list**; composed by the host
  (`envResolverFor`), a slice spanning several environments of a resource
  labelled `staging` resolves to none while an env-less slice still takes
  the label; no confusion with an identifier equal to the entity name.
- **`arguments.test.ts`** (10) — **the argument surface of a tool is closed**
  (ADR [[plugin-arguments-closed-surface-and-typed-refusals]] D1):
  `undeclaredArgumentDenial` lets every declared argument through, in any
  number; refuses the first argument the schema does not declare, naming it
  and the tool; a tool that declares nothing takes nothing; `undefined` is
  an absent argument while `null`, `false`, `0` and `""` are values; another
  spelling of a declared argument (case, a space, `_id`) is another
  argument; inherited names (`constructor`, `__proto__` as an own key) are
  not declared; a key that is not name-shaped is described, never quoted;
  routing arguments are accepted whatever the tool declares, and nothing
  else; an unknown tool is not this rule's to refuse. `declaredOnly`, the
  test-table helper: keeps the declared entries, throws on an unknown tool.
- **`slices.test.ts`** (21) — **what a classifier may write into a slice**
  (same ADR, D2): `identSegment` writes an identifier of grammar characters
  as given (`feature/x`, `a.ts`, `v1~2`) and anything else — an e-mail
  address, a `+`, a colon, a space, a comma, a closing bracket, a glob, a
  lone star, a newline, a non-ASCII letter, the empty string — as "any
  identifier" (`[*]`). `sliceRoundTripIssues`: an identifier outside the
  grammar cannot be read back; one that reads back as something else (a
  comma becoming a list) is reported with both forms; wildcard segments and
  the placeholder read back as themselves.

## Scenarios — Shared

> Covers: `packages/shared/src/` — the risk-id grammar, the MCP tool-name
> convention and the eight refusal codes (`vaubaan-gateway.md` §4.1, §6),
> the token format, the session event details, the data-model check. Suites
> co-located with the source.

- **`risk-id.test.ts`** (20) — `parseRiskId` both forms, hyphenated provider
  and dotted name, eleven malformed inputs rejected; `formatRiskId`
  round-trip and null/empty env; `baseRiskId`; `isProviderId`;
  `isExplicitRiskId` (wildcards rejected).
- **`mcp.test.ts`** (10) — `toolPrefixFor` / `splitToolName` (hyphen ↔
  underscore, first separator only, malformed names); the eight refusal
  codes of spec §4.1 and §6; `isRefusalCode`.
- **`api-key.test.ts`** (12) — `generateApiKey` for `live` and `test`
  (`vbn_live_<8>_<32>` / `vbn_test_<8>_<32>`, the prefix being part of the
  key); `parseApiKey` tells the two kinds apart and rejects the retired
  `vbn_mgmt_` prefix, an unknown prefix, wrong lengths and a prefix or a
  secret outside base62; `hashApiKey` / `verifyApiKey` round trip, a key
  with one more character refused, `false` on a hash it cannot read.
- **`session-events.test.ts`** (30) — `parseEventDetails`, the one parser
  of the typed union of session event details: every kind that carries
  details is read from a well-formed sample (allowed and refused call, a
  call with the token it presented and its holder and a call stored before
  tokens had one, a token issued to a holder, one token revoked on its own,
  dropped and closed request, granted approval, gate opened for the period,
  gate edited on the mission, period reset, quota and expiry extension,
  rotation, revocation) and answers `null` for a malformed one; a kind
  without a details shape and a stored value that is not an object answer
  `null`; keys the shape does not name are ignored; the two shapes of an
  extension are told apart on their dimension.
- **`data-model.test.ts`** (4) — `validateDataModel`: a consistent model has
  no error; an orphan parent is reported with provider, plane and entity; a
  parent declared in another plane does not count; every orphan is listed.

## Scenarios — Provider plugins

> Covers: the ten handbooks under
> [`docs/handbook/providers/`](../handbook/providers/README.md) and
> [[plugin-sdk]]. Spec: `vaubaan-gateway.md` §5 (plugins), §3.2 (presets),
> §10 (structural tests); `gateway-risk-model.md` §7. ADRs
> [[plugin-contract-and-credential-spec]],
> [[plugin-catalog-path-and-standalone-tracing]],
> [[fallback-risk-only-when-uncategorized]].

Every plugin runs the SDK kit in `tests/unit/plugin.test.ts`
(`assertPluginWellFormed` — including the `fallback: true` flag —,
`assertPresetsValid`, `assertNoWildcard`, `assertCatalogCoverage` with one
realistic sample per declared tool; `risksUntouched` is asserted and
`fallbackHits` is empty) and exercises `execute` and `discoverResources`
against `mockFetch`, which rejects any unmatched request. **No test ever
reaches a provider.** Each plugin's `classify.test.ts` pins the
`(tool, args, resources) → slices` contract of its classifier, case by case.
The suites named `policy`, `mission-evaluation` and the like go one step
further: they run `classify` then `evaluateCall` on the shipped catalog, so
what they assert is the decision a mission gets — in particular that a
classifier **fails closed** (what it cannot place is refused or costs every
class, never the cheapest one) and that an env-scoped risk is refused on a
resource without a usable environment label. Counts per plugin are the
`plugins/<id>` totals of the table above.

**The identifier suite of each plugin** (`injection.test.ts`,
`identifier-injection.test.ts` or `identifiers.test.ts`; ADR
[[plugin-identifiers-one-grammar-for-classify-and-execute]]) feeds every
value of the arguments or of the connection that reaches a request path, a
query string or a request body the same hostile values — the dot segments,
their encoded forms, separators, control characters, oversized strings — to
`classify` **and** to `execute`. The rule under test: what is sent is
exactly what was classified. A value is refused by both, and then nothing
is sent, or accepted by both, and then every request names the resource of
the slice. `plugin-identifier-tests.test.ts` (structural) holds that every
plugin directory has one. Since ADR
[[plugin-arguments-closed-surface-and-typed-refusals]], the plugins whose
executor forwards arguments (Cloudflare DNS, Vercel, Railway, Supabase)
also assert that **an argument the tool does not declare is refused by
`classify` and by `execute`, with nothing sent**, and what an executor
declines by itself is read through the kit's `refusalText` (an `isError`
result carrying the sentence, never a thrown provider failure).

**Template** (25) — `plugin.test.ts`: the kit on the scaffold (every named
risk touched), a classifier case per convention (ref from the arguments,
single-resource default, ambiguity denied, a workspace outside the mission's
resources refused by `classify` and by `execute` through the one shared
resolver), `execute` against `mockFetch` (a provider failure is thrown: 401
as `UpstreamAuthError`, another status as `UpstreamHttpError`), the catalog
path resolved with
`catalogPathNextTo` and present on disk.

**GitHub** (585) — `plugin.test.ts` (14): structural kit (26 tools, the 14
named risks touched), the fallback lint, presets `read-only` / `developer` /
`release-manager`, the `app-install` credential spec with its five app
settings and the declarative `userVerification` (GitHub token endpoint,
`GET /user/installations`, 100 per page). `execute.test.ts` (25):
installation token minting (JWT → `access_tokens`), per-call repository
scoping, Octokit dispatch over the injected fetch, `UpstreamAuthError`,
`github__mint_install_token`, paged resource discovery; **the merge is bound
to the declared base** (the pull request is read first and a real base other
than the declared one is refused without merging), and `push_files` reads
`files` like the classifier. `classify` (69): every tool's slices, the
multi-slice tools, the `workflow-via-file` slice, retired tools, structural
denials, and 34 cases of **what it cannot place exactly** (non-canonical
workflow paths, `refs/…` branch names, malformed identifiers), all refused.
`risk-catalog` (56): one `[tool, args, risks]` row per call shape, evaluated
through the shipped catalog — the risks each tool touches, exactly.
`injection.test.ts` (415): the identifier suite — every identifier position
against every hostile value (319), numbers, what a legitimate value still
reaches, more refusals by both sides, the connection.
`token-cache` (5), `data-model` (1). No `envOf`: the catalog has no
env-scoped risk.

**Vercel** (622) — `plugin.test.ts` (48): kit (31 tools; every named risk
touched but `toolbar-write`, unreachable while the thread tools are
refused), project resolution against the mission's resources, `vercelEnvOf`
and the plugin's `envOf` composed with `envResolverFor` (the slice's
`env[prod]` wins over an owner label, an env-less slice falls back to it;
**a slice whose environment segment is a wildcard, a list, a glob or a name
outside the triad is `NO_SINGLE_ENV`**: none is resolved and the label is
not used, and no slice the classifier emits names several environments),
`api-key` credential spec, `execute` (rewrap of mcp.vercel.com and the
custom REST tools; **a provider failure is thrown, with its status when it
has one, and a network failure as it is — never an `isError` result** —
while what the executor declines itself stays an `isError` result with no
network call; **an argument a tool does not declare is refused on both
sides and nothing is sent** — a stray field, a field of the provider's own
API, `project_id` beside `projectId`, `target` on the deploy tool, any
argument of a tool that declares none) and `discoverResources` against
`mockFetch`.
`risk-catalog` (55): YAML structural validation, every pattern parses,
coverage lint, saliency checks. `classify` (43): per-tool slices,
`deploy_to_vercel` on `env[prod]` (the upstream tool has no target, and a
call that names one is refused: a deploy that reads "preview" would still
go to prod), the env-var fan-out, `project_id` not an argument (the call
that carries it is refused), one spelling per argument. `binding.test.ts` (50): **a
deployment- or URL-addressed tool runs only on a deployment of the mission's
project** — a foreign deployment is refused and nothing reaches the
provider; a lookup the provider fails (5xx) is an upstream failure, thrown,
and nothing is forwarded; the thread-addressed toolbar tools, which cannot
be bound to a project, are denied by the classifier. `team-pin.test.ts` (99): **every
request carries the team of the credential** and a `teamId` argument that is
not exactly that team is refused, for every declared tool (the sample table
is the tool list; the tools that cannot carry a team are reviewed one by
one). `firewall.test.ts` (11): slices, risks and request shapes of the
firewall tools. `identifier-injection.test.ts` (315): the identifier suite
(271 hostile values over every position, the dot-segment reproductions,
the deployment segment read like `execute` reads it, values that only
travel in a JSON body or a query, a project ref that is not path-safe
never used). `data-model` (1).

**Supabase** (1613) — `plugin.test.ts` (22): kit with one sample per tool
(44 tools; `row-write-one` and `auth.bulk-user-write` knowingly unreached),
presets, `oauth2` credential spec (PKCE, Basic client auth, `refreshable`
with no plugin `refresh`), `execute` (read-only `execute_sql`) and
`discoverResources` against `mockFetch`. `risk-catalog` (44): loaded shape,
posture-sensitive entries, coverage lint, cardinality mutual exclusion,
decision-level spot checks. `classify` (133), of which 91 on **the SQL of
`apply_migration`**: the reader is an allow-list of statement shapes — plain
DDL stays on the schema write, row writes, drops, RLS, privileges and
extensions each add their risk, and anything it cannot read statement by
statement needs every write class; **what follows a line comment ended by a
carriage return is read** (PostgreSQL ends `--` at a line feed or a carriage
return), inside a block comment or a string as well; **a column type change
adds the bulk row write** (`ALTER COLUMN … TYPE`, with or without `USING`,
`SET DATA TYPE`) while other column alterations stay on the schema write.
Outside the SQL: an identifier the slice grammar cannot carry (an e-mail
address, a `+`, a colon) is classified as "any" and the slice reads back as
itself; `deploy_function` without files is still a body write, and refuses
`files` in another shape and an undeclared argument. `execute` (42):
Management API and data-plane request shapes, **the target project resolved
exactly as the classifier resolves it** (a non-string `project_ref`, an
alias spelling), and **the body built from declared arguments only** (five
real fields of the provider's API that no rule reads are refused and
nothing is sent; `upload_object` refuses a content that is absent or not
base64 text before any request and sends the decoded bytes otherwise).
`mission-evaluation.test.ts` (34): on a project **without an environment
label** every write and the user listing are refused whatever the mission
holds, account-scoped reads stay allowed; on **prod**, a migration embedding
DML, dropping a table or unreadable is refused, a plain DDL migration needs
`migration-write` only; the three presets decided call by call on labelled
projects (`migration-operator`: any migration on staging, plain DDL and RLS
only on prod, behind an approval).
`identifier-injection.test.ts` (1337): the identifier suite (1287 hostile
values over every position, the dot-segment reproductions, one argument
naming the target for both sides, legitimate shapes, the query strings and
SQL text the plugin builds, the project ref as a host label).
`data-model` (1).

**Railway** (427) — `plugin.test.ts` (30): kit (the nine named risks
touched, no fallback hit), `classifyRailway` on `Resource[]` (project and
environment resolution, denials), `oauth2` credential spec (PKCE,
`resourceIndicator`, `prompt=consent`, no plugin `refresh`), `executeRailway`
(rewrap of mcp.railway.com with the stripped tool name, GraphQL variable
tools) and `discoverRailwayResources` against `mockFetch`. `risk-catalog`
(19): shape, `prepareCatalog`, runtime `risksTouchedBy`, variable writes as
classified, coverage. `classify` (22): a write of named variables is
`service-var[K1,…].W`; `replace=true` adds the marker
`service-var-replace.W`. `policy.test.ts` (39): a single variable write
touches `upsert-variable` alone and only a replace touches
`bulk-variables-replace`; each preset decided per call and per environment;
**`list-variables` with the read-only preset is refused on a prod, an
unlabelled and a free-text-labelled project**; an `environmentId` must
belong to the resolved project (`accept-deploy`, `redeploy`, the agent
tool).
`identifier-injection.test.ts` (294): a malformed id refused by `classify`
and by `execute`, variable names, `execute` running on the target
the classifier resolved, a project id discovery would refuse; **a tool
takes what its schema declares, nothing else** (8; `projectId` on a tool
that takes none is checked, then not sent); **`serviceId` is bound to the
project the mission holds** (20): a service of another
project is refused by both sides and nothing is sent, the project's own
service is sent as given, a service of another project _of the same
mission_ is still not the named project's, a project discovered before
services were recorded refuses with what to do, a project with no service
refuses every `serviceId`, a malformed list in the metadata binds nothing.
**An id nothing can bind is refused**: `deploymentId` of `get-logs` and
`threadId` of `railway-agent`, whatever their value, by `classify` and by
`execute` with nothing sent; the declared schemas do not offer them; no other
id-like argument of any tool is left unbound.
`data-model` (1).

**SSH** (696) — `plugin.test.ts` (299): kit (every catalog risk touched by
one `ssh__exec` sample); `classifySsh`: host resolution against the
mission's resources (single host default, explicit ref, foreign / ambiguous
/ malformed denied), read vs write, `secret-file` marker, `destructive` /
`package` / `service` / `privilege` markers, `sudo` on a whitelisted verb
stays a read, mixed lines touch both sides, a redirection to a file is a
write while `2>&1` is not, **a line that cannot be seen through carries
every class and is never a read**; runtime qualification through
`resourceEnvResolver` (`ssh[prod].exec-destructive` missing → denied; a
write on an unlabelled or free-text-labelled host is refused whatever the
mission accepts); **the presets evaluated through the policy engine** (55:
what `read-only`, `developer` and `operator` allow, gate and refuse per
environment, wrappers and spellings included); `splitCommandLine` and
`lexCommandLine` (words as the shell builds them, what it cannot see
through is named); the read allow-list matching whole argument vectors (71)
and the command-class tables (127: `isDestructive`, `isPackageInstall`,
`isServiceControl`, privilege wrappers with their options); credential spec
(`ssh-key`, four fields with patterns, `sshTarget` narrowing and refusals);
`fingerprintOf` / `hostKeyMatches`; `execute` and `discoverResources` over a
fake `SshTransport`. `adversarial.test.ts` (181): **command lines built to
fool the classifier fail closed** — comment and quote tricks, ANSI-C
quoting, substitutions, here-documents, control characters, inline
interpreters, unknown wrappers and other hosts are classified as every
class (129 lines), conservative shapes stay conservative and plain shapes
stay plain (51), a line without a command is refused.
`host-key-pinning.test.ts` (37): **the real `ssh2` transport against an
in-process ssh server on loopback** — the matching pin connects and runs the
command; a pin of another key, or one that is absent, empty, blank,
malformed, truncated, in another case, MD5 or not a string never
authenticates (no socket for a target without a usable pin); there is no
trust on first use; `execute` and `discoverResources` refuse a credential
without a normalised SHA256 pin before the transport.
`injection.test.ts` (87): the host is a hostname or an IPv4 address and
nothing else (54); the command sent is the command classified (27); a
character outside the BMP does not hide a glob or a brace (6).
`classify` (90), `data-model` (2). No test reaches a real host.

**Resend** (232) — `plugin.test.ts` (43): kit (the two deprecated v4 ids
knowingly unreached), the `from` domain as the resource, recipient zones
(a single send is its zone slice, never a count marker), batch sends,
domains / segments / contacts, broadcasts verified against the named
segment, misc denials, `execute` (only the declared fields of a tool reach
Resend) and `discoverResources` against `mockFetch`, `api-key` credential
spec and presets `read-only` / `developer` / `marketing-operator` /
`domain-admin`. `risk-catalog` (33): shape (the bulk entries declare only
the rate ceiling the gateway enforces, exact irreversible set, only the
exfiltration risk env-scoped, no preset on the fallback, the two deprecated
v4 ids) and slice → risk resolution. `classify` (64), of which 21 on
**fields that would escape the classification** (`To` / `Cc` / `Bcc`
envelope headers and the like, refused). `mission-evaluation.test.ts` (15):
an external-unbounded send from a prod or unlabelled domain is refused
whatever the mission accepted, one external recipient among internal ones is
enough, a mixed batch is refused whole; each shipped preset decided call by
call.
`identifiers.test.ts` (58): the grammars, the id of an email or a broadcast
and a contact selector in the request path, `segment_id` in the path, the
query and the body, the domain whose path carries its `domain_id`, an id
the provider answers. `addresses.test.ts` (13): **a string that could carry
a second recipient is not an address** (a recipient is classified on the
address it parses to and sent as the string given). `data-model` (6).

**Upstash Redis** (293) — `plugin.test.ts` (26): kit with one sample per
tool (21 tools, every named risk touched, no fallback hit), presets,
database resolution against the mission's resources (single-database
default; ambiguous, missing, foreign or malformed refused; account-level
tools need none), environment from the owner label of the database
resource, `api-key` credential spec (`email` non-secret, Management API key
secret), `execute` (Basic auth on the Management API, REST tokens redacted,
the data tools read `rest_url` + `rest_token` then POST the command,
malformed arguments refused as `isError` results before any network call,
401/403 → `UpstreamAuthError`, **any other provider failure thrown with its
status on both surfaces and a network failure thrown as it is, never an
`isError` result**) and
`discoverResources` (one resource per database, no token in the metadata,
200 cap with a warning) against `mockFetch`. `risk-catalog` (49): YAML
validation, pattern parsing, coverage lint, saliency checks.
`command-table.test.ts` (105): **every Redis command sits in exactly one
class** (the six sets are pairwise disjoint, no deleting command is a plain
write or a read); `execute` with one command, a pipeline or a
`MULTI` / `EXEC` body costs the union of its commands; an unknown command
is arbitrary execution; the dedicated tools cost what the same command
costs through `execute`. `policy.test.ts` (24): every write is refused on a
database with no label or a label the catalog does not list, reads pass;
the three presets per environment (`DEL` needs `delete-data` through either
tool). `classify` (30), `data-model` (1). `execute` (33): the management
tools, the Redis command each data tool builds, and **the database token is
posted to an Upstash REST host only**: nineteen `rest_url` / `endpoint`
shapes the Management API could answer — another domain, a look-alike
suffix, the bare suffix, a sub-domain chain, plain http, a port,
credentials or a host through userinfo, a path, a query, another scheme,
an IP address — fail before any request with an error that holds no token,
and the four legitimate shapes post to the host. `identifiers.test.ts`
(42): the grammar of a database ref, the database as a segment of the
Management API path, Redis keys and command words in the JSON body only.

**Stripe** (219) — `plugin.test.ts` (31): kit (every named risk touched, no
fallback hit), resource resolution and `modeOf` (ref suffix, metadata; the
env label is never a source of the mode), argument handling, `execute`
(form-encoded REST v1) and `discoverResources` (one resource per mode)
against `mockFetch`, `api-key` credential spec. `risk-catalog` (20): 16
named risks + fallback at catalog v4, every risk env-scoped on the mode, no
preset carries the fallback, the money-out risks carry the rate ceiling and
no cap the door does not enforce, slice → risk resolution including the
`payment-intent.W` side effect of `create_subscription` resolving to
`subscription-create` and a novel write to the fallback alone. `classify`
(48), `execute.test.ts` (23: only declared arguments reach Stripe).
`policy.test.ts` (30): **an argument that changes the nature of the call
costs the stronger risk** (`cancel_at*` → `subscription-cancel`,
`auto_advance` → `invoice-finalize`); **customer data is not reachable with
`read-billing-history` alone** (invoices, charges, payment intents and
events need `read-customer-pii`; `expand` and any undeclared argument are
refused); a resource with no resolvable mode, or a label contradicting the
key's mode, is refused; the three presets on their mode and nothing on the
other. `identifiers.test.ts` (59): the grammars, `id` as a segment of the
request path, identifiers that travel in the query string or the form
body, `account` as the resource the call runs on. `data-model` (8).

**Cloudflare DNS** (189) — `plugin.test.ts` (50): kit (15 tools, every risk
touched), zone resolution (single zone default, explicit `zone_id`, foreign
provider denied), record writes with the `critical` / `delete` overlays (an
under-specified write or deletion is critical by default),
`isCriticalRecord` / `recordSensitivity`, `execute` (a write or deletion
declared ordinary reads the record first and is refused on an apex, MX or
NS record; a path-unsafe record or zone id never reaches the API; 401 and
403 become `UpstreamAuthError`, another failed status an `UpstreamHttpError`,
and what the executor refuses itself is an `isError` result; **an argument
a tool does not declare is refused by `classify` and by `execute` and
nothing is sent** — real fields of the provider's API on the record, DNSSEC
and purge writes, a filter of a listing, a `zone_id` on the account-wide
listing, a key that is not name-shaped) and
`discoverResources` (one resource per zone) against `mockFetch`, `api-key`
credential spec and presets `read-only` / `dns-operator` / `zone-admin`.
`risk-catalog` (38): shape (11 named risks + fallback at catalog v2, no env
scoping, no cap), `prepareCatalog`, **every tool touches exactly its
risks**, `risksTouchedBy` sanity checks (`zone-delete` only on the zone
itself). `identifiers.test.ts` (59): the grammars, `zone_id` and
`record_id` as segments of the request path, the `account_id` of a zone as
a slice identifier and never a request, a record `name` and `type` in the
critical-record verdict, list filters in the query string. `classify`
(33), `data-model` (9).

**Gmail** (406, experimental) — `plugin.test.ts` (26): kit, the experimental
shape (`experimental: true`, version below 1.0, no tool exposed), coverage
through a tool-exposing variant of the plugin
(`draft-to-zone-external-unbounded` and `bulk-label-write` knowingly
unreached), mailbox selection (none, foreign, ambiguous), `oauth2`
credential spec (Google, PKCE, `client_secret_post`, offline consent, no
plugin `refresh`), `discoverResources` and the structured `not_implemented`
answer of `execute` against `mockFetch`, presets `read-only` / `developer`.
`risk-catalog` (45): loaded catalog lint, pattern parsing, per-tool
coverage, `risksTouchedBy` spot checks. `classify` (108): a search bounded
by a positive `from:` is its zone, **a no-reply or alerts local part makes a
sender `automated` only on a domain or an address the owner listed** (on a
domain nobody listed the local part is chosen by the sender: `unknown`), **a query the parser cannot bound is the
unknown zone plus the bulk marker**, sensitive labels fail closed on reads,
a draft to an external recipient or to a recipient that cannot be parsed is
refused, label tools need well-formed ids. `q-parser` (32, unions and
groupings reported, never read as a conjunction), `injection.test.ts`
(190: hostile values over the identifier positions; `gmailId` is one path
segment with no dot, separator or escape; `labelRef` is a label id or a
label name, never a dot segment), `data-model` (5).

**Structural — `apps/gateway/tests/unit/structural/catalog-caps-enforced.test.ts`**
(12) — ADR [[scope-caps-not-enforced-in-v5-0]]: the v5.0 door has no cap
stage, so none of the ten shipped catalogs may declare a `caps` block or an
infra limit the gateway does not enforce (one test per plugin); the check
itself flags both and lets the rate ceiling through, and its list of
enforced limits is pinned to what the code enforces today.

## Scenarios — gateway-core

> Covers: handbook [[gateway-core]]. Spec: `vaubaan-gateway.md` §4.1, §6,
> §8, §10 ("structured refusals", "credential separation");
> `gateway-risk-model.md` §8.

`packages/gateway-core/tests/unit/`, vitest, no network, no store.

- **`risk-gateway.test.ts`** (9) — the pure decision core
  `evaluateCallForToken`: allow, deny with missing risks and
  `code: 'risk-not-accepted'`, classify-denied, no-catalog (fail closed),
  denied_risks shadow, the classifier receives `(tool, args, resources)`,
  environment qualification from the adapter's `envOf` first (a derived
  env wins over the owner label, an abstaining hook falls back to it), then
  the mission's resources, and an explicit `envResolver` overriding both;
  `envResolver: 'unqualified'` names the test mode without a resolver;
  `denied_risks` may be left out (a v5 mission carries none).
  The decision is
  unchanged since v4; its inputs are the v5 `Resource[]` and the plugin's
  `classify`.
- **`errors.test.ts`** (31) — the eight refusal codes: exactly eight in
  `REFUSAL_CODES`, one builder sample per code, every field of every code,
  `hint` non-empty and serializable, `isRefusal` guard, JSON-RPC mapping
  (`-32603`, refusal in `data`, code in the message); `mission-inactive` for
  an orphaned mission tells how long an earlier request stays grantable;
  **a mission token that stopped working** is an authentication failure
  with its reason (`token-rotated`, `token-revoked`, `holder-removed`,
  `holder-deactivated`), never a refusal code, and an unknown bearer carries
  no reason.
- **`token-holder.test.ts`** (3) — who a token belongs to: the audit keeps the
  id of a member and the name of a named token; a reader is shown the email
  of a member and the name of a named token; the two kinds are a closed set.
- **`fingerprint.test.ts`** (12) — the one argument hash (audit entry,
  approvals): recursive key sorting, arrays in order, `undefined` dropped,
  `toJSON`, BigInt refused, known sha256 vector, key order vs one-byte
  change, null/undefined ≡ `{}`, 64 hex. **`unfaithfulArgument`**: nothing
  found in what JSON carries as is; the first number JSON would rewrite as
  `null` (`Infinity`, `-Infinity`, `NaN`) named with its path; a BigInt
  named; and why it exists — `Infinity` and `null` share a fingerprint.
- **`audit.test.ts`** (2) — `MemoryAuditWriter` over call and administrative entries; a call entry
  carries every spec §8 field.
- **`cache.test.ts`** (7) — `MemoryCacheClient`: TTL expiry, delete, bound
  evicts the oldest, re-set refreshes age, expired swept before a live
  eviction, invalid bound rejected, a TTL that is not a positive finite
  number caches nothing.
- **`authenticate.test.ts`** (11) — credential separation: door table,
  `checkDoor` on every mismatch (mission token at management, delegated
  token at execution, session at either) → `wrong-credential-kind` with
  door/presented/expected; `parseBearer`; `DoorAuthenticator` end to end;
  unknown bearer → `AuthError`, not a refusal.
- **`pipeline.test.ts`** (38) — `checkMissionActive` (status, passed and
  future `expires_at`, **an unreadable `expires_at` is expired: the check
  fails closed**), `checkConnectionAvailable`; `CallPipeline` over a
  context built from the shared types (`ConnectionResource`, policy entry
  list, one-off period): happy path with the full audit entry, inactive
  mission refused before anything else, `resource-not-in-mission` before
  any risk evaluation, expired connection, `risk-not-accepted` through the
  real decision core fed with the resources of the target connection and
  the budget untouched, structural rejections without a code, budget
  refusal with no upstream call, approval id carried to the audit, upstream
  failure after allow (`decision: allowed`, `upstream_error`, no refusal),
  `UpstreamRefusalError` (entry still `allowed`, `upstream_error` prefixed by
  the code, the outcome carries the refusal), a call with no target rejected
  before any risk with no code. **An argument JSON cannot carry is rejected
  before any stage**: `Infinity` in the arguments is a structural rejection
  naming its path — no stage called, no budget touched, an entry without
  refusal code — because the approver would have read `null`. **The audit never stores the provider's
  text**: `UpstreamFailureError` puts a host-built summary in the entry and
  the detail in the outcome, the message of a plain error never reaches the
  audit, the stored summary is bounded and `upstreamErrorClassName` is an
  identifier, never free text. **An audit write that fails after a
  successful forward is not recorded as an upstream failure** and
  propagates, as it does after an upstream failure. **The audit copy of a
  refusal reason holds no argument value**: a classifier denial that quotes
  an argument reaches the agent whole and the audit with `[argument]` in its
  place, redacted in one pass (a short value is not found inside a
  placeholder already written), a value with pattern characters replaced as
  text, the stored reason bounded. **A stage that throws before the decision
  is refused and audited** (ADR [[decision-stages-fail-closed-and-audited]]
  D1, invariant `every-refused-call-audited`): a classifier that throws
  leaves one entry — `refused`, no code, the connection, the resource, the
  tool, the argument hash and the token as known, the reason naming the
  stage and the error class and never the message — with no budget asked
  and nothing sent upstream, and the host is told through `onStageError`;
  the resource stage throwing is audited with no target; the budget stage
  throwing is audited with the risks the call touched; a thrown value that
  is not an error and a free-text error name both read `Error`; an observer
  that throws does not un-audit the refusal; the audit write of that
  refusal failing still propagates.
  The real stages — resource, risk, upstream — and the door are tested in
  "Scenarios — Execution door" below; the budget stage in "Scenarios — Budget
  and sessions".

## Scenarios — Instance configuration, crypto, composition root

> Covers: spec §4.3 (instance configuration, admin rule), §6 (encryption
> at rest, no secret in logs), §10 structural "no configuration value is
> hard-coded". Handbook [[configuration]], ADR
> [[docker-image-and-config-format]]. Co-located under
> `apps/gateway/src/server/**` unless a path says otherwise.

- **`config/load.test.ts`** (54) — minimal env-only configuration with
  defaults; every missing required key named at once with its variable(s);
  `public_url` http refused, non-URL and query string refused, trailing
  slash stripped, sub-path kept; master key length / base64; bootstrap
  token length; trusted proxies IP/CIDR; durations, integers, booleans,
  log level; **admin rule** (group alone, emails alone lower-cased, both,
  neither → error naming both variables, non-email); IdP block optional
  → bootstrap required, configured → bootstrap optional with default
  claim mapping, partial block names the missing sub-keys, https issuer,
  claim mapping and allowed domains; provider apps from
  `VAUBAAN_PROVIDER_<ID>_<FIELD>[_FILE]` including hyphenated ids, unknown
  field refused in env and YAML; YAML `${VAR}` / `${file:}` resolution,
  **file wins over env key by key**, unset reference and missing secret
  file named, missing / invalid / non-mapping file, empty file,
  `previous_keys` duplicate version, `*_FILE` alone and both-set error; a
  master key is registered with the redactor in the form it was configured
  in; an explicit `telemetry.enabled`, true or false, is told from one that
  is not set; **`KEYS` and the example files stay in sync** (every variable
  in `.env.example`, every YAML leaf in `gateway.example.yaml`); **the
  example YAML is fully commented out** — it parses to an empty document
  and, copied as is, overrides nothing from the environment;
  **authorization server of the management door**: defaults (15 m access
  token, 30 d refresh token, 30 s reuse window, `operator-approved` with the
  loopback exception), every key from the environment and from the YAML
  file, which wins; an access token longer than 1 h, a refresh token that
  does not outlive the access token, a reuse window above 60 s, an unknown
  policy and a malformed duration are refused naming each key; **boolean
  and integer spellings per source**: a variable reads `yes`, `ON`, `1` and
  `True` as true; the file takes a YAML boolean and a YAML number and
  refuses the spellings `yes`, `"true"`, `on` and a quoted integer.
- **`config/keys-doc.test.ts`** (35) — **structural: the key table of the
  configuration handbook is the loader's.** The table of
  `docs/handbook/configuration.md` has the six columns the test reads and
  lists each key once; it has a row for every key of `KEYS` and no other
  row; for each of the 29 keys the type, the default, the bounds and the
  variables written in the row are the loader's; the provider-app family is
  documented with the fields the loader accepts.
- **`config/duration.test.ts`** (2) — `30s 10m 24h 7d`; rejects the rest.
- **`crypto/aead.test.ts`** (12) — round trip and `keyVersion` stamp, fresh
  nonce, **AD mismatch** (other connection id) fails, tampered blob,
  short blob, unknown format byte, empty and unicode plaintext, empty
  connection id; **`key_version` honoured**: v2 encryptor opens v1 blobs
  through `previous_keys`, seals with v2, v1 cannot open v2, unknown
  version names `encryption.previous_keys`, right version wrong key fails;
  `deriveConnectionKey` deterministic and distinct per id and per master
  key.
- **`logging/logging.test.ts`** (6) — mission token prefix kept, secret
  dropped; configured secrets replaced longest-first and JSON-escaped;
  empty secrets ignored; JSON line shape with bindings; a field named
  `time`, `level` or `msg` does not overwrite the line's own; level
  threshold and stderr routing.
- **`compose/compose.test.ts`** (17) — `buildRoot` from configuration
  alone over the `:memory:` store (schema version 11, the shipped registry); the store
  receives the root's encryptor and a `RegistryCatalogIndex` (base ids,
  env-qualified ids within `acceptable_in_envs`, unknown provider,
  wildcard refused) and is closed with the root; with an injected empty
  registry, provider apps are a warning; with plugins registered, a
  provider app for an unknown plugin is a `ConfigError` naming
  `providers.<id>` and `VAUBAAN_PROVIDER_<ID>_*` (exit 78); `checkProviderApps` passes on matching or absent apps; no secret in
  the boot log; `getRoot` builds once and shares the promise, forgets a
  failed build; `bootOrExit` exits 78 naming the key, 1 on other failures,
  nothing on success; `MemoryRateLimiter` window and reset,
  `MemorySessionStore` (unknown or expired session); **a step that throws
  after the store is opened** closes the store handle and stops the timers
  already started, then rethrows, and a root that builds stops its timers
  and closes the store once on `close()`; **one warning at boot when
  `trusted_proxies` is empty** — it names the key, `VAUBAAN_TRUSTED_PROXIES`
  and the 429 it costs — and none once a proxy is declared, the
  configuration line then carrying `trusted_proxies: 1`.
- **`http/healthz.test.ts`** (4) — 200 with build stamps and store kind
  (`memory`) and no configuration value, 503 degraded on store ping
  failure, 503 unavailable when the root cannot be built; the handler needs
  only the store liveness, a logger, the build stamps and the start time.
- **`http/client-ip.test.ts`** (11) — the one trusted-proxy / client-address
  rule (`clientIpResolver`), used by the request page limit and by the
  door's token-verification throttle: `X-Forwarded-For` ignored when no
  proxy is trusted (one shared key), the right-most hop that is not a
  trusted proxy, a forged left-hand entry not believed, `unknown` when every
  hop is trusted or the header is absent, a malformed hop stops the walk,
  IPv6, ports and brackets, invalid or out-of-family `trusted_proxies`
  entries skipped instead of trusting more; `isTrustedProxyEntry` accepts
  exactly what the matcher keeps.
- **`tests/integration/compose/boot.test.ts`** (4) — the production
  wiring against a temporary SQLite file: the database is created, the
  migrations applied (`schema_version` 10, ten `schema_migrations` rows),
  the store pings and `/healthz` reports `{ kind: 'sqlite', status: 'ok' }`,
  the boot log carries `store opened`; a store secret is sealed with the
  encryptor built from the configuration (blob not clear text, current
  `key_version`) and reopens after a second boot without re-migrating; a
  risk id the registry does not know is refused
  (`UnknownRiskIdError`); an unreadable `store.path` exits 1 with a
  message naming `store.path` and `VAUBAAN_STORE_PATH`.
- **`apps/gateway/tests/unit/structural/no-hardcoded-config.test.ts`**
  (one test per scanned file; the count is in the table above) — no literal URL, Supabase ref, GitHub /
  Stripe / mission token, private key or JWT in the whole application
  (`apps/gateway/src`, `next.config.ts`), `deploy/`, `scripts/`,
  `.github/workflows`; only `telemetry-default.ts` and
  `deploy/config/*.example*` are exempt.
- **`apps/gateway/tests/unit/structural/example-config-providers.test.ts`**
  (10) — the deployment examples show the provider apps the shipped plugins
  take, and nothing else: every provider block of `gateway.example.yaml` and
  every `VAUBAAN_PROVIDER_*` variable of `.env.example` is one a plugin
  declares, the two examples show the same providers, commented and active
  lines are read alike; the checks themselves refuse a provider that takes
  no app, an unknown provider, an undeclared field and a missing required
  one.
- **`apps/gateway/tests/integration/standalone-native-addons.test.ts`** (3)
  — reads the build output and is skipped when `.next/standalone` is
  absent (CI builds before testing): the `/healthz` route handler trace lists
  the `argon2` and `better-sqlite3` `.node` binaries; a Node process started
  inside the standalone tree resolves both packages from the standalone
  `node_modules` (not the repository's), hashes with argon2 and runs a query
  on an in-memory SQLite database.
- **`apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts`**
  (3) — same skip rule: the template's `risk-catalog.yaml` is traced into
  `.next/standalone` next to its module, and so is every
  `plugins/<id>/src/risk-catalog.yaml` of the repository (the list is read
  from the `plugins/` directory; none may be missing); **the output ships no
  test file** — no trace names one and the standalone tree holds none. ADR
  [[plugin-catalog-path-and-standalone-tracing]].

Container smoke (`deploy/docker/smoke.sh`, CI job `docker`): see
[`e2e-tests.md`](./e2e-tests.md).

## Scenarios — Human authentication

> Covers: spec §0 (Operator, User, Group, IdP), §4.2 Administration, §4.3
> (IdP block, bootstrap token, admin rule), §6 "human authentication"
> (short sessions bound to the origin, origin check on every mutation), §7.1,
> §10 integration "simulated IdP" and structural "authority recomputed from
> current membership". Handbook [[authentication]], ADRs
> [[oidc-relying-party-and-web-session]],
> [[sign-in-hardening-host-cookies-group-overage]],
> [[users-keyed-by-issuer-and-subject]] and
> [[operator-deactivates-a-user]]. Co-located under
> `apps/gateway/src/` unless a path says otherwise.

- **`server/auth/claims.test.ts`** (22) — groups claim as array (trimmed,
  de-duplicated, non-strings dropped), as space/comma/semicolon delimited
  string, absent or of another type; default and custom (Entra-style)
  mapping; email lower-cased, `name` → display name; missing `sub` /
  `email` fail closed naming the claim(s) (`LoginError` `claims-missing`);
  allowed email domains (empty list = any, case-insensitive, no `@`);
  **`email_verified: false` is refused** with its own closed code, whatever
  claim the email is mapped from, while a verified email and an IdP that
  does not send the claim pass. **Group overage (Entra ID)**: a token whose
  groups were moved out of it (`_claim_names` naming the claim) is refused
  with `groups-overage` instead of being read as "no groups"; so is the
  implicit-flow marker `hasgroups`, as a boolean or a string, and a partial
  groups claim next to the pointer; the configured claim name is followed (a
  pointer for another claim is not an overage); a token with no groups and no
  pointer passes.
  **The issuer is required**: a user is (issuer, subject), a token without
  `iss` or with a blank one is `claims-missing`, and `iss` is never read
  from a mapped claim although the subject may be. **When the userinfo
  request failed** (`userinfoFailed`): a groups claim absent from the ID
  token is refused with `groups-unavailable`, naming the configured claim —
  unknown is not "none"; an ID token that carries the groups itself, even an
  empty list, signs in; a missing identity claim is reported first; without
  a failure, an absent groups claim is an IdP that sends none.
- **`server/auth/admin-rule.test.ts`** (5) — group match, email match
  (case-insensitive), neither, either half of a combined rule,
  `describeAdminRule` without secrets.
- **`server/auth/origin.test.ts`** (5) — matching `Origin`; another origin,
  scheme or the internal host refused; `Referer` fallback; neither header
  or `Origin: null` refused; 403 body `origin-mismatch`.
- **`server/auth/session-service.test.ts`** (11) — cookie attributes
  (`HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age`), malformed values
  ignored; **both cookies are named with the `__Host-` prefix** and keep what
  it requires (`Secure`, `Path=/`, no `Domain`), and writing or clearing a
  `__Host-` cookie on another path throws; user session created / read / destroyed; **absolute expiry** at
  `SESSION_TTL_MS` (8 h); pending logins apart from sessions, single use,
  10-minute TTL; a stored session or pending sign-in of another shape reads
  as none and is deleted.
- **`server/auth/bootstrap.test.ts`** (3) — exact token accepted while
  active, variants refused; `unavailable` without a configured token;
  revocation persisted in `instance_config`, durable across services,
  idempotent (first timestamp kept), token refused afterwards.
- **`server/auth/idp-settings.test.ts`** (8) — none until saved, then read
  back from the store (`source: store`); client secret **sealed**
  (`secret_blob`, associated data `instance_config:idp.client_secret`);
  blank secret keeps the stored one; **the secret is asked again when the
  issuer changes** (the stored one is never sent to another identity
  provider); every problem reported at once, http
  issuer only with `allowInsecureIssuer`; file configuration wins and makes
  the service read-only; `splitList`; every key saved in one transaction (a
  failed write keeps the previous settings whole).
- **`server/auth/handlers.test.ts`** (9) — `safeReturnTo`: same-origin
  paths kept; URLs, `//host`, `/\host` and relative junk fall back, and so
  do seven shapes a browser resolves to another origin (a tab, newline,
  carriage return or NUL after the first slash, `/.//a//host`,
  `/x/..//a//host`).
- **`server/auth/guard.test.ts`** (10) — the one guard of every mutating
  handler, `guardMutation` (origin, then session, then role): another
  origin, no `Origin` and no `Referer`, an opaque `Origin` and a foreign
  `Referer` are refused **before the session is read**; a same-origin
  `Referer` stands in for a missing `Origin`; nobody → 401 whatever the
  role; the `user` role lets a user through, operator or not, and not the
  bootstrap operator; the `operator` role follows the admin rule.
  `guardSession` checks session and role without the origin (reads);
  `refusalResponse` words each refusal and is never cached.
- **`tests/unit/server/auth/mutation-guard.test.ts`** (287) — **structural:
  the guard covers every mutating handler.** Every handler of the human
  surfaces is classified and every mutating route of the app (32 route
  files) is found from the source and must delegate to a guarded mutation;
  then, table-driven over the 32 mutating handlers (missions preview / issue
  / rotate / revoke / gate edit, member add / remove, token generate /
  create named / revoke, request decide, connection connect /
  discover / revoke / resource edit / transfer / reassign, provider app,
  share create / revoke, group create / add member / remove member, user
  deactivate / reactivate, OAuth
  consent answer / client decision / delegation revocation, telemetry
  toggle, IdP settings, logout, bootstrap login): the rightful caller
  passes; another origin, no origin, no session, a session of the wrong role
  and a bootstrap session whose token was revoked are refused **and write
  nothing**. The three protocol endpoints of the authorization server
  (`token`, `revoke`, `register`) are held to reading no session.
- **`tests/unit/app/admin-guard.test.ts`** (63) and
  **`tests/unit/app/app-guard.test.ts`** (136) — **structural: every page and
  route authenticates itself; the layout is not the boundary.** The pages
  and routes of `/admin` and of the `(app)` surface are discovered from the
  file tree. Each admin page calls `requireOperator()` and renders nothing
  for a visitor without a session, a signed-in non-operator and a bootstrap
  session whose token was revoked; each `(app)` page calls a session helper
  before it reads anything from the root and renders nothing without a
  session or for a revoked bootstrap session; each route only delegates to
  a handler known to authenticate (401 / 403 otherwise, the bootstrap
  operator refused where a user is needed).
- **`tests/unit/app/field.test.tsx`** (6) — form labels are bound to their
  controls, rendered to static markup (no browser): `Field` with `htmlFor`
  is a real `<label for>`, a group named by its label when it holds several
  controls, no label element without a label, the error shown in place of
  the hint; `CredentialFieldInputs` binds every label, textarea included,
  with ids that stay unique when two lists share a page.
- **`tests/unit/app/design-tokens.test.ts`** (62) — the token sheet is the
  specification of the look: light is the default, dark exists for a chosen
  theme and for the system, and the two dark blocks hold the same values;
  four text sizes and two weights; **every documented pair of text and
  surface meets WCAG AA in both themes** (26 pairs each; the placeholder ink
  is below it on purpose); a white letter holds on every mark hue; every
  style refers only to tokens that exist, every token is used, no style sheet
  holds a raw colour, and a font size is a token or relative.
- **`tests/unit/app/shell-and-vocabulary.test.ts`** (23) — the words of the accounts, reference, activity and settings pages (who owns an account and who else holds it, the confirming button of "Give access", a short date, what a preset holds, the retention in the lede of the record, the setup count; a word for every refusal code and every administrative act, none of them a protocol word), the two pages that were folded into another (`/shares`, `/delegations`) and the server's constant of connected apps; and the side
  navigation holds seven entries in the order of the redesign, each leading
  to a page that exists; every page is under exactly one entry; the local
  navigation of Settings leads to pages that exist and uses no label twice;
  the path constants the server redirects with equal the routes; **every old
  page path redirects to a page or a route that exists, and the provider
  callback is never redirected**; the three states of the theme and its
  cookie; the words and sentence patterns of the vocabulary.
- **`tests/unit/app/design-system.test.tsx`** (33) — the components rendered
  to static markup: one `h1` per page header and the order of its actions; a
  meter drawn only near its limit, with its figure in words; **a table over
  its column budget throws** (five by default, seven with details), its
  caption, its detail columns and its row tones; marks that carry their word;
  the columns of each permission table and the closed "why?"; Can / Asks you
  first / Cannot; a field that says its expected shape and ties its error to
  its control; a dialog that states its consequence before its button; **the
  components added with the mission pages**: the rest behind a named, closed
  menu button; a choice that would yield nothing drawn unavailable with its
  reason in place of its count; a key whole in a named box with its copy
  button; the numbered steps of a form and its rail as a complementary
  landmark.
- **`tests/unit/app/risk-explain.test.tsx`** (9) — static markup of the
  shared risk components: a `Slug` carries its kind as an attribute, a glyph
  and a word for assistive technology, is a link when given a target, prints
  a risk id linked to its catalog entry, and every kind has a legend entry;
  `VectorStrip` writes the six values and names each axis in full;
  `RiskExplain` in three lines, the class left out of a list already grouped
  by class; help rendered closed with its button; a callout with a title, an
  icon and the role of a note.
- **`src/components/connections/shape.test.ts`** (5) — `shapeOfPattern`, the
  shape a credential field expects, read from the plugin's pattern and said
  in its label: a literal prefix, a choice of prefixes each written whole
  ("starts with sk*test* or rk*test*"), a minimum, exact or bounded length,
  digits only; and nothing for a pattern it cannot read whole or that states
  no shape.
- **`src/components/auth/principal.test.ts`** (2) — `isOperatorPrincipal`,
  the interface's one statement of who is shown as an operator (the
  Administration link, the Audit page's sentence): true for the bootstrap
  token and for a user the admin rule matches, false for any other user.
- **`tests/integration/auth/oidc-login.test.ts`** (22) — the composition
  root over the `:memory:` store with the real `openid-client` relying
  party and the in-process **`FakeIdp`** (`fake-idp.ts`: discovery, JWKS,
  token, userinfo through `customFetch`; ES256 ID tokens; PKCE S256
  verified; `authorize()` plays the consenting browser), handlers driven
  with web-standard `Request`s:
  1. first sign-in creates the user (email lower-cased, display name) and
     its `idp` groups; the principal is `isOperator` through the admin
     group; `groups` scope requested because the IdP advertises it; the
     client secret never reaches the log;
  2. re-login with changed groups rewrites IdP memberships, leaves a local
     group alone, keeps the emptied IdP group's row;
  3. a claim colliding with a local group is ignored with a warning;
  4. **structural** — removed from the admin group, the next
     `authenticate()` reports `isOperator: false` and `authorizeAdmin` 403;
  5. non-admin user: 403 on `authorizeAdmin` and on the settings handler;
     no session → 401;
  6. bootstrap: `/auth/login` without IdP → `idp-not-configured`; the token
     form refused without `Origin` (403) and with a wrong token
     (`bootstrap-refused`); accepted → bootstrap session authorised on
     `/admin`; the IdP saved through the form (secret sealed, one
     `config-changed` audit entry by `bootstrap` without the secret); a
     non-operator IdP sign-in leaves the token active; the first operator
     sign-in revokes it (`bootstrap.revoked_at`, log line); then the form
     answers `bootstrap-unavailable`, `verify()` is false and the stale
     bootstrap session is 401 and deleted;
  7. the callback URL is built from `public_url` even when the request
     arrives on `http://127.0.0.1:3000`;
  8. tampered `state` → `state-mismatch` (no session, login cookie
     cleared); callback without pending login → `login-expired`; IdP
     `access_denied` → `idp-error` with the detail logged;
  9. email outside `allowed_email_domains` refused (no user created);
     missing claims → `claims-missing`;
  10. userinfo claims merged under the ID token claims (userinfo-only
      email and groups);
  11. logout: cross-origin POST → 403 and the session survives; same-origin
      → 303 `/login`, row deleted, cookie cleared;
  12. sessions are rows of `web_sessions`;
  13. a sign-in whose email the IdP marks as unverified is refused: no
      user, no operator, the bootstrap token still active;
  14. a sign-in replaces the session the browser already had;
  15. an IdP save whose audit entry cannot be written stands and is
      reported at `error`;
  16. a body that is not a form answers 400;
  17. **group overage**: a sign-in whose groups the IdP moved out of the
      token is refused (`/login?error=groups-overage`, no session); the
      memberships of a known user are kept, not emptied, and an unknown
      user is not created;
  18. **groups that could not be read refuse the sign-in**: with an IdP that
      sends the groups through userinfo only and a userinfo endpoint that is
      down, the sign-in answers `/login?error=groups-unavailable` with no
      session; nothing is synced (the user keeps both groups, the session
      they already had keeps its operator marker), the refusal is logged,
      somebody never seen before is not created, and the sign-in passes
      again once userinfo answers;
  19. userinfo down does not refuse a sign-in whose ID token carries the
      groups (the failed request is logged);
  20. **a user is (issuer, subject)**: after the operator points the
      instance at another IdP, the same subject is a new person — a new
      account with no group, the first account not refreshed, not signed
      into, its groups intact;
  21. an account deactivated here stays closed to its issuer
      (`account-deactivated`) and does not close the same subject at
      another issuer;
  22. **accounts from before the issuer was recorded are bound by the first
      sign-in, all of them, once**: the returning user finds their own
      account, the count is logged, the one who did not sign in is bound
      too with their deactivation, and nothing is left for another issuer
      to take.
- **`tests/integration/auth/deactivate-user.test.ts`** (12) — **the operator
  deactivates a user**, on the real root (`:memory:` store, simulated IdP,
  the instance's HTTP surface) with a user who holds one of everything: a
  web session, a delegation with live tokens, a mission issued through it on
  a connection shared with them, a local-group membership, a connection of
  their own:
  1. before: the session, the mission token and the delegated token work;
  2. **deactivation ends everything at once**: the session is nobody; the
     access token is answered 401 at the management door and the refresh
     token `invalid_grant` (delegation `revoked`, reason
     `user-deactivated`); the mission is refused `mission-inactive` at the
     execution door **with its row still `active`**; the user is in no
     group; their own connection is `unowned` and listed for the operator;
     a new share to them is `target-unknown`; one `user-deactivated`, one
     `delegation-revoked` and one `mission-orphaned` (`creator-removed`)
     entry in the operator's name, and no `mission-revoked`;
  3. the sign-in of a deactivated user is refused
     (`/login?error=account-deactivated`) although the IdP vouches: no
     cookie, the user row unchanged, the refusal logged, and no new consent
     possible;
  4. **reactivation**: the mission serves again with the same token
     (`mission-restored`, `user-reactivated`); the session opened before the
     deactivation stays nobody, the delegation stays revoked, the local
     group and the connection do not come back; a new sign-in is a new
     session;
  5. the deactivated owner's connection is reassigned by the operator;
  6. refusals that write nothing: one's own account
     (`cannot-deactivate-self`), an unknown user, an active user to
     reactivate, a user already deactivated;
  7. a deactivation of which one step fails closes everything it can, then
     reports the failure: the audit entry and the settlement do not depend
     on the delegations;
  8. **what a half-failed deactivation left open is closed before the user
     is active again** (ADR
     [[one-membership-rule-checked-in-the-token-insert]] D4): the
     delegation still `active` in the store is revoked by the reactivation
     (`user-deactivated`), its refresh token answers 400 and its access
     token 401 — the user consents again;
  9. a reactivation that cannot close what was left open does not happen:
     the user stays `removed`, no `user-reactivated` entry, and the
     operator's second attempt goes through once the store answers;
  10. the bootstrap operator deactivates anyone, an operator included;
  11. over HTTP, an operator's `POST /admin/users/<id>/deactivate` and
      `…/reactivate` answer 303 to `/admin/users` with a notice;
  12. a plain user, a foreign origin and no session are refused, and nobody
      is deactivated.

## Scenarios — Store

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §2, §3.3,
> §3.5, §6 ("encryption at rest", "authoritative, atomic counting",
> "immutable audit"), §8, §10 (structural tests). Handbook [[store]]. ADR
> [[embedded-store-sqlite-and-migrations]]. Every suite runs on an
> ephemeral `:memory:` store with the real migrations (`0001`-`0013`), a
> `ManualClock`, a `StubEncryptor` and a five-id `SetCatalogIndex`
> (`apps/gateway/src/server/store/testing.ts`); the two file-based cases
> use a temp directory. Paths are relative to `apps/gateway/tests/`.

- **`unit/server/store/ids.test.ts`** (6) — UUIDv7 canonical form and
  version/variant bits, embedded millisecond timestamp, ordering across
  milliseconds, strict monotonicity of 5k ids within one process (counter
  in `rand_a`), 10k uniqueness, rejection of non-v7 ids.
- **`unit/server/store/migrate.test.ts`** (9) — `NNNN_name.sql` loading
  and ordering, malformed file name rejected, duplicate version rejected,
  idempotent re-run, incremental apply of a new file, checksum
  immutability of an applied file (boot refused), full rollback of a
  failing file (nothing recorded, no table left), a database carrying a
  migration this image does not ship is refused, the eleven shipped
  migrations `0001`-`0013` in the default directory.
- **`unit/server/store/db.test.ts`** (2) — `isSqliteVersionAtLeast`
  against `MIN_SQLITE_VERSION`: major, minor and patch compared in order;
  a missing or malformed component counts as zero.
- **`integration/store/schema.test.ts`** (6) — the 30 tables exist; every table is `STRICT`; the store satisfies the composition root's
  `Store` port (`kind`, `ping()`, `close()`); boot against an empty file sets WAL,
  `foreign_keys`, `synchronous=NORMAL` and reopens without re-migrating;
  two writers on one file serialize under `BEGIN IMMEDIATE` (second gets
  `SQLITE_BUSY` while the lock is held, succeeds after commit);
  `VACUUM INTO` backup is a readable single file with no `-wal`.
- **`integration/store/audit.test.ts`** (15) — `agentLabelActivity`: a
  mission's calls of a span per agent label and decision, the unlabelled
  ones apart, `since` inclusive and `until` exclusive, an open span, another
  mission and administrative entries left out; `search` by agent label
  matches no administrative entry. And: gateway-core
  `CallAuditEntry` round-trips through `audit` + `audit_risks` rows
  (accepted snapshot, touched, remaining budget), a touched-but-not-accepted
  risk is kept, `AdminAuditEntry` round-trips, **`UPDATE` aborts**
  (decision, latency, risk rows), **`DELETE` aborts** outside the purge
  path, `purgeOlderThan` removes only older rows and closes the window,
  a recent row cannot be deleted even inside a window, retention default
  90 days from the clock, filters (mission, kind, range, limit),
  `countAllowedTouches` for the counters-vs-audit check, schema `CHECK`s
  refuse incomplete entries, `SqliteAuditWriter` implements gateway-core's
  `AuditWriter` and propagates failures.
- **`integration/store/audit-guarded-append.test.ts`** (10) —
  **`appendUnlessLatest`, one entry for a change two writers observed**: it
  writes when the object has no earlier entry of the guarded acts; holds
  back the same act recorded since the guard instant — two writers, one
  entry — and an entry written at the guard instant itself; writes the other
  act, and the same act again once the other one came between; an equal
  entry older than the guard instant holds nothing back; the comparison is
  per object and only within the guarded acts; a guard that does not name
  the act being written is refused. **`agentLabelActivity`**: a bounded
  span counts `[since, until)`, an open span (`until: null`) has no upper
  bound, and no statement binds a parameter that is only compared with
  `NULL` (Postgres cannot type it).
- **`integration/store/identities.test.ts`** (11) — users: upsert from
  IdP creates then refreshes (email, last login), lookups; **a removed user
  stays removed**: `markRemoved` stamps `removed_at` and `sessions_ended_at`,
  a later login refreshes the email and does not bring them back,
  `reactivate` does (keeping `sessions_ended_at`) and answers `null` for a
  user who is active or unknown; `removeAllMemberships` takes a user out of
  every group at once, local and IdP-sourced, and says which; groups: `getOrCreate` idempotent, atomic membership
  replacement and `groupsOf`, single add/remove, FK rejection of a
  non-user member; `syncIdpMemberships` replaces the IdP memberships of a
  user and leaves local groups alone, skips and reports a name held by a
  local group, and is one transaction (a failure keeps the previous
  memberships and creates no group).
- **`integration/store/users-issuer.test.ts`** (14) — **users keyed by
  (issuer, subject)**, migration `0011` (ADR
  [[users-keyed-by-issuer-and-subject]]): the same subject at another
  issuer is another user and the first account is not refreshed by the
  second person's sign-in; a deactivated account of one issuer says nothing
  about the same subject elsewhere; the key is injective (an issuer holds
  no space); an issuer that is empty, holds a space or a newline, has no
  scheme or is a bare host is refused by `upsertFromIdp`, `getByIdentity`
  and `bindUnboundTo`, and so is an empty subject. **Accounts from before
  the migration**, on a database the previous image wrote: every row is
  kept with its subject, no issuer and the key `unbound <subject>`, what
  referenced the user still does (foreign keys checked); an unbound account
  matches no sign-in, and `unbound` is not an issuer. **Binding**
  (`bindUnboundTo`): all the unbound accounts at once, the deactivated one
  included, and only once — a later issuer finds nothing to take; a
  returning user finds their own account; an account that would collide
  with one already bound to that issuer is left unbound.
- **`integration/store/connections-shares.test.ts`** (13) — connection
  credential sealed with the connection id as associated data and
  unreadable under another id; ciphertext never on the record; group
  ownership, transfer, `unowned`, revocation; reconnection reactivates;
  list filters and `listOwnedBy`; resource sync by ref keeping ids and
  owner env labels. Shares: restriction stored as rows, **unknown or
  wildcard risk ids refused by the catalog check** (`*`, `github.*`,
  unknown, empty) and **by the schema `CHECK`** when bypassed, empty
  restriction allowed, active-for-targets listing and revocation.
- **`integration/store/missions.test.ts`** (18) — creation with
  connections and policy rows, resource selection per connection,
  inconsistent selections refused (`selected` without resources, `all`
  with resources, resource of another connection, no connection), policy
  validation (catalog, non-negative integer quota and rate, positive
  window, duplicates), atomic `replacePolicy`, status and expiry
  transitions. **Tokens, one holder each**: one active token per member, a
  member's rotation retiring their own token only (the other member's and
  the named one stay `active`); one token revoked on its own, idempotent,
  its name free again; a name identifying one active named token per
  mission; the schema's CHECKs (a second active token of one member, a
  member token without a holder or with a name, a named token without a
  name or with a holder, an unknown kind) and unique prefixes; **the columns
  of a token row: a hash, no secret**; `markTokenUsed` at most once per
  granularity. **Members**: added, listed, `listForMember` (never the
  creator's own missions), the creator refused as a row; removing a member
  revokes their token in the same step and only theirs, and adding them
  again leaves it revoked; **a token is inserted only for a mission that
  serves and a holder who is on it, checked in the insert**
  (`TokenNotIssuableError`: `holder-not-a-member` for a user never added,
  removed, deactivated or unknown; `name-taken`; `mission-not-active` for
  every holder of a revoked mission, the creator included; the creator
  needs no row); **adding a member revokes a working token of theirs that
  predates the membership** (`tokenRevoked`); `revokeMemberTokensOf` revokes a user's tokens on
  the missions they did not create and leaves their own missions' tokens.
- **`integration/store/token-holders.test.ts`** (4) — **migration `0010`** on
  a database an earlier image wrote: every token becomes a member token of
  its mission's creator with the same id, prefix, hash, status and dates; no
  member row is written; the audit entry written before keeps no holder; the
  "one active token per mission" index is gone and the four new ones exist.
  `holderColumns` (a call event's holder, nothing for a rotation, an unknown
  kind or an empty holder); the timeline of one holder by keyset and
  `tokenHolderActivity` (per holder and decision, the unattributed entry
  apart, an empty span); the audit search by holder (a kind and its holders,
  several members, never across kinds, an empty list matches nothing).
- **`integration/store/sessions.test.ts`** (11) — session born on first
  call and never recreated; **N=50 concurrent `decideAndDecrement` on
  quota 1 → exactly one allow**, 49 refusals, one counter at 1; a call
  touching N risks decrements N counters and a refusal none; new period
  starts at zero; a thrown decider rolls back the session creation;
  in-transaction approval consumption is single-use; request drop and
  extra events from inside the refusal transaction; a granted claim resets
  the counters of the period (through `decideClaim`) and `listEvents`
  since/limit; **structural check**: `session_counters`
  consumed == allowed audit touches after a mixed run.
- **`integration/store/requests-approvals.test.ts`** (14) — approval
  request arguments sealed with `request:<id>` as associated data and
  readable only through `getArguments`; approval requires tool and
  fingerprint; decision erases the blob and a second decision is refused;
  sweeper expires open requests and erases blobs; inbox lists only the
  creator's open requests. Approvals: single-use and bound to the exact
  risk, tool and fingerprint; **the same arguments on another tool touching
  the same risk do not consume it**; an approval without a tool is never
  written and a row older than migration 0005 is never matched; expiry; one
  approval per request.
- **`integration/store/delegations.test.ts`** (20) — public client with
  de-duplicated redirect URIs, consent listing, refresh-token rotation chain
  (`revoked_at`, `replaced_by_id`), access token found only while live and
  delegation active, delegation revocation cascades to tokens, mission
  issued by delegation records the delegation id (`issuersOf`);
  **`redeemCode`, the code grant as one transaction**: the code is spent and
  the first pair written, once; a refusal of the check spends the code and
  writes no token; a revoked delegation is refused after the check, the code
  spent; an unknown or an expired code changes nothing and the check is not
  asked; **a failed insert into `oauth_refresh_tokens` or
  `oauth_access_tokens` rolls everything back** — the code is unspent and no
  token exists; **a rotation writes the access token of the renewal in the
  same transaction** (`rotateRefreshToken`: both rows or neither;
  `rotateSuccessorOf`: both rows, or the head is left as it was);
  **`disableClient`**: the client is disabled and its active delegations
  revoked with their tokens, and only those; interrupted half-way, nothing
  is changed; **`rotateSuccessorOf`** (the reuse window): rotates the live
  head when the presented token is its immediate predecessor, rotated since
  the instant given; `null` when it was rotated earlier, when the successor
  is no longer the head, when the token was never rotated or is unknown,
  once the delegation is revoked or the head expired.
- **`integration/store/config.test.ts`** (7) — clear values overwrite,
  secrets sealed with `instance_config:<key>` and `key_version` stamped,
  a key is a value or a secret never both, delete; `apply` writes values,
  secrets and deletions together, all or nothing (a failing write leaves
  every key as it was), and is a no-op with no write.
- **`integration/store/web-sessions.test.ts`** (8) — `store.webSessions`,
  the one web session store: round trip, unknown id, TTL expiry and sweep
  on write, overwrite of value and expiry, non-positive TTL refused;
  **the row is keyed by the SHA-256 of the session id and the id itself is
  never written**; a row keyed by the id in clear (written before the
  digest) is not read; a value that is not JSON reads as no session and the
  row is removed.
- **`integration/store/corrupt-rows.test.ts`** (14) — **every enum column
  is validated on read; a corrupt row fails loudly**: an unknown
  `users.status`, `groups.source`, `shares.status`, `missions.status`,
  `mission_connections.resource_scope`, `mission_policy.gate`,
  `mission_tokens.status`, `requests.kind` / `state`, `delegations.status`
  or code challenge method, `audit.kind`, `act` or `object_type` is refused;
  an administrative entry the gateway wrote still reads; a corrupt request
  aborts a claim decision without writing anything.

> **Not covered here, by design.** The accounting rules (period
> arithmetic, quota/rate comparison, gate handling) are the budget's
> `decide` callback, tested in the section below against this primitive.
> The real `Encryptor` (XChaCha20-Poly1305, per-blob KDF,
> `apps/gateway/src/server/crypto/`) has its own suite; the store's stub
> only reproduces the port's associated-data and key-version contract.

## Scenarios — Budget and sessions

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §2.3
> (mission states), §3.2 (unit, quota, rate limit, one budget per
> mission), §3.3 (session, rollover on read), §3.5 (gate, fingerprint
> binding, single use, whole-call refusal, "the gate does not replace the
> budget"), §6 ("authoritative, atomic counting"), §10 "the budget" and
> the structural test "session counters agree with the audit". Handbook
> [[budget-and-sessions]]. ADR [[atomic-budget-accounting]]. The
> integration suites run on the `:memory:` store with the fixture of
> `apps/gateway/tests/integration/budget/fixture.ts` (one creator, one
> connection, a three-risk policy: `code-read` 10/period 5 per 60 s,
> `write-feature-branch` 1/period, `merge-protected` 2/period 1 per 60 s
> gated `approval`; daily period anchored 2026-10-13). Paths are relative
> to `apps/gateway/tests/`.

- **`unit/server/budget/period.test.ts`** (8) — `periodIndex` at the
  anchor, the last millisecond, the boundary (belongs to the next period),
  a week later, before the anchor (period 0); zero, negative, fractional
  length and malformed anchor refused; `currentPeriod` for a recurring
  mission (start = counters key, end = reload), a one-off mission (single
  open-ended period at the anchor, whatever `now`), an anchor spelled with
  an offset normalised to canonical ISO; `periodSpecOf` borrowing the
  stored anchor for a one-off `Period`.
- The fingerprint tests live with the function, in
  `packages/gateway-core/tests/unit/fingerprint.test.ts` (above).
- **`unit/server/budget/decide.test.ts`** (20) — **multi-risk decrement**
  (`[READ, WRITE, READ]` → decrements `[READ, WRITE]`, remaining per risk),
  a call touching no risk, remaining after prior consumption, a gated risk
  with an approval names it for consumption, an opened gate behaves as
  `auto`; `budget-exhausted` with `period_end` (and `null` for one-off),
  **whole-call refusal** when one of two risks is exhausted, `rate-limited`
  with `retry_after_seconds >= 1`, `approval-required` with the
  fingerprint, **multi-risk call refused as a whole** when one risk is
  gated, dimension-major order (quota beats gate, rate beats gate), an
  approval bypasses neither quota nor rate; a touched risk outside the
  policy is a `BudgetInvariantError`; inputs are not mutated.
- **`unit/server/budget/mission-state.test.ts`** (7) — stored
  `revoked` / `orphaned` / `expired` win; `expires_at` reached reads
  `expired` without a column flip; `active` with `exhausted` per risk and
  remaining for the current period; **rollover on read** (yesterday's
  exhaustion gone today); a one-off never reloads; remaining clamped at 0
  after a quota was lowered; `consumedInPeriod` sums one period only.
- **`unit/server/rate-limit/sliding-window.test.ts`** (8) — unknown key is
  empty; `peek` never records, `push` does, `retryAfterMs` is when the
  oldest action leaves; actions slide out one by one; keys independent;
  non-positive window refused; idle keys swept above the prune threshold;
  the composition root's `RateLimiter.take` (check and consume, credit back
  after the window); `rateWindowKey` by mission and risk.
- **`integration/budget/session-service.test.ts`** (20) — session born on
  the first call, N risks → N counters, `call-allowed` event with tool,
  risks, remaining; **a refused call decrements nothing**, drops exactly one
  claim in the creator's inbox with `claim_url = requestUrl(id)`, expiry
  `now + requests.expiry`, events `call-allowed, request, call-refused`; a
  replayed refusal reuses the open request, a decided one is replaced;
  whole-call refusal leaves the other counter untouched; **rollover on
  read** (next period starts at zero, both periods' rows kept); reload of
  an hourly mission by arithmetic, a one-off mission exhausted forever with
  `period_end: null`; **N=50 concurrent `recordCall` on quota 1 → exactly
  one allow, 49 `budget-exhausted`, counter 1, one claim**; **several agent
  labels share the counters**, labels only on events; `rate-limited`: no
  request, no decrement, `retry_after_seconds` from the oldest action, free
  again after the window; refusals on another risk record nothing in the
  window; approval gate: request holds tool, fingerprint and sealed
  arguments readable through `getArguments`, `approval_url` and
  `expires_at` match the request, a granted approval is consumed by the
  identical replay in another key order (counter and `approval_ids`), a
  second replay asks again with a new request, one byte changed asks
  again, an expired approval does not open the gate, a multi-risk call with
  one gated risk is refused whole, **approved actions count against the
  quota** (third merge is `budget-exhausted`, a claim not an approval
  request); a touched risk outside the policy aborts the transaction (no
  session); `stateOf` with rollover, expiry and stored statuses, reading
  the counters of the current period only however old the mission is.
- **`integration/budget/pipeline-consistency.test.ts`** (6) — the
  `BudgetStage` inside the real `CallPipeline` with `SqliteAuditWriter` and
  stub resource / risk / upstream stages: after a mixed run (allowed,
  allowed-then-upstream-failed, exhausted, approval-required, a concurrent
  burst of 8 with a window of 5, a later exhausted multi-risk call, one
  more allowed) **`SUM(session_counters) == COUNT(audit allowed)` per risk**
  via the reusable `countersAgreeWithAudit`; **an allowed call that fails
  upstream keeps its credit** (`decision: allowed`, `upstream_error`,
  next call `budget-exhausted`); a one-off mission's open-ended period
  (anchor read from the store); a mission with no session yet reports zero
  everywhere; **granted claims** (quota extension, period reset, then a
  refusal) lower the counters and the check still agrees because it adds
  back the credits their events record (`counted + credited == audited`),
  per period; a credit event whose details are malformed is skipped without
  throwing.

## Scenarios — Connections, resources, provider apps

> Covers: spec §0 (Connection, Resource), §2.3 connection states, §4.2
> Connections and Administration, §6 (encryption at rest, anti-replay and
> anti-redirect, per-user rate limit on connection flows), §7.2. Handbook
> [[connections]], ADR [[connect-driver-and-resource-curation]]. No test
> reaches a provider: outbound HTTP is `mockFetch`, which rejects any
> request no route covers; plugins are `fixturePlugin()` (one
> `CredentialSpec` per kind) except in `shipped-providers.test.ts`.

Unit, co-located under `apps/gateway/src/server/connections/` and
`apps/gateway/src/server/provider-apps/` (134):

- **`oauth2.test.ts`** (28) — authorization URL (code flow, state, S256
  challenge, RFC 7636 appendix B vector, resource indicator, extra
  parameters that cannot override the core ones, PKCE required when the
  spec says so); code exchange with `client_secret_basic` (form-encoded
  Basic), `client_secret_post`, public client; a PKCE exchange without a
  verifier refused before the provider is called; `resource` on the token
  request; `expires_in` and comma-delimited scopes; a rejected grant
  carries the provider's `error: description` and never the client
  secret; an error body under HTTP 200; 5xx / network / missing
  `access_token` are not rejections; refresh rotates the refresh token,
  keeps it when none is returned, is a rejection without one.
- **`service.test.ts`** (33) — the connect driver per credential kind:
  - `oauth2`: redirect URI on `public_url`, the verifier of the exchange
    matches the challenge of the redirect, the credential is stored and
    the plugin discovers with the fresh token and without the client
    secret; **a replayed callback is refused** (`state-invalid`, token
    endpoint called once); a state that is unknown, absent, **of another
    user**, or of another provider is refused; **a foreign return URL is
    refused at the start** (`https://evil…`, `//evil…`, `/\evil…`) and one
    inside `public_url` is honoured; `app-not-configured`; a provider
    denial consumes the state; a failed exchange shows the provider's
    wording; a failed first discovery keeps the connection; the per-user
    rate limit (10 per minute, other users unaffected, window reset);
  - `app-install`, installation binding: installation URL with
    the state; **an installation id in the authorizing user's list (on the
    second page) is accepted**, the code exchanged with the app's client
    and no `redirect_uri`, the list read with the user token and the
    declared headers, the plugin receives the private key but not the
    client secret, and the user token is in no connection, audit entry or
    plugin context; **an id not in the list is refused, nothing stored,
    discovery never called, `connection-refused` audited**; **a callback
    without `code` is refused** before any request (also with `?error=`);
    **a refused code exchange is refused** (GitHub's 200 +
    `bad_verification_code`) while a 503 is `provider-unreachable` and not
    audited; a denied list is refused, an unreadable one fails closed; a
    reconnection is verified and its refusal names the connection; replay,
    missing id ("awaiting approval"), malformed id and an installation the
    provider rejects store nothing;
  - `app-install` **without `userVerification`**: refused at start and
    absent from the picker by default; connects once the operator accepts
    unverified installations (`installation_verification: none`); refused
    and audited at the callback when the acceptance was withdrawn
    mid-flow;
  - `api-key`: field validation by label, secret never echoed; a rejected
    key stores nothing and shows the provider's error (the Resend
    "restricted to only send emails" case); an unreachable provider is
    reported as such; foreign-provider and ref-less resources ignored;
  - `ssh-key`: key pair generated, private key only in the sealed
    credential, public key on the view, discovery deferred then run by
    the owner;
  - ownership (owner only, strangers get `not-found` everywhere, members
    of an owner group are owners), the `experimental` flag on the picker
    and the view, reconnect in place (expired → active, same id;
    `provider-mismatch`; `connection-revoked`; **an `unowned` connection is
    not reconnected** until an owner is reassigned, spec §2.3), revoke
    (terminal, blob erased, idempotent, audited once);
  - resources: **owner label, display name, hidden flag and list settings
    survive a re-discovery** while provider facts are refreshed; a
    vanished resource is marked stale (first date kept) and cleared when
    it returns; a plugin-set environment is read-only and follows the
    plugin, an invalid plugin label is dropped; edits are validated
    before any write; a failed refresh changes nothing; a rejected
    credential that cannot be refreshed expires the connection.
- **`credentials.test.ts`** (15) — `resolve` hands the decrypted secret
  and an app config without the client secret; a token inside the 60 s
  skew is refreshed, the rotated refresh token is persisted (sealed again)
  and presented at the next refresh; **an `unowned` connection is served**
  (its missions keep running, spec §2.3; a forced refresh keeps it
  `unowned`, a rejected one still throws `UpstreamAuthError`) while an
  expired or revoked one is refused without decrypting anything;
  no expiry / no refresh token → used as is; concurrent refreshes run one
  grant; `invalid_grant` → `expired` + `UpstreamAuthError`; 503 → still
  `active`; missing app configuration → still `active`; api key and
  oauth2 without refresh token → `expired`; a revocation during the
  refresh is never undone; a plugin `refresh()` replaces the generic
  grant; a rejecting plugin refresh expires, any other failure does not.
- **`pending.test.ts`** (7) — state single use, bound to the user, burnt
  by a foreign attempt, malformed / unknown refused, TTL, two concurrent
  callbacks → exactly one; notices read once by their web session.
- **`input.test.ts`** (23) — field reading; `resolveReturnTo` (fifteen
  refused shapes: userinfo, port and scheme tricks, paths that normalise to
  `//host`, control characters and backslashes a browser strips or
  rewrites); names; environment labels; editable metadata keys; list
  parsing.
- **`mapping.test.ts`** (3) — the one connection summary: a record is
  `id`, `provider`, `display_name` and `status` and nothing else; a user
  owner is named by email and a group owner by its name; an owner that no
  longer exists gives a null name, the wording left to the caller.
- **`codec-and-keypair.test.ts`** (12) — the four `CredentialSecret` kinds
  round-trip, malformed stored text refused; the generated ed25519 key is
  parsed by `ssh2`, matches its public line and signs.
- **`install-verification.test.ts`** (5) — `verifyInstallation`
  alone: a bare list in one request with Basic client authentication, ids
  as numbers or strings; an absent id, a longer id with the same prefix and
  malformed items refused; a spec header cannot replace `Authorization`;
  the cap of 20 pages refuses; refusal versus unreachable for each failure,
  and no error message carries the user token or the client secret.
- **`shipped-providers.test.ts`** (7) — the plugins the image ships:
  registered once; every provider-app field is expressible in the mounted
  configuration; no shipped `app-install` plugin is unverifiable;
  redirect-flow providers are offered only once their app
  is configured, forms need nothing; a valid https redirect with state,
  PKCE, resource indicator and extra parameters for each.
- **`provider-apps/service.test.ts`** (15) — fields per credential kind
  (a verified `app-install` adds `client_id` / `client_secret`); one entry
  per plugin with its `installVerification`; a secret sealed under
  `instance_config:provider_apps.<id>.<field>` and never returned; blank
  keeps the stored secret; every problem at once; the client secret goes
  to the host only, for `oauth2` and for a verified `app-install` (which
  keeps its private key); accepting unverified installations is explicit,
  works for a file-sourced provider, is refused for a verifying or
  non-installing provider, and a stray flag never weakens a verification;
  missing fields named; **the mounted configuration wins** and makes the
  provider read-only; an incomplete file block is not completed from the
  store; clear; the fields of a provider are saved, and cleared, in one
  transaction (a failed write keeps the previous app whole).
- **`apps/gateway/tests/unit/server/connections/provider-app-handler.test.ts`**
  (4) — the provider-app handler when the audit fails: a saved provider app,
  or an acceptance of unverified installations, whose audit entry cannot be
  written stands and is logged at `error` (no error line when the audit
  works); a body that is not a form answers 400 on every form handler and
  writes nothing.

Integration:

- **`tests/integration/store/connections-shares.test.ts`** (two of its 13
  cases) —
  `syncDiscoveredResources` at the repository (merge rule, stale, plugin
  label that stops being set, name handed back to discovery) and the
  conditional transitions `refreshCredential` / `markExpired` /
  `reconnect` / `revoke` (a revoked connection is never brought back).
- **`tests/integration/connections/repository-status.test.ts`** (6) —
  connection statuses at the repository: **`revoked` is terminal** (no
  credential writer touches a revoked connection and nothing is written, no
  status writer moves it, revoking again stays idempotent and keeps the
  first date); **`unowned` keeps serving and cannot be reconnected** (a
  refreshed credential is persisted and the status left alone, a
  reconnection writes nothing, it can still be revoked).
- **`tests/integration/connections/reassign-and-settle.test.ts`** (5) —
  **the operator reassigns only what is ownerless at the write**: refused
  when a member joined the owner group of an expired connection meanwhile,
  and when the new owner group lost its last member meanwhile; the owner and
  the status read inside the write are the `before` of the entry;
  `ConnectionsRepo.assignOwnerlessTo` writes nothing on a connection that
  has an owner or is revoked. **The missions an act orphans are recorded
  whatever happens to the entry of the act**: a revocation whose own audit
  entry fails still writes `mission-orphaned`.
- **`tests/integration/connections/connect-flow.test.ts`** (6; the two
  `app-install` scenarios are the installation binding: a foreign installation id and a
  callback without code are refused through the handlers with a
  `connection-refused` audit row each, the rightful user connects, and
  **the user token, the authorization code, the client secret and the
  private key appear in no table and no log line**; a plugin without
  `userVerification` is refused until an operator — not a user, and not for
  a verifying provider — accepts unverified installations, audited) —
  `buildRoot` over the `:memory:` store with the **real encryptor**, a
  fixture registry and a mocked provider, driven through the HTTP
  handlers:
  1. the operator registers the provider app (403 for a non-operator, 401
     without a session, audit entry without the secret) → the user starts
     the flow → the callback arrives on the internal host and lands on
     `/accounts/<id>?notice=<id>` (no message in the URL; the notice
     is read once) → **the credential blob and a dump of every table
     contain neither the access token, the refresh token nor the client
     secret**, and the blob does not open under another connection id →
     resources discovered → an owner edit survives a refresh that renames
     one resource upstream and drops another (marked stale) → the
     replayed callback is refused → a stranger and a cross-origin request
     cannot revoke → revoke: `revoked`, blob NULL, resources kept, audit
     `config-changed` / `connection-created` / `connection-revoked`;
  2. an API key and an SSH private key are absent from the dump; a
     plugin-set label is marked and its edit refused;
  3. guards: no session, no origin, bootstrap operator on a user endpoint,
     callback without a session → `/login`, unconfigured app, foreign
     `return_to`, unknown provider, a notice unreadable from another
     session;
  4. an unknown provider is reported as unknown, and a failure to read the
     app settings as a failure.

Not covered here: the pages themselves (server components; walked by hand,
see [`e2e-tests.md`](./e2e-tests.md)), and a real provider.
`connection-unavailable` for a mission on an expired connection and
`mission-inactive` for one on a revoked connection are in "Scenarios —
Execution door".

## Scenarios — Missions

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §3.1
> (monotonicity, enumeration, partition per connection, resource selection),
> §3.2 (mandatory budget, presets per plugin), §4.2 "Missions", §4.4, §7.4,
> §7.8, §10 ("authority" structural tests). Handbook [[missions]].

Unit, co-located (129 with the authority suite):

- **`src/server/authority/authority-service.test.ts`** (20) — see
  [Authority, shares, groups](#scenarios--authority-shares-groups).
  `uncoveredRisks` ("asked minus held") and `explicitRiskIdsOf`, the one
  enumeration of a catalog (`authority/catalog-authority.ts`), are tested
  there.
- **`src/server/missions/preview.test.ts`** (44) — **monotonicity**: accepted ⊄
  authority → `exceeds-authority` with the uncovered list, the covered part
  still shown; wildcard, sentinel, foreign and out-of-env ids → `unknown-risk`;
  unknown and unauthorised connections answer alike; inactive connection.
  **Partition per connection**: each partition against its own authority; a
  risk filed under the wrong connection; one flat policy; the same connection
  twice; two connections of one provider; connection by provider, ambiguous
  provider. **Resource selection**: `all` → the explicit list; by id or by ref;
  a foreign resource; an empty selection; hidden and stale left out of `all`; a
  hidden one selectable, a stale one refused and unable to resolve an env; a
  connection with no resource. **Env-qualified ids**: pass with a labelled
  resource, shown and refused without, no label needed when the plugin derives
  the env. **Mandatory budget**: no budget, half a budget, zero / negative /
  fractional / infinite values, the catalog's rate ceiling. **Presets**:
  application as an explicit enumeration; intersection with the authority and
  with the selection, reported in `skipped_from_preset`; a base id expanded per
  selected env and never persisted; per-risk override inheriting what it omits;
  exactly the explicit entries; no budget for a risk the preset lacks; unknown
  preset, repeated risk, connection accepting nothing. Name, period, expiry;
  every problem reported in one pass. **Notices, never blocking**: the
  selected resources that carry no environment label are named with what it
  costs (env-scoped risks refused at call time), and so is a resource
  labelled with an environment no risk of the catalog is acceptable in;
  nothing is said when every resource is labelled, when the plugin derives
  the environment or when the catalog has no env-scoped risk; a draft with a
  notice and no issue is issuable.
- **`catalog-view.test.ts`** (21) — explicit enumeration equal to the owner
  authority, and built on it (an entry the authority cannot enumerate has no
  row); base id, env, fallback, deprecated, rate ceiling; per-env vector;
  `SEVERITY_RANKS` equal to `RISK_VECTOR_AXES`; score bounds and levels;
  `isResolvable`; `presetWidth` and its one-liner; **explaining a risk**: the
  vector resolved per environment on each row, `VECTOR_AXES` in the order of
  the shared vocabulary and a short name per axis for the compact strip, a
  note printed without its lead where the lead is already the title,
  `vectorBadges` (text and weight per axis),
  `riskKindOf` (read by the patterns, destructive by the vector),
  `groupVariants` (one variant per environment), `groupByKind` (reads, writes,
  irreversible writes; every row in one group), `formatRate`.
- **`src/server/providers/reference.test.ts`** (20) — the provider reference.
  Links: a risk id, qualified or not, points at its catalog entry; provider,
  preset and section paths. `describePattern`: action and path in words, the
  catch-all write named, an unparseable pattern left as written.
  `dataModelTrees`: nesting, the carrier of the environment.
  `presetReferenceOf`: lines split by gate with their budget, base id expanded
  to every environment, what is left out. **Over the ten shipped plugins**: one
  card per plugin of the registry, experimental ones last; every plugin has a
  `summary`; every catalog entry listed exactly once under a unique anchor,
  with a label, a reason and patterns that read as words, exactly one fallback;
  reads first, and a read has only read patterns; every preset expands to
  explicit catalog ids with a budget, never the fallback, and `lines + not
included` equals the catalog; where the environment comes from (Vercel: the
  call; Supabase: the resource label; GitHub and Cloudflare DNS: none); a
  tool's required and optional arguments; **the tool and the two risks that
  hand a token to the agent are marked on GitHub, from the plugin's
  declaration, and nowhere else**; a card says the planes of the model and
  the environments of the catalog; each risk names the presets that include
  it and the tools declared for it; `null` for an unknown provider.
  `riskExplainer`: the row of an explicit id, `null` for an id no catalog
  declares.
- **`src/server/providers/planes.test.ts`** (9) — the plane of a risk and of a
  tool on the provider reference: a pattern is filed under the plane of its
  first entity that one plane alone declares; every plane the patterns reach,
  in the order of the model; `other` for a pattern or a tool name that names
  no entity of a single plane, or two planes at the same length — never a
  guess. **Over the shipped plugins**: a plane control only for a model with
  several planes; every Supabase risk under a plane and the two catch-alls
  under `other`; the per-plane counts of risks and tools.
- **`summary.test.ts`** (8) — the three lines (can / cannot / quantities) for a
  recurring and a one-off mission, the empty form, label truncation, period and
  expiry phrases.
- **`bootstrap-kit.test.ts`** (16) — the secret only in the env snippet; MCP
  configuration with the instance URL and `${VAUBAAN_MISSION_TOKEN}`; the agent
  block, in the interface's words around the protocol's names (accounts,
  refs, permissions with their limits, "runs freely" / "asks the mission
  creator first"); **sub-agents and agent labels**
  (the same configuration and key, never one per agent; both carriers and
  which one wins; the shape printed from the constants the door checks;
  "attribution only", "not an identity"), in the kit and in
  `/agent-bootstrap.md`; one line per refusal code and "never
  work around" (`mission-inactive` says that a request opened before the
  mission lost its owner can be answered only until it expires); the
  `curl … tools/list` check; masked prefix on a revisited
  page; sub-path of the public URL; `/agent-bootstrap.md` documents every
  refusal code and names no instance.
- **`token.test.ts`** (10) — `vbn_live_<8>_<32>`, SHA-256 digest, clear
  prefix; verification against the digest and nothing else; a hash an
  earlier build stored as argon2id still verifies; a hash is never read
  under the wrong algorithm nor under an unknown one; uniqueness; prefix of
  a live token only; the draft schema
  (unknown keys refused, every malformed field named).
- **`src/app/(app)/missions/new/form-state.test.ts`** (40) — initial state
  (nothing included, hidden and stale resources unticked, daily period, no
  expiry); a preset fills the policy and the draft sent is the explicit
  enumeration; the untouched preset follows the resource selection and says
  what it left out; edited entries are kept and flagged; base-id expansion;
  per-risk override; the default budget of a hand-ticked risk (chosen preset,
  another preset, none → issuance blocked); **"select all" → an enumerated list**
  inside the authority and the selection, without the fallback and deprecated
  entries; period and expiry mapping; loading a resolved draft. **A preset
  explains itself** (`explainPreset`): what passes, what waits for an approval
  and what is left out with each budget; equal to the entries `applyPreset`
  fills, for every preset; entries a selection cannot resolve named with the
  label a resource would need; entries outside the authority; `presetWidth`
  and `policyCounts` (the fallback and a deprecated entry are never counted as
  "not included"). **A preset that would allow nothing says why**
  (`presetUnavailable`: the label a resource would need and "none selected",
  or "outside what you may allow"). **Custom, start empty** (`startEmpty`).
  **What stands in the way, in the interface's words** (`issueSentence`: the
  account named, no protocol word in a sentence; the server's message when
  the page has no sentence of its own). **Preset or Custom**: `enterCustom` keeps the
  preset's values and loses nothing; `discardsEdits` only after an edit, and
  `backToPreset` restores the preset; `startFromPreset`; **the draft sent is the
  same in both modes and names neither the preset nor the mode**; a loaded
  draft is a custom policy. **The Custom editor**: `editorRows` lists every
  explicit id with why one cannot be ticked; `filterRows` by words and by
  status ("Available to you" is what may be ticked and what is ticked).
- **`src/app/(app)/missions/mission-view.test.ts`** (15) — what the mission
  pages say: **the state of a mission in words** (a running mission is
  written plainly; a waiting request wins over a reached limit and is amber,
  with whose answer it waits for on a teammate's page; "Needs an owner" and
  "Limit reached" are red; expired and stopped carry no colour and are "over");
  **Can / Asks first / Cannot** from the explicit list (how many permissions
  each line stands for, the rest counted, the asking line left out when nothing
  asks, a label named without its parenthesis); **the one limit that matters**
  (the closest once one is at 60 %, nothing otherwise or without a period);
  per-minute from any stored window; who created it and whose yes it waits for.
- **`src/app/(app)/missions/[id]/session/event-words.test.ts`** (8) — what a
  row of a mission's activity says of an event: allowed, and "after the
  creator's yes"; a refusal is red with its code in mono, except
  `approval-required`, which is amber ("asked first"), and `budget-exhausted`
  ("limit reached"); a request is amber only while it waits; a gate in the
  interface's words, never `auto` or `approval`; what an answer gave (a yes, a
  reset, a raised limit, more time); a key by its masked form, replaced or
  first; one key revoked or the mission stopped; a later version's kind
  printed as stored.
- **`src/app/(app)/missions/message-of.test.ts`** (2) — `messageOf`, what
  the client components of the mission pages show when the mission API
  refuses: the message of a JSON refusal, and a sentence naming the status
  when the body states nothing usable.

Integration, `:memory:` store, the real root with the shipped plugins,
connections and resources seeded through the repositories (36):

- **`tests/integration/missions/mission-lifecycle.test.ts`** (33) — **issue →
  the token verifies → rotate → the old token is `retired/rotated` → revoke →
  `retired/revoked` and gateway-core's `checkMissionActive` answers
  `mission-inactive`**; malformed bearer, unknown prefix and wrong secret answer
  alike; the mission persists explicit resource ids and policy lines, no preset
  reference; a resource discovered later is not covered; `all` without hidden
  and stale resources, a hidden one when ticked, a stale one refused; the hash
  and prefix are stored, the secret is in neither the table nor the audit;
  a refused draft writes nothing; no authority → `connection-unknown`; an
  owner-group member issues until they leave the group; a three-connection
  mission with one partition each (Vercel's env-qualified risks need no label);
  env-qualified entries refused or skipped from a preset; duplicate (same
  policy, own token, no expiry, stale resources dropped) re-checked against
  the current authority; rotate / revoke creator-only, idempotent revoke,
  no rotation of a revoked or expired mission; `rotation` / `revocation`
  session events and audit acts; list and detail (state, labels, remaining,
  masked kit); past expiry refused; one-off mission; a taken token prefix is
  re-drawn; the issuance context (experimental, `derives_env`, presets,
  authority); revoked connections left out, expired ones unusable; **every
  preset of every shipped plugin previews cleanly** for an owner whose
  resources carry every env label, never with the fallback. **The detail
  page and the kit list what the door reaches**: nothing on a connection
  that had no resource at issuance, even once discovery finds some; no
  hidden resource for a mission issued on "all" when every resource is
  hidden; a resource turned stale dropped from both; the creator is told
  when a selected resource carries no environment label on an env-scoped
  catalog.
- **`tests/integration/missions/mission-handlers.test.ts`** (8) — 201 with the
  secret once, the kit and `no-store`; cross-origin refused on all four routes
  before the session is read; 401 without a session, 403 for the bootstrap
  operator; 400 with the fields named; 422 with the preview; preview of an
  agent's proposal (provider and refs resolved, nothing written); rotate
  200 / 404 / 409; revoke 404 for someone else's mission.

### Mission members and per-holder tokens

> Covers: spec §0 "Mission member", "Mission token"; §3.2 "one budget per
> mission, however many agents or tokens"; §7.9 bis; §8 "the token used and
> its holder"; §11.2 "Members and authority", "What a member sees". ADR
> [[mission-members-and-per-holder-tokens]]. Handbooks [[missions]] ("Members
> and tokens"), [[execution-door]] ("Token holders"), [[audit]], [[store]].

- **`src/server/missions/token-name.test.ts`** (23) — the name of a named
  token: what is taken (trimmed, inner spaces collapsed, the maximum length),
  what is refused with the rule stated (empty, too long, leading punctuation,
  an email, a slash, a colon, a line break, markup, non-ASCII, anything that
  is not text), and never a name with an `@`.
- **`tests/integration/missions/team.test.ts`** (28) — on the real root:
  - **members**: the creator is a member by construction; adding a user makes
    the mission appear in their list as `member` with the creator's email;
    candidates are the active users not on the mission, for the creator only;
    only an active user is added, once, and not to a revoked mission; **a
    member needs no authority of their own** and the mission is orphaned for
    every holder when the creator's authority goes; removing a member revokes
    their token, takes the mission away from them and leaves the others, with
    the entry carrying the member and the revoked prefix; a member added again
    starts with no token;
  - **tokens**: a member generates their own (shown once with the kit, the
    page afterwards has the prefix only) and rotating retires theirs alone;
    the creator's rotation leaves every other holder working; a named token
    (name normalised, one working token per name, every bad name refused, the
    name free again once revoked); one token revoked on its own by its holder
    or by the creator, idempotent, with `by-holder` / `by-creator` in the
    audit; revoking the mission revokes every token; a session event for each
    token issued or revoked; **a creator who revoked their own token is issued
    one under the same act by either way** (`mission-token-issued` through
    "Rotate token" of the mission header and through "Rotate my token" of the
    team section: nothing is replaced, so it is an issue, not a rotation);
  - **a member uses the mission as it is**: reads it with nothing editable;
    cannot edit a gate, rotate the creator's token, revoke or duplicate the
    mission, add or remove a member, create a named token (each `not-found`,
    the store and the audit compared before and after); cannot take it as a
    draft nor revoke a token that is not theirs, nor one of another mission;
    **cannot see or answer its requests** (inbox, count, view, `decide`,
    `decideClaim`), which the creator then answers;
  - **the secret of a member token belongs to the member alone**: everything
    the creator can read (detail, list, team, session, audit search) and every
    column of every table hold the prefix and never the secret, and the row
    is a SHA-256 digest; over HTTP the secret is in the answer to the member
    and in no answer to the creator's own mutations;
  - **handlers**: each refusal with its status and a sentence; no session,
    another origin.
- **`tests/integration/execution/team-door.test.ts`** (11) — over HTTP at the
  door: **two members and a named token share one counter and are attributed
  separately** (five calls by three holders spend the five credits, the sixth
  is `budget-exhausted` for each; `token_kind` / `token_holder` / `token_id`
  on every entry, refused ones included; the session's per-holder table and
  the timeline of one holder; the audit search by email, by name and by the
  exact form); the holder is the token's whatever headers or `_meta` the
  caller sends; the catalog names the holder and the creator and carries no
  secret; last used per token; **a removed member is refused** at the next
  call with a warm cache (401 `holder-removed`, nothing counted, no call
  entry), by the membership row alone, and added again needs a new token; **a
  deactivated member is refused at once** (401 `holder-deactivated`, the
  revocation audited in the operator's name), by the user row alone, and
  generates a new token once reactivated; rotated vs revoked, each with its
  reason, the others served; a revoked mission is `mission-inactive` for its
  holders and tells a removed member nothing; a deactivated creator orphans
  every holder and reactivation restores every token.
- **`src/server/store/membership.test.ts`** (12) — **the one rule of who is on
  a mission** (`membershipOf`, ADR
  [[one-membership-rule-checked-in-the-token-insert]] D1), as a table: the
  creator is `creator` whatever their own status or a stray member row; an
  active user is `member` with a current row, `removed` once the row is
  removed, `none` without one; a deactivated or unknown user with a row is
  `deactivated` — told before removal — and `none` without one; only the
  creator and a current member are on the mission (`isOnMission` over
  `MEMBERSHIPS`).
- **`tests/integration/missions/team-interleaving.test.ts`** (6) — **a token
  insert that lost the race is refused** (same ADR, D2). The competing act
  runs inside the minter, exactly between the service's check and the
  insert: a member removed while the hash was computed gets no token, and
  none appears when they are added back; removed while rotating, the old
  token is revoked by the removal (`holder-removed`, then `revoked` once
  added again) and the new one is not inserted; deactivated meanwhile, no
  token, none on reactivation, and a new one generated the ordinary way;
  the mission revoked meanwhile answers `inactive` / `revoked` for a member
  token and a named one, with no active token left; two creations of one
  name at once give one token and `name-taken`; with nothing in between the
  token is issued as before.
- **`tests/integration/store/token-holders.test.ts`** (4) and
  **`store/missions.test.ts`** — migration `0010` and the repository (the
  check inside the insert, the stale token revoked when a member is added):
  see "Scenarios — Store".
- **`src/server/execution/execution.test.ts`** — the token verifier remembers
  nothing: every call asks the mission service, so a removed or deactivated
  holder is refused on the next one.
- **`tests/unit/structural/telemetry-report-shape.test.ts`** — the calls of
  the property are made with three holders, and the member's id, subject and
  email, the token name, every token id, prefix and secret are among what must
  never reach the collector.
- Elsewhere: `audit/mission-session.test.ts` (a member reads the whole
  session, with no link to answer a request), `audit/audit-query.test.ts` (the
  holder filter), `management/management-door.test.ts` and
  `server/management/tools.test.ts` (a member's mission is listed, marked, and
  changed by no tool), `oauth-as/credential-separation.test.ts` (a member's
  and a named token open the execution door only),
  `audit/admin-mutations.test.ts` and `unit/server/auth/mutation-guard.test.ts`
  (the six service mutations audited, the five routes guarded).

Not covered here: the browser (Playwright, see
[`e2e-tests.md`](./e2e-tests.md)); calls through the execution door with an
issued token are in "Scenarios — Execution door".

## Scenarios — Execution door

> Covers: handbook [[execution-door]]. Spec: `vaubaan-gateway.md` §4.1
> (discovery, call, the eight refusals, catalog, streaming), §2.4, §3.1
> (resource selection), §3.2 and §7.9 (one budget per mission, however many
> agents; the agent label), §3.3 and §10 (counters agree with the audit), §6
> (three credentials, surface rate limit, no secret in logs), §8.

Ephemeral instance: the real composition root on the `:memory:` store
(`executionInstance()` in `src/server/execution/testing.ts`), a scripted
fixture plugin `depot` (a resource ref the classifier requires, an
account-level tool, an env-scoped risk, a risk to gate, an `execute` and a
`refresh` the test scripts), missions issued through `MissionService.issue`,
calls sent as JSON-RPC to `root.execution.handlers.mcp`.

- **`src/server/execution/execution.test.ts`** (21) — agent label (header,
  `_meta.agent` wins; the accepted shape up to 64 characters, trimmed;
  absent, empty and blank hold nothing; too long, a character outside the
  list, a non-string are **rejected with their reason, never repaired**; the
  carrier read and what was dropped on the way, the header not examined once
  `_meta.agent` gave the label); client address (ignored
  without `trusted_proxies`, right-most untrusted hop, CIDR, IPv6, malformed
  chain, a hop with a port or in brackets, an invalid `trusted_proxies`
  entry skipped — the one rule of `http/client-ip`); `citedRefs` over
  identifier and list segments; tool filter (needs a connection **and** an
  accepted risk, nothing of an experimental plugin); token verifier (nothing
  remembered: the state is read again on every call; a token stored as a
  SHA-256 digest is never throttled, however many wrong secrets are
  replayed; the argon2id check of a legacy token is **throttled per prefix
  and client address** — a flood of wrong secrets locks out only its sender
  —, a non-token bearer costs nothing); upstream
  credential cache (scoped per connection, dropped on demand, unreachable
  after the connection row changed, lifetime capped).
- **`integration/execution/pipeline.test.ts`** (24)
  - _allowed call_: forwarded to the plugin, the touched risk decremented,
    one audit entry with connection, resource ref, canonical
    `arguments_hash`, `remaining_budget`; the decrypted credential reaches
    the plugin and never the response; an env-qualified risk matches through
    the label of the resource touched, and the same tool on another resource
    is `risk-not-accepted`; the agent label from the header and from
    `_meta.agent`, both spending one budget.
  - _every refusal code with its fields and a hint_: `risk-not-accepted`
    (`missing_risks`, `executed_slices`; nothing counted, no session born),
    `budget-exhausted` (`risk_id`, `quota`, `consumed`, `period_end`,
    `claim_url` under the public URL), `approval-required` (`risk_id`,
    `fingerprint` equal to the audit hash, `approval_url`, `expires_at`),
    `resource-not-in-mission` (`cited_ref`, `connection`,
    `allowed_resources`; before any risk — the entry has no slice),
    `rate-limited` (`risk_id`, `limit`, `retry_after_seconds`; quota intact),
    `connection-unavailable` (expired connection, its name, the owner's
    email), `mission-inactive` (a revoked connection orphans the missions
    that carry it, as a derived state — the `missions` row stays `active`;
    a revoked mission, an expired one; also on `tools/list`).
  - _resource selection_: a selected resource gone stale is refused naming
    it while a hidden one still works; a mission stored `all` with an empty
    list covers nothing, including a resource discovered later, and still
    calls an account-level tool.
  - _structural rejections_ (`-32602`, audit `refused` with no code):
    unknown tool, a provider the mission has no connection for, unplaceable
    arguments. **A classifier that throws** (invariant
    `every-refused-call-audited`): the call is refused with "the risk stage
    failed (TypeError)" and nothing reaches the plugin; **one audit entry**
    (`refused`, no code, the tool, the argument hash, the token holder, the
    connection, no risk, no remaining budget); nothing is counted — the
    next good call still has the whole quota; one `error` log line
    ("call refused: a decision stage failed") with the stage, the tool, the
    error class and stack frames; and the text the error quoted is in
    neither the answer, the audit nor the log.
  - _upstream_: a provider failure is a tool error and the call stays
    allowed and counted; 401 → refresh → retry with the new credential; 401
    and a rejected refresh → connection `expired`, the agent reads
    `connection-unavailable`, the entry stays `allowed` with
    `upstream_error`, the next call is refused before the budget; 403 → no
    refresh, no expiry; a derived credential served from the cache, dropped
    and re-derived on 401; **the provider's text stays out of the audit**
    (a host-built summary there, the detail to the calling agent; for an
    HTTP error the status is named and nothing of its message).
- **`integration/execution/door-http.test.ts`** (23) — the real GitHub
  plugin on a mocked upstream (`mockFetch`: installation-token mint, branch
  list), driven by the official MCP client (`@modelcontextprotocol/client`)
  whose HTTP goes to the handler:
  - a 2025-era client and a 2026-07-28 client both connect, list the tools
    and call `github__list_branches`; the gateway mints a repository-scoped
    installation token, uses it upstream, and nothing of it reaches the
    client; the installation token is minted once for three calls;
  - the client receives the whole refusal in the JSON-RPC error `data`
    (`resource-not-in-mission`, `risk-not-accepted`), and nothing reaches
    GitHub;
  - the kit's bare `tools/list` gets plain JSON; `GET` / `DELETE` are 405;
  - `tools/list` per provider; `GET /mcp/catalog` (surface, callable set,
    resources with env labels, consumed / remaining per risk), 401 without a
    token, 403 `mission-inactive` for a revoked mission;
  - **credential separation**: no bearer, garbage, unknown prefix, wrong
    secret and a rotated token are all 401; a web session as cookie or as
    bearer and a delegated token (injected resolver) are 403
    `wrong-credential-kind` naming door, presented and expected; a foreign
    `Origin` is 403;
  - **token verification** (ADR [[mission-token-sha256-digest]]): the row
    holds the SHA-256 digest of the Bearer; a revocation is seen on the next
    call; wrong secrets on a real prefix are each 401, never 429, and the
    agent is never held, proxy or not; the surface limit is per mission,
    whatever the agent label, with `Retry-After`;
  - **a token an earlier build stored as argon2id**: the same Bearer still
    authenticates and its first call replaces the stored hash by the digest
    (same row, same prefix, still active); a wrong secret moves nothing; a
    legacy token of a revoked mission is refused by its reason; wrong secrets
    on a legacy prefix end in 429 for their sender while the agent, from
    another address, passes — after which the flood is answered 401 again;
  - **the accepted 429, legacy tokens only** (ADR
    [[execution-door-json-faithful-arguments-and-shared-throttle]]): with no
    trusted proxy, thirty wrong secrets on a legacy prefix are each 401, and
    the real token, never used since the upgrade, is then answered 429 with
    `Retry-After`; nothing was learnt or changed — the mission, its token and
    its stored hash stand;
  - **arguments JSON cannot carry**: a `tools/call` whose body carries
    `"per_page":1e999` is answered `-32602` naming `argument 'per_page' is
Infinity`; nothing reaches GitHub, and the audit entry is `refused` with
    no refusal code;
  - **no secret in logs**: the token secret, the installation token, the
    App key, the client secret and the arguments never appear; the prefix
    and a 64-hex `arguments_hash` do.
- **`integration/execution/agent-label.test.ts`** (6) — **the label has no
  effect on authorization or budget**, over the door's HTTP handler:
  - **two labels and no label share one counter**: three calls on a quota of
    three under `planner`, `coder` and no label; the fourth is
    `budget-exhausted` whoever asks, including a label that never called;
    one session, one counter row; the labels are on the audit entries and
    the `call-allowed` events only;
  - **the same decision with any label, with none, and with a forged one**
    (the creator's email, another mission's id, `admin`): the accepted tool
    is allowed and the unaccepted one refused `risk-not-accepted` each time,
    the entries differ by the label alone, the mission the forged label
    named is untouched;
  - **a value that is not a label is dropped, logged, and the call served**:
    too long, a space, markup, an object, a number → no error, the entry has
    no label, the counter moves, one `agent label dropped` line each with
    carrier, reason and length, and **the value itself in no log line**;
  - `_meta.agent` wins over the header; a rejected or blank `_meta.agent`
    falls back to the header; the header is trimmed;
  - the official MCP client in both protocol eras labels a connection by
    header and one call by `_meta`, the three calls drawing from one quota.
- **`integration/execution/streaming.test.ts`** (13) — **streaming, spec
  §4.1 "the decision is made before the stream starts"**; a scripted plugin
  emits the parts of its result through the SDK's `streamToolResult`:
  - **a part reaches the caller while the plugin is still blocked on its
    provider**, as `notifications/progress` on an SSE answer; at that moment
    **the counter is already incremented and the `call-allowed` event
    written**, and the audit entry is not written yet; when the stream ends
    the entry is `allowed` with an `upstream_latency_ms` that covers the
    whole stream;
  - the official MCP client in both protocol eras receives the parts through
    `onprogress` (the first one before the provider delivers the second),
    then the complete result;
  - a provider's chunked response body forwarded chunk by chunk
    (`textParts`); a caller without a progress token gets one JSON body with
    the same result;
  - **a refused call** (risk not accepted; budget exhausted) **is answered by
    its error alone**, no progress frame, no plugin call, nothing counted;
  - **a stream that breaks midway**: the parts already sent, then `isError`
    naming how many; the entry `allowed` with `upstream_error: 'depot stream
failed after 2 parts (Error)'` — not the provider's sentence — the credit
    consumed, one execution;
  - a 401 after a first part is **not** retried and leaves the connection
    `active`; a 401 before any part still is;
  - **the caller goes away**: the stream stops at the next part and the
    entry says `stream stopped after 1 part: the caller was gone`;
  - **streaming and community telemetry (spec §9)**: nothing is reported
    for a call its caller abandoned — the audit entry still says what
    happened —, nor when the plugin fails after the caller left (that is
    not a timeout of the provider); a provider that breaks the stream of a
    caller that is still there is reported once, as an upstream error.
- **`integration/execution/counters-vs-audit.test.ts`** (4) — **structural,
  spec §10**: 240 calls per seed (three seeds; allowed, refused on every
  dimension, rejected, failing upstream, a 401 repaired by a refresh, bursts
  of up to six concurrent calls from three agent labels) through the door,
  then `countersAgreeWithAudit` reports no mismatch for every accepted risk,
  one audit entry per call, no quota overrun, and the last `remaining_budget`
  equals quota minus counter; a burst of 30 on a quota of 7 → exactly 7
  allowed, 23 `budget-exhausted`.
- **`plugins/github/tests/unit/token-cache.test.ts`** (5) — no cache → a mint
  per call; one mint per repository scope; never served or stored close to
  expiry; lifetime bounded by what is left; `github__mint_install_token`
  never cached.

## Scenarios — Authority, shares, groups

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §0 (Group,
> Principal, Share, Restriction), §2.3 (`unowned`, share states, `orphaned`),
> §3.1 (monotonicity, enumeration, union of shares, partition per
> connection), §4.2 (Connections, Shares received, Administration), §7.2,
> §7.3, §7.8, §10 (structural: authority never from a snapshot), §11.2 (v1
> assumptions). Handbook [[authority]]. ADR
> [[orphaned-missions-and-ownerless-connections]].

Unit, beside the code (102):

- **`src/server/authority/authority-service.test.ts`** (20) — **owner**: the
  full catalog as an explicit enumeration, nobody else anything, every
  current member of an owner group, no plugin no authority, a removed or
  unknown user holds nothing even on their own connection. **Union of
  shares**: exactly the restriction in catalog order; a direct share plus the
  shares of the user's groups, a group they are not in adding nothing; shares
  of two connections kept apart (**subset per connection**); a revoked share
  gone from the next answer; recomputed around two membership changes on one
  instance; the owner unaffected by shares; `connectionsOf` = owned ∪
  received, once each. **`gapsOf`** (the re-check): no gap for the owner and
  **no read of groups or shares for a user-owned connection**; groups read
  once for several group-owned connections; the uncovered ids per connection
  with the basis left (`share` or `none`); nothing asked where nothing was
  accepted; a removed user; a membership change seen on the next check.
- **`src/server/authority/mission-grounds.test.ts`** (27) — **the `orphaned`
  derivation**: grounded for the owner and for a covered beneficiary;
  `authority-lost` naming the connection and the uncovered risks (share
  narrowed; creator dropped from the owner group); `connection-revoked` even
  for the owner; **an expired or unowned connection does not orphan**;
  `creator-removed`; `connection-missing` when a connection of the mission
  is no longer in the store; each connection checked against its own partition
  (`partitionOf`), a share of one connection never covering another.
  `inspect` / `derive`: grounded untouched with no reason;
  ungrounded → the mission **read** `orphaned` with the reason, **the stored
  row unchanged and no admin entry**; **reversible** — the same mission reads
  `active` once the share is back; a revoked connection stays orphaned
  whatever is shared afterwards; a `revoked` or `expired` mission is never
  checked. `derivedMissionReads`: a creator's listing carries the status of
  the instant. Watches: `watchConnection` … `settle(actor)` writes
  `mission-orphaned` for the missions the act left ungrounded (actor, cause,
  connection, uncovered ids) and **`mission-restored`** for the ones it
  grounded again (`before` carries the cause they were orphaned for);
  nothing when no verdict changed or changed back; a mission revoked during
  the act, or not active before it, is left out; `watchCreator` follows one
  user's missions in both directions. `MembershipSettler.watch`: the emptied
  owner group's connection `unowned`, the member's mission orphaned; a
  regained membership restores; nothing while the group keeps another member.
  **Two acts under way at once — one change, one entry**: two watches taken
  before two acts record one `mission-orphaned`, naming the act that settled
  first, and one `mission-restored`; an equal entry older than the watch
  does not hold a new change back; and the mirror case writes nothing — a
  change undone before the settlement leaves no entry of this act.
- **`src/server/missions/orphan-reason.test.ts`** (4) — what the mission page
  says for each cause, under "Needs an owner: …": a lost authority names the
  account and the permissions (their ids), says it can serve again and that
  its activity and what it counted are kept; a disconnected account "never
  comes back"; a long list of ids is cut; an unknown account does not break
  the sentence.
- **`src/server/shares/restriction.test.ts`** (8) — groups by severity, most
  severe first, every row in one group; **"select all" is an enumerated
  list** (explicit ids, no wildcard, no fallback, no deprecated entry); the
  one-line summary; environment notes (none without env-qualified risks, when
  the plugin derives the env, or when every resource is labelled; the
  environment no resource carries; the count of unlabelled resources).
- **`src/server/shares/service.test.ts`** (24) — one row per risk, catalog
  order, duplicates folded, `share-created` entry; target found whatever the
  case of the email; share to a group reaching a member who joins later;
  **refused and nothing stored** for a wildcard, a provider wildcard, the
  base id of an env-scoped entry, an env the entry is not acceptable in, a
  risk of another provider, a preset name; empty restriction refused; unknown
  target, empty email, unknown group, the owner itself; a removed user, an
  email two users carry; **replacement** (one active share per target, both
  acts audited, the new restriction only); a revoked connection; **an
  unowned connection is not shared**, even by a member who joined the
  emptied owner group again; a connection whose provider has no registered
  plugin; revoke terminal, audited once, idempotent, **`not-found` for a
  share that is not of the connection the route names**, and answered like a
  repeat when another revocation won between the read and the write; **a
  share and a revocation are settled even when their own entry cannot be
  written** (the missions they orphan or restore are still recorded); the
  dialog's context (catalog, groups,
  active shares, labelling, stale resources ignored); `received` flags a risk
  the catalog dropped and that risk leaves the authority.
- **`tests/integration/authority/share-restores.test.ts`** (11) — **a share
  that would bring orphaned missions back names them first** (spec §2.3,
  §7.3): the forecast names exactly the missions the share then restores,
  with who issued them, and none for a share that covers nothing they
  accepted; **it reads only** (no share, no entry, no state); it counts the
  union with the shares the creator still receives; it supposes the share
  **in place of** the one its target holds; a group target reaches its
  current members only; missions the store holds as revoked are left out; it
  refuses what a share refuses. Over HTTP: **the first post stores nothing**
  and answers a `303` to the dialog with an opaque `confirm` id (readable by
  that session only, as often as the page loads); the post that carries
  every mission shares and restores; one that misses a mission, or names
  something else, comes back again; a share that restores nothing is made
  at once.
- **`tests/integration/authority/missions-on-connection.test.ts`** (8) — **what
  an owner reads about a connection** (ADR
  owner-reads-missions-and-holders-of-a-connection).
  `MissionService.onConnection`: the missions of everyone on the connection
  with what each uses there (the creator, the derived state, how many accepted
  risks of this provider and how many under approval, the resources of this
  connection only, whether the reader may open the mission); a mission that
  reads `orphaned` with its cause, then `revoked` once closed; nothing to who
  holds only a share, to an operator, or for an unknown id; a member of the
  owner group reads it and a former member does not. `ShareService.holders`:
  the owner and each active share with the people behind it (a person, a
  group with its members) and who made the share; the members of the owner
  group, a revoked share left out; a deactivated person is said so; anyone
  but an owner reads `not-found`.
- **`tests/integration/authority/close-orphaned.test.ts`** (11) — **closing an
  orphaned mission** (spec §2.3): **an owner of the connection revokes it** —
  stored `revoked`, every token stopped, the door answers `mission-inactive`
  (revoked), one `mission-revoked` under the owner's name with `before.status:
orphaned`, `closed_as: connection-owner` and the connection; a closed
  mission is not restored by a share made again; **an owner cannot close a
  mission that serves and reads "not found"**; someone who owns none of its
  connections reads "not found"; the creator closes as before, no ground
  named; every current member of the owner group may, a former member may
  not; idempotent, one entry; **a delegated client never acts as an owner**;
  the missions a revoked connection left orphaned; `orphanedOn` lists them to
  owners only and none that serves; the route answers 200 then 404.
- **`src/server/shares/errors.test.ts`** (4) — a `ShareError` / `ConnectError`
  recognised by name and code when thrown by another copy of the class (what
  a page catches); a sentence and a 4xx status for every code.
- **`src/server/groups/service.test.ts`** (15) — create (trimmed, audited);
  empty, too long, control character; a name held by a local or an
  IdP-sourced group; **the admin rule's group is reserved**, and **a local
  group of that name makes nobody an operator** (the same group once
  IdP-sourced does); add by email, idempotent, listed with members; unknown
  email, unknown group; an IdP-sourced group is never edited; removal
  audited with what the membership held; owned connections counted;
  `findActiveUserByEmail` (equality only, case, ambiguous, removed twin);
  **an addition and a removal are settled even when their own entry cannot
  be written** (the emptied owner group still leaves its connection
  `unowned`).

Integration, real composition root on `:memory:`
(`apps/gateway/tests/integration/authority/`, 46 + 1 skipped; rig in
`support.ts`: the execution instance and its Depot plugin, a second user, an
operator):

- **`share-and-orphan.test.ts`** (19) — **the chain**: before any share the
  beneficiary's issuance context is empty → the owner shares R1 → "Shares
  received" shows it with the exact restriction → the beneficiary's context
  carries R1 → a mission within R1 is issued and a call passes → **a draft
  beyond R1 is refused with the uncovered list** (`exceeds-authority`,
  `risk_ids`) → the owner revokes the share → the mission is `orphaned` at
  once (**derived: the stored row stays `active`**), one `mission-orphaned` entry (actor: the owner; cause, connection,
  uncovered) → **`tools/call`, `tools/list` and the catalog answer
  `mission-inactive` / `orphaned`**, the provider is not called → the
  beneficiary holds nothing, the owner's own mission still runs. Narrowing a
  share orphans only the missions that exceed it. Union of a direct and a
  group share, and the operator removing the member orphans what the group
  half grounded. **Seen by the door when nobody watched** (membership removed
  straight in the store): refused, the creator's page reads `orphaned`, the
  row still `active`, no admin entry, the call audited. **Derived and
  reversible**: **lose → refused → regain — the same token serves the
  next call on the same session, counters 2 → 2 → 3, the token still `active`,
  `mission-orphaned` then `mission-restored` under the owner's name, call
  entries allowed, allowed, refused, refused, allowed**; restored only when
  the new share covers every accepted risk (the detail's `orphan.uncovered`
  says what is missing); **the door detects both directions with no admin
  entry**; a membership the operator returns restores (`restored: 1`, actor:
  the operator); **a revoked connection never comes back** — the service
  refuses to share it and a share written behind its back grounds nothing;
  **a revoked and an expired mission are unaffected** by the authority going
  and coming, and no entry names them; **while orphaned no gate edit, no
  rotation, no decision on a claim** (`mission-closed`), and the same claim
  is granted once the authority is back. **An orphaned mission takes no gate
  edit** (`inactive`), its creator revokes it, and a share made again does
  not bring a revoked mission back. A removed creator. A revoked connection orphans every
  mission that carries it, the owner's included. Audit visibility: the owner
  reads the share acts, the creator the orphaning, an operator all. **No
  transitive sharing**: a beneficiary who shares, lists or revokes reads "not
  found"; every member of an owner group shares. **A request on an
  orphaned mission still expires on the normal delay** (ADR
  [[request-expiry-on-orphaned-missions]]): a claim is swept past its
  expiry while the mission is orphaned, reads `not-open` once the authority
  is back, and the replay opens a new one; an approval request has its
  sealed arguments erased at the expiry, never held until the authority
  returns.
- **`rules-read-by-pages.test.ts`** (7) — **what a page reads is what the act
  answers.** The predicates on every status: a connection takes no owner act
  once revoked or unowned, and only then (`ownerActRefusal`); the gates of a
  mission are not edited once it is revoked or orphaned, and only then
  (`gateEditBlockedBy`). Then, on the real root: an owned connection is
  shareable and transferable to the groups of its owner; for an unowned and
  for a revoked connection the Share context names the refusal of `share`
  (`ShareContext.unshareable`) and no transfer target is offered;
  `ConnectionService.reassignTargets()` lists the groups `reassign` accepts,
  the ones that have a member; `MissionDetail.gates_editable` follows
  `setGate` — off while the mission is orphaned, back with the authority,
  off for good once revoked.
- **`ownership.test.ts`** (13) — transfer to a group of the owner (entry;
  later members are full owners and issue on the full catalog); **a co-owner
  cannot keep a share for the day they leave the group** (ADR
  [[share-to-a-current-owner-refused]]): on a group-owned connection a share
  to oneself and a share one member makes to another are refused
  `target-is-owner`, nothing stored and no entry, while somebody outside the
  group is still a target; leaving the owner group therefore ends the
  authority (`basis: 'none'`, the mission `orphaned` and refused
  `mission-inactive`, no new issuance); a share an owner makes to a former
  member after they left is an ordinary share (`basis: 'share'`); a share to
  a group is not refused because the sharer belongs to it; transfer to a
  group one is not in, or by a non-owner, refused; **unowned**: the last
  member leaves → `unowned`, the share's mission keeps running, the mission
  grounded on the vanished ownership is orphaned, nobody shares or reads the
  connection, the operator lists it and reassigns (entry with before/after),
  the new owner acts and the share never stopped, **and the mission her lost
  membership had orphaned is restored by the reassignment** (`mission-restored`,
  actor: the operator; its token serves again); reassign refused for an
  owned connection, an unknown one, an unknown user, an empty group; a
  member coming back does not restore it; **an unowned connection whose
  credential dies is `expired`, still listed, and stays `expired` after
  reassignment**. Sign-in through the simulated IdP: a dropped IdP group
  orphans the missions it grounded (actor: the user); **a group claim missing
  at one sign-in is not a permanent outage — the next sign-in that carries it
  restores the same mission: same token, same session, counter 1 → 1 → 2,
  `mission-orphaned` then `mission-restored` under the user's own name, and a
  further identical sign-in writes nothing**; a sign-in that removed
  the last member of an IdP owner group turns the connection `unowned`,
  **IdP and local groups merge** and a sign-in never touches a local
  membership.
- **`handlers.test.ts`** (11) — the form posts: "select all" arrives as one
  `risk` field per ticked risk and is stored as that list; share to a group
  then update; nothing ticked, the literal `all`, a wildcard → back on the
  dialog, nothing stored; a non-owner reads "does not exist"; revoke tells
  how many missions were orphaned; transfer to a group of the owner only;
  Administration: create a group, add and remove a member, reassign the
  connection left ownerless; the bootstrap operator's acts audited as
  `bootstrap`; a plain user gets 403 on every operator act, and the operator
  cannot take an owned connection. Every landing URL carries the opaque
  notice id only.
- **`door-latency.bench.test.ts`** (skipped unless `VAUBAAN_BENCH=1`) —
  prints the mean cost of the door's re-check for the three groundings next
  to a whole in-process call.

Store (`tests/integration/store/ownership-and-orphans.test.ts`, 13):
`markOwnerlessUnowned` (exactly the active connections whose owner group is
empty; idempotent), `listOwnerless`, `assignOwnerlessTo` (unowned → active
with its credential; expired stays; a revoked one never touched), `markExpired`
from `unowned`;
**`orphaned` is never stored (migration `0007`)** — the repository has no
`markOrphaned` and `STORED_MISSION_STATUSES` is `active`, `expired`, `revoked`;
the table refuses the value on update and on insert, whoever writes it, and
still takes the others; a database at version 6 holding an `orphaned` row is
migrated to `active` with `closed_at` cleared, the `revoked` and `expired`
rows untouched;
`replaceForTarget` (atomic, other targets and connections untouched, nothing
written when a risk is unknown), `listActiveForTargets` with a connection;
`createLocal`; the IdP / local merge of `groupsOf`.

Structural (`tests/unit/structural/authority-not-snapshotted.test.ts`, 27) —
**spec §10 "never from a snapshot"**: every class of `server/authority`
holds its `deps` and no other field; no file of the module imports a cache,
a session or the auth module, nor keeps a module-level map; then one
long-lived instance follows membership changes made in the store at
issuance, in the web session (whose `login.groups` still lists the group),
in the owner check of the Share dialog, and at the execution door.
**Extended to the `orphaned` state itself (spec §2.3 "never stored
as a verdict")**: three rounds of leave / join at the door and on the
creator's page with the `missions` row (`status`, `updated_at`, `closed_at`)
byte-identical throughout and the refused calls consuming nothing; no
production source writes the status (`markOrphaned`, `SET status =
'orphaned'`, `setStatus(…, 'orphaned')`); the stored-status set excludes it
and the two triggers exist and abort a raw write; the last migration that
mentions the value is the one that removes it; **every production file that
loads a mission record is classified** (`MISSION_READERS`: derives through
`grounds.inspect` / `derive`, or does not read the status), the ones said to
derive are checked to call it, the composition root is checked to wrap the
Delegations listing, and the two that do not derive are checked not to read
`.status` on a record.

The suites of other sections that follow these rules are described where
they live: `admin-mutations.test.ts` and the guard suites under
[Audit](#scenarios--audit-search-mission-session-retention) and
[Human authentication](#scenarios--human-authentication),
`pipeline.test.ts` under [Execution door](#scenarios--execution-door),
`reassign-and-settle.test.ts` under
[Connections](#scenarios--connections-resources-provider-apps). The request
and budget suites build `RequestService` with `alwaysGrounded`.

## Scenarios — Requests

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §2.3
> (Request states), §3.4 (the claim: creator only, the four answers, the
> event, "a refused or expired claim does not close the mission"), §4.2
> "Request inbox", §6 ("requests are granted only in a human session",
> rate limit on the request page per IP), §7.6. Handbook [[requests]]. ADR
> [[claim-resolutions-as-counter-credits]]. The claim itself is dropped by
> `SessionService.recordCall` (budget scenarios above); these start from its
> refusal.

Unit, beside the code (`apps/gateway/src/server/requests/`, 87 with
`approval.test.ts`, listed under "Scenarios — Approval gate"):

- **`state.test.ts`** (9) — **state machine**: `open → granted | refused |
expired`, the three terminal for every transition; an open request past
  its expiry reads `expired` (boundary instant included) and is not
  decidable; a decided one keeps its state whatever the clock; the request
  URL is `<public_url origin>/r/<id>` and an id cannot leave the prefix.
- **`claim.test.ts`** (38) — the four options, always in the same order,
  each with a one-line consequence naming what stays exhausted and until
  when (recurring and one-off); quota extension bounded by what was
  consumed; the expiry floor; a mission that never expires; revoked /
  orphaned missions leave only the refusal — and for an orphaned mission
  the sentence states until when the request can still be granted —, an
  expired one only the expiry and the refusal; a risk that left the policy; nothing consumed after a
  rollover; `checkClaimDecision` for each resolution and each refusal;
  `parseClaimDecision` for JSON and form fields, a `datetime-local` value
  read as UTC, unknown keys and every malformed body refused.
- **`client-ip.test.ts`** (2) — the request page keys its limit on the
  shared client-address rule, not a copy of it (the rule itself is tested in
  `http/client-ip.test.ts`, "Instance configuration" above); every caller
  shares one key when no proxy is trusted.
- **`events.test.ts`** (7) — one line per event kind, total for unknown
  kinds and missing details; an event with malformed details is shown
  without detail and does not throw.
- **`sweeper.test.ts`** (4) — ticks on the interval until stopped; a failing
  pass is logged and the next still runs; passes are not stacked.

Integration:

- **`tests/integration/requests/request-service.test.ts`** (34, `:memory:`
  store, manual clock) — inbox lists the claim with the URL the refusal
  carried, empty for anyone else, drops an overdue request before any
  sweep; **creator-only access**: another user, an unknown id, **a
  beneficiary of a share on the same connection**, a co-owner through the
  owner group → `forbidden`, and a refused decision changes nothing; the
  creator's view (risk line, other risks, period, events, options);
  after a rollover the risk reads un-exhausted; **reset** zeroes the
  counter of the claimed risk and no other, records the `reset` event with
  that one credit, **the replay passes**, a claim on one exhausted risk does
  not reopen another exhausted risk (its claim stays open, a call touching
  both is still refused), with nothing consumed it gives nothing back, admin
  audit `period-reset`; **extend quota** gives back
  N on the claimed risk only, does not carry over to the next period,
  refuses more than was consumed and leaves the request open, and the
  store never lets a counter go below zero; **extend expiry** moves the
  date while the risk stays exhausted, refuses an earlier date and a
  mission without expiry, and brings a stored-`expired` mission back to
  `active`; **refuse keeps the risk exhausted** until the next period while
  other risks pass; a revoked mission leaves only the refusal; a decided
  request cannot be decided again (`not-open`, one audit entry); a failing
  effect rolls the whole decision back; an overdue request is expired by
  the decision attempt; **the sweep expires unanswered requests** once,
  with an event each, leaves decided ones alone, does not close the
  mission, and erases the sealed arguments of an approval request; an
  approval request gets a neutral view and `unsupported-kind`. **The mission
  is checked as the store holds it at the decision**: of two extensions of
  the expiry, the second cannot move it backwards on a stale read; a mission
  revoked since it was read takes no reset and no extension; an approval is
  not granted on a mission revoked since it was read; the decision context
  carries the mission row of its own transaction.
- **`tests/integration/requests/request-handlers.test.ts`** (14, real root)
  — **exhaust → refusal URL → no session: sign-in redirect → non-creator
  403 with one sentence and no detail → creator 303 to the inbox → grants a
  reset → the replay passes**; unknown id and someone else's request are
  the same 403; a co-owner of the connection and the bootstrap operator
  are refused; **the mission token (and any other bearer) is refused on
  `/r/*` and `/api/requests/*`, even next to the creator's session
  cookie** — a delegated token is refused the same way and named for what
  it is (`presented: 'delegated-token'`), a bearer of no known shape is
  refused too and no kind is invented for it; decide needs the origin check then a session; 422 / 409 / 400
  mapping; the page's form post is redirected back with `?decided=1` or
  `?problem=<code>`; `GET /api/requests`; labels from the plugin catalog;
  **per-IP rate limit on `/r/*`** (429, `Retry-After`) that does not block
  the decision endpoint; the root runs and stops the sweeper.

Not covered here: the approval decision ("Scenarios — Approval gate"
below). The claim URL reaching an MCP client through the execution door is
asserted in "Scenarios — Execution door" (`budget-exhausted`).

## Scenarios — Now and Waiting for you

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §4.2 (the
> home, "Request inbox"), §3.4, §3.5 as a person reads them; style guide §1
> (one primary action, the exception and not the rule), §6. Handbooks
> [[web-app]] ("The home — Now", "Pages outside the shell", "Self-contained
> documents") and [[requests]] ("Who asked, and what waits", "Pages"). ADR
> [[now-and-waiting-pages]].

- **`src/server/requests/asker.test.ts`** (4) — **who asked**: the first
  refused call that points to the request names the holder and the label,
  the count is every such call; the calls of another request, the allowed
  calls and the refusals that ask nothing are ignored; an event stored
  before tokens had a holder has a label and no holder; `null` when nothing
  points to the request or the details cannot be read.
- **`src/server/now/derive.test.ts`** (5) — the nearest limit is the largest
  share used, ties to the first listed, never more used than the limit, a
  limit of zero is reached, `null` for an empty policy; missions sort by last
  activity, the never-called ones after, newest first.
- **`tests/integration/now/now.test.ts`** (11, real root) —
  `RequestService.waiting` names the holder by display name and the agent by
  its label, counts the replays, lists what is left, names a machine key by
  its name, **is the creator's alone** (a teammate and an administrator get
  nothing) and **never carries arguments**; the `asker` of a view;
  `answered` since an instant, never someone else's. `readNow`: a newcomer is
  on a first run; what waits and what runs with its keys, its nearest limit
  and its counts; **calls are the last 24 hours and refusals the last
  hour**; a teammate sees the mission shared with them, that it waits, none
  of its requests, and their own key first once generated; a stopped mission
  is named apart. `readSetup`: every service that needs a company app is
  registered or missing; telemetry undecided.
- **`tests/unit/app/now-and-waiting.test.tsx`** (28, static markup) — the
  words of a period, of a delay and of who asks; an event in the words of the
  interface, total on malformed details. **The page of an approval is read
  in order**: who, the mission, the call and its arguments, the permission
  and its severity, the room left, what an answer does, then the answers —
  the consequence precedes the first button; three forms, yes first; one
  answer for several permissions and a limit already reached said before
  answering; answered, expired and refused each have a state and no form,
  and no argument; a mission that cannot run says why and disables what does
  not apply, in the page's own words; a problem code has its sentence. **A
  limit**: who was stopped, how much was used, when it resets; one choice,
  without the answer that does not apply; **the form posts `resolution` and
  nothing else**. **The home**: one `h1`, one primary action; what waits,
  what runs, the counts; **no yes and no argument from the home**; one meter,
  drawn near a limit; nothing waits → one sentence, the list closed; a
  teammate reads "waiting for Alice's yes". **First run**: the model, the
  steps, one accent; an account given by someone makes the mission the next
  step; an administrator reads the setup list first.
- **`src/server/http/document.test.ts`** (6) — **the self-contained
  documents repeat the tokens value for value** in both themes and use no
  other colour; light by default, dark for the system, the chosen theme when
  given; the theme cookie is the application's; no script, no external
  resource, title and message escaped; the style nonce.
- The themed 403 of the forwarded URL is in
  `tests/integration/requests/request-handlers.test.ts`; the theme of the
  consent pages in `src/server/oauth-as/pages.test.ts` (13).

## Scenarios — Approval gate

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §0 (Gate,
> Approval request, Approval), §2.3, §3.5, §4.1 `approval-required`, §4.2
> "Request inbox", §7.7, §8 (the acts), §10 "the approval: binding to the
> exact argument fingerprint, single use, expiry, whole refusal of a
> multi-risk call, gate opening bounded to the period, erasure of arguments
> after decision" and "integration: approval and replay". Handbooks
> [[requests]] ("Approvals"), [[budget-and-sessions]] ("Gates opened for the
> period"), [[missions]] ("Editing a gate"). ADR [[atomic-budget-accounting]]
> (amendment "the approval gate").

Unit:

- **`apps/gateway/tests/unit/server/budget/gates.test.ts`** (9) — **gate
  opening bounded to the period**: nothing opens without an event; an
  opening opens the risk it names for the period it carries, another risk
  stays gated; **the last instant of the period passes, the reload instant
  does not**; an opening granted in the next period opens that one only; a
  later edit of the gate on the mission ends it whatever the new value, an
  edit of another risk does not; **an edit at the very instant of an opening
  wins**; an opening after an edit opens again, in any order of the list;
  events it cannot read (no details, no period end, no risk, a bad
  timestamp, another kind) open nothing; fed to `decide()`: an opened gate
  consumes no approval, the next period needs one again, the budget still
  refuses at zero quota.
- **`apps/gateway/src/server/requests/approval.test.ts`** (33) — the three
  options, always in the same order, each with a one-line consequence (the
  tool, "once, within 10 minutes", the quota and the rate limit; the period
  end in UTC; "approval again from the next period"); a refusal is always
  possible; a revoked / orphaned / expired mission and a risk that left the
  policy take neither a grant nor an opening, and for an orphaned mission
  the sentence states until when the request can still be granted; a gate
  already `auto` or
  already open cannot be opened, a grant stays possible; **a mission whose
  single period never ends has no "rest of the period"**; the parser reads
  the three resolutions and refuses anything else, a claim's resolution and
  **any extra key** (nothing can widen what is granted); `formatDelay`.
- **`packages/shared/src/session-events.test.ts`** — the `approval`,
  `gate-opened` (a period end is mandatory) and `gate-changed` shapes, valid
  and malformed. **`packages/gateway-core/tests/unit/errors.test.ts`** — the
  refusal carries `approval_valid_seconds` and a hint naming the same tool,
  the same arguments, the delay and "used once".

Integration, `:memory:` store with a manual clock
(`apps/gateway/tests/integration/requests/approval.test.ts`, 42): the
executor is `SessionService.recordCall`, the creator is `RequestService`.

- **The refusal** — every field: URL, fingerprint, the request's expiry,
  the approval's validity, the replay instruction; nothing decremented; the
  refusal never repeats the arguments; **the arguments are sealed with
  `request:<id>` as associated data** and do not open under another id; a
  replay before the decision points to the same request; **one byte changed
  is a new request with another fingerprint**; the same arguments on another
  tool are a request of their own; **a multi-risk call with one gated risk
  is refused whole**, the ungated risk neither counted nor rate-recorded.
- **The creator's view** — tool, arguments in clear, slices and touched
  risks from the audit entry of the refused call, quota / consumed / left and
  the gate of each, the three options, the session events; without an audit
  entry the slices read "not recorded"; anyone else gets `forbidden` from
  the view and from the three decisions; the inbox names the tool, never the
  arguments.
- **Grant** — **refusal → grant → the identical replay (another key order)
  passes and consumes the approval → the second identical replay is refused
  with a new request**; **the approved action decrements the quota and
  counts in the rate window** (the next one is `rate-limited`); at zero
  quota the claim comes first; **one approval covers a multi-risk call**
  (both risks counted, one request); bound to the exact fingerprint, to the
  tool and to the mission; **expires after the configured delay** (boundary
  instant), and the delay is the operator's. **A call touching several
  gated risks**: ONE request listing every gated risk, one row, one inbox
  entry, a hint that says so; a replay before the decision reuses it
  whatever the order of the risks; **granting it approves the call** (one
  approval, one replay, both counters, single use); the grant is audited and
  recorded with every risk; refusing it refuses the call; `open-gate` opens
  every listed gate, one event each; a gate already open is not listed;
  another tool with the same arguments does not use it. **What an earlier
  build left**: an open one-risk request is neither reused for a call that
  needs more nor widened, granting it approves what it named and no more,
  and approvals granted risk by risk are consumed together.
- **Erasure** — on `grant`, `open-gate` and `refuse` **the row's `args_blob`
  and `key_version` are NULL** (read with SQL), `decision_json` names no
  argument, the view shows `arguments: null`; **on expiry the sweeper erases
  the blob, and before it runs nothing opens an overdue request**; a
  decision after the expiry decides nothing and erases; a decision the rules
  refuse writes nothing and leaves the arguments sealed; a decided request
  is not decided again.
- **Refuse** — no approval; the replay asks again.
- **Open the gate for the rest of the period** — a `gate-opened` session
  event, no approval; **`decide()` reads it**: the replay and any other call
  on the risk pass, **within the rate limit and the quota**; another gated
  risk still asks; **after the reload the gate asks again**; opened again in
  the next period it opens that one only; not twice in a period; **an edit
  of the gate on the mission ends the opening**.
- **Mission states** — revoked: a refusal only; a risk that left the policy:
  a refusal only.
- **Audit and logs** — **every decision writes one admin entry**
  (`approval-granted`, `gate-opened`, `request-refused`) naming the creator,
  the request, the tool and the fingerprint; a grant names its approval, an
  opening its period; **the audit, the session events and the logs never
  hold the arguments**, and no row holds a blob once every request is
  closed.

Integration, the real composition root:

- **`tests/integration/requests/approval-access.test.ts`** (29) — **nobody
  but the creator reads the arguments**: an operator, a co-owner of the
  connection through its owner group and another user each get no view, one
  sentence at `/r/<id>` (no argument, tool, mission name, risk or creator),
  an empty inbox, 403 on the three decisions, and nothing on the mission's
  pages; **the bootstrap operator** gets 403 on the three routes; **the
  executor cannot approve its own action** (mission token refused by kind,
  even next to the creator's cookie); another origin is refused; the creator
  decides over JSON (the answer is the summary, tool but no argument) and
  through the page's form (303 `?decided=1`, `?problem=<code>`); after the
  decision the whole audit and the session events hold no argument.
- **`tests/integration/execution/approval-door.test.ts`** (8) — **the
  GitHub plugin's `developer` preset as shipped**, over JSON-RPC on `/mcp`
  with a mocked upstream: a workflow file write on a feature branch (the
  gated `github.workflow-write-via-file` and the ungated
  `github.feature-branch-write`) is refused whole, nothing forwarded; the
  creator's view shows the two slices and both risks; **grant → the
  identical replay reaches the provider, counts on both risks, and its audit
  entry carries `approval_id` → the second replay is refused**; one byte
  changed and `github__delete_file` with the same arguments ask again; a
  file outside `.github/workflows` never meets the gate; the gate opened for
  the period; the gate set to `auto` on the mission; the sealed blob does
  not read as the arguments, and neither audit, events nor logs hold them.
- **`tests/integration/missions/gate.test.ts`** (20) — **the gate edited
  after issuance**: `auto → approval` makes the next call ask and leaves the
  rest of the policy untouched; `approval → auto` lets calls pass and leaves
  the open request open; one `gate-changed` entry with before / after and a
  session event once the session exists; the same gate writes nothing;
  **`approval` asked on a risk whose gate is open for the period closes the
  opening** (`opening_closed: true`, `previous: 'approval'`): the next call
  is `approval-required` again, `gate_open_until` is `null`, one entry
  carries `open_for_period: true → false` and one `gate-changed` event is
  recorded; asked again, nothing is written; **the gates of an expired
  mission stay editable** (`gates_editable`) and "ask me again" closes the
  opening there too, so that it is not found open when the expiry is
  extended — the next call asks again; on an expired mission with no
  opening, a repeated `approval` writes nothing;
  creator only (`not-found` for an operator and another user); a value that
  is not a gate, a risk outside the policy, a revoked mission; the detail's
  `gate_open_until`; `POST /api/missions/:id/gate` 200 / 400 / 404 / 422 /
  409 / 403 / 401.
- **`tests/integration/store/approval-decisions.test.ts`** (20) — migration
  0005 (the `tool` column and the lookup index), `decideApproval` in one
  transaction and its rollback, `getArguments` on an overdue request, the
  open request of a call, `riskEvents`, `setGate` (with `closeOpening` on a
  gate already `approval`: the `gate-changed` event and nothing else, and no
  effect on a gate that is `auto`), `latestCall`.
- **`tests/integration/audit/admin-mutations.test.ts`** — **structural**:
  `MissionService.setGate` and `RequestService.decideApproval` are classified
  as mutations, and each resolution of an approval request leaves its act,
  through `decide` and through `decideApproval`.

Not covered: a real provider behind an approved call (never); one request
for a call touching two gated risks (they ask in turn, by decision).

## Scenarios — Audit search, mission session, retention

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §3.3 (the
> session), §4.2 ("Mission session", "Audit"), §6 ("immutable audit", "no
> secret in logs"), §7.9 (several agents: who did what), §8 (one entry per
> call and per administrative act, fields, retention). Handbook [[audit]].

Suites under `apps/gateway/tests/integration/audit/` run on the real composition root with the
`:memory:` store and the shipped plugins (`support.ts`). They seed calls the way `CallPipeline`
produces them — `SessionService.recordCall` (session, counters, events, requests) then the
store's audit writer — rather than through the execution door; entries written by the door
itself are asserted in "Scenarios — Execution door".

- **`apps/gateway/src/server/audit/filters.test.ts`** (20, unit) — **audit filters**: every parameter
  read and trimmed; first value of a repeated parameter; decision and kind outside their
  closed sets dropped and reported; unreadable or impossible dates dropped; a reversed
  period ignored; a single day is `[00:00, next 00:00)` UTC; oversized value refused;
  cursor round trip and every malformed cursor refused; `auditQueryString`; `scopeOf` for
  a user, an operator and the bootstrap operator; `withoutArguments`; the token holder in a
  query string (`member:<id>` / `named:<name>` round trip, anything else names nobody).
- **`apps/gateway/src/server/audit/session-event-detail.test.ts`** (10, unit) —
  `eventDetailLines`, what the session page writes under an event: an
  allowed call says when it consumed an approval and nothing otherwise; a
  refused call names the request it pointed to once that request is closed;
  a request event says whether it was asked, refused or left to expire; an
  approval says until when the approved call can be replayed; a gate opening
  says until when, a gate edit says both gates; a reset and a quota
  extension list what was given back, an expiry extension the new expiry; a
  rotation shows the token prefix, a revocation how many tokens it retired;
  a token issued to a holder names the holder and the token it replaced; one
  token revoked on its own names it and its holder;
  nothing for malformed details or a kind of a later version.
- **`audit-query.test.ts`** (35) — **by agent label**: exact and
  case-sensitive, call entries only (no administrative entry), narrowed by
  the other filters, and never a way into someone else's audit (the scope
  comes first). **Visibility**: a creator sees the calls and acts of their
  missions, another user none; a connection's owner sees the calls made through it by a
  mission they did not create; a member of the owning group sees it, a non-member does
  not; an operator sees every entry, calls included, and the bootstrap operator the administrative ones only; **a member** sees the calls, acts and requests of a mission shared with them and nothing of any other, stops at once when removed, and is offered the mission as a filter; **neither a member nor an operator is shown the argument fingerprint** (call entries and request entries), while the creator and the connection's owners are — decided entry by entry (`standingOn`), every dimension of the scope exercised at once;
  the bootstrap operator sees administrative entries only; a request's entries belong to
  its mission; **a filter never widens the scope**. **Filters**: mission, connection,
  tool (exact), decision, kind, period, user (email or id, unknown user → nothing),
  combined. **Paging**: page sizes 3/3/1 over seven entries, no entry twice, stable on
  equal timestamps, no further page announced on an exact fit, a write during paging does
  not shift the next page. **No raw arguments**: the argument marker reaches no viewer's
  page; arguments wrongly put in an administrative entry are replaced by `[not shown]`.
  The bootstrap operator is named ("Bootstrap operator") instead of shown by its actor id.
  The object of every administrative entry is named, whatever its type (mission, connection,
  share, group, OAuth client, delegation, request, instance configuration); an object that is
  gone, or was never created, is shown by its id.
- **`events-agent-label.test.ts`** (3) — **`events.agent_label`, migration
  `0008`**: the events an earlier image stored are backfilled, call events
  only; the copy made at insert follows the rule of the backfill; the calls
  of one label, or the unlabelled ones, are read newest first by keyset.
- **`mission-session.test.ts`** (21) — **agent labels**: the calls of the
  current period per label, allowed and refused, the unlabelled ones apart,
  **beside counters that stay per risk and per mission**; calls of past
  periods left out and nothing for a mission that is not active; the
  timeline filtered to one label, or to unlabelled calls (requests and
  rotations are not calls and drop out), with the budget and the per-label
  counts unchanged by the filter; **the calls of one label paged among
  thousands of events of other labels**, in the timeline's order, without
  repeating or skipping; the view says until when a gate is open and what
  each approval and gate event did. And: creator only (another user, an operator and an unknown
  id get `null`); before the first call (no session, full budget, gate per risk, catalog
  labels); counted / left / exhausted per risk; past periods kept apart and yesterday's
  exhaustion gone; one-off mission; **open requests by link only** (kind, risk, dates,
  `/waiting/<id>`; the sealed arguments exist in the store and are not in the view); decided
  request no longer listed; **a granted claim lowers the counters** (quota extension then
  period reset: counted and left follow the counter, the `extension` / `reset` events carry
  the credits, the decisions are in the mission's audit); agent labels with counts; timeline newest first with tool,
  risks, what is left, refusal code and request; timeline paging; revoked mission keeps
  its history; `eventView` ignores every detail it does not name and shows an event with
  malformed details without detail.
- **`session-history-retention.test.ts`** (11) — **`retention_days` also purges the
  session history**: events older than N days and no other (exactly N days old is kept);
  **the counters of periods that ended more than N days ago, never the current one**;
  in a period longer than the retention the call events leave and **the gate and credit
  events of the period stay — the gate opened 90 days ago still reads open** — with the
  period's counters; a gate or credit event leaves once its period is over; on a one-off
  mission the old calls leave, its counters and credits stay; each session by its own
  mission's period, idempotent; nothing but `events` and `session_counters` is
  touched; a retention that is not a number of days is refused. The sweeper purges both
  with the same number of days, logs what it removed, **the two purges fail apart**, and
  the composition root wires it.
- **`retention.test.ts`** (10) — **the purge removes the entries older than N days and
  nothing else**: older call and act gone with their risk rows, the entry exactly N days
  old and the recent ones intact, seven other tables unchanged; **the triggers still
  forbid `UPDATE` and `DELETE`** on `audit` and `audit_risks` afterwards and the purge
  window is closed; idempotent; the configured number of days is honoured; boot sweep,
  interval, stop; a failing purge is logged and retried; concurrent sweeps share one
  purge; the composition root starts the sweeper with `retention_days` and `close()`
  stops it; default 90 days.
- **`admin-mutations.test.ts`** (52) — **structural: every administrative mutation writes an
  admin audit entry.** The public methods of every class under
  `server/{connections,provider-apps,missions,auth,requests,telemetry,authority,shares,groups,users,oauth-as,management}`
  are enumerated from the source with the TypeScript parser; each must be classified (read,
  mutation, exempt with a reason), with no unclassified method and no stale rule. Each of the
  45 mutations is driven on an ephemeral instance, must go through the method under test (spy)
  and leave exactly one entry with the expected act, object and acting user: connection created
  (key and OAuth callback), resources discovered, resource edited, connection revoked,
  transferred, reassigned; mission issued (issue and duplicate), rotated, revoked, gate changed;
  member added and removed, a member's token generated, a named token issued, a token revoked
  (by its holder or the creator, and for a deactivated holder);
  mission orphaned (`MissionGrounds.watchConnection`, `watchCreator`) and restored
  (`MembershipSettler.watch`); share created and revoked; group created, member added and
  removed; user deactivated and reactivated (`UserAdminService`, through the two routes);
  configuration changed (provider app saved, cleared, unverified installations
  accepted, IdP saved, bootstrap token revoked by the first operator sign-in, telemetry
  toggled); request decided (`RequestService.decide` refusing, `decideClaim` resetting the
  period, `decideApproval` granting); OAuth client approved, delegation granted and revoked
  (`TokenService.revoke`, `DelegationService.revoke`, and `DelegationService.revokeAllOf`
  reached through a deactivation, in the operator's name); the three mutations of the management
  door (`ManagementTools.issueMission`, `rotateMissionToken` — on a mission the same delegation
  issued through the door —, `revokeMission`), each in the
  user's name with `delegated_client_id` (acts of the interface leave it null). Plus: each
  resolution of an approval request (`grant`, `open-gate`, `refuse`) leaves its act through
  either entry point; a resource edit records `before` / `after` and a save that changes
  nothing records none; a failed discovery is recorded with its reason.

## Scenarios — Community telemetry

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §9 (opt-in
> per instance, content of a report, what is never sent, validation status on
> each connection), §10 "a telemetry report contains none of the forbidden
> fields", §4.3 (opt-in and collector URL), §8 (the toggle is a configuration
> change). Handbook [[telemetry]]. ADR [[telemetry-collector-shape]]. No test
> reaches a collector: the outbound `fetch` is injected everywhere.

Unit, beside the code (`packages/telemetry/src/`, 60):

- **`report.test.ts`** (24) — **the frozen shape**: the six keys and the four
  outcomes; `createPluginReport` returns a frozen six-key object whatever the
  input smuggles in (`arguments`, `arguments_hash`, `mission_id`,
  `instance_id`); refuses a plugin, version or tool that is not of its shape
  (spaces, a query string, free text), an unknown outcome, an error class on
  a success, none on a failure, free text, a class of another outcome, an
  HTTP class out of range; each named class belongs to one outcome;
  `isPluginReport` by exact keys; `serializeReports` drops what is not a
  vetted report.
- **`queue.test.ts`** (12) — **batching**: one timer for several pushes, the
  flush interval, an immediate flush when a batch is full, at most
  `batchSize` per request, order kept, one request in flight, oldest dropped
  on overflow. **Backoff**: a batch the collector did not take stays and is
  retried after 100, 200, 400, 800 ms then the cap; a full batch does not
  shorten the wait; a `send` that throws is a retry; a refused batch is
  dropped, never resent; the delay formula with jitter; `clear()`, `stop()`.
- **`client.test.ts`** (24) — **disabled → zero network calls** (120 reports
  recorded, the injected `fetch` never called, no warning); **enabled with
  the placeholder collector URL → zero network calls** and exactly one
  warning; **the placeholder compared by origin and path**: with a public
  key appended, another query, one or several trailing slashes, a trailing
  slash and a key, or a fragment it is still the placeholder and nothing
  leaves, while another path, another host or another scheme is not the
  placeholder; a report queued while enabled
  never leaves once telemetry is switched off; the request (JSON array of
  six-key objects, the public key moved from the URL to `apikey` /
  `Authorization`, `Prefer: return=minimal`, redirects refused, no
  credentials, no referrer); 408 / 429 / 5xx and an unreachable collector
  keep the batch; 400 / 401 / 403 / 404 drop it with one warning.

Unit, beside the code (`apps/gateway/src/server/telemetry/`, 48):

- **`outcome.test.ts`** (30) — **outcome classes**: a result is a `success`;
  `isError: true` is `classification-error / executor_refused`; a status
  (`UpstreamAuthError`, `UpstreamHttpError` 500 and 404 → `http_500`,
  `http_404`, numeric `status`), `fetch failed`, Node network and
  timeout codes down the `cause` chain, `AbortError`, a credential refused
  for good are `upstream-error` with their class; `TypeError`, `RangeError`,
  `ReferenceError`, `SyntaxError` and non-`Error` throws are
  `execution-error`; **an error whose `name`, `code`, `status` and message
  are a secret ends as `unspecified`**; a cyclic `cause` terminates;
  `reportOf` yields nothing for a tool the plugin does not declare or a
  version that is not semver.
- **`settings.test.ts`** (7) — **who decides**: off by default; the
  configuration wins for `true` and for `false`, over a stored toggle, and
  the setter throws; the operator's toggle is stored and applied at once; a
  stale view is re-read in the background; an unreadable store keeps the last
  value.
- **`stats.test.ts`** (11) — the `plugin_stats` request (plugin-level rows,
  registered ids, key in headers); nothing on the first read, then the row of
  the running version; cached 6 h; an error status, a non-JSON body, a body
  that is not a list and an unreachable collector show nothing and are not
  retried for 10 min; **no request at all while telemetry is not sending**;
  concurrent refreshes share one request; malformed rows skipped.

Structural (`apps/gateway/tests/unit/structural/`, 10):

- **`telemetry-report-shape.test.ts`** (3) — **spec §10, property-based**:
  three seeds × 400 calls through the real root (`:memory:` store, the door,
  the pipeline, the telemetry module, a mocked collector). Each call draws a
  tool, arguments, an agent label, a caller address and user agent, and one
  of thirteen ways `plugin.execute` can end — a result echoing the arguments,
  an error result, thrown errors carrying the arguments, the provider token
  and a unique message in their message, `name`, `code`, `status`,
  `statusText` and `cause`, thrown strings, objects, `null`, symbols — and
  one call in ten is refused before the plugin. Asserted on everything that
  reached the collector (URL, headers, body): exactly the six keys per
  report; every value from a universe fixed before the first call (the
  plugin's declaration, the build stamp, the closed vocabularies); none of
  the planted values anywhere — argument values, `fingerprintArguments(args)`
  of every call, resource refs and ids, mission, session, user and connection
  ids, the mission token and its prefix, the provider key, agent labels,
  addresses, user agents, the instance's host, provider messages; one report
  per call that reached the plugin, in order, with the expected class; every
  outcome class drawn.
- **`telemetry-collector-schema.test.ts`** (7) — `deploy/collector/schema.sql`
  read as text: the table's columns are an identity, a day and the six report
  keys; `anon` holds `INSERT` on those six columns and one `for insert`
  policy, nothing else; the view runs with its owner's rights and is the only
  thing `anon` reads; the `CHECK` constraints carry the outcomes, error
  classes and shapes exported by `@vaubaan/telemetry`; the per-request limit
  admits a full client batch; the thresholds published in the README are the
  ones of the SQL function; the README documents every field and class.

Integration (`apps/gateway/tests/integration/telemetry/telemetry.test.ts`, 18):

- **Disabled by default** — 61 calls, a failing one included, a flush and a
  statistics refresh: the injected collector `fetch` is never called;
  `telemetry.enabled: false` in the configuration keeps it off and the toggle
  answers `?problem=locked`, storing and auditing nothing.
- **Placeholder collector URL** — enabled by the configuration, then by the
  operator: zero network calls, one `warn` naming the placeholder, state
  `placeholder-collector`; the default URL with a collector key appended, or
  with a trailing slash, is still the placeholder.
- **The operator's toggle** — stored as `telemetry.enabled` in
  `instance_config`; only calls made after the opt-in are reported; **one
  `config-changed` entry on `instance-config:telemetry` per change** with
  `before` / `after`, none for a toggle to the same value; switching off
  discards the queue; 401 with no session, 403 for a user who is not an
  operator and for a foreign origin; an invalid value is refused; the stored
  toggle is read at boot.
- **What is reported** — one report per call that reached the plugin, none
  for a risk not accepted, a foreign resource or an unknown tool; `success`,
  `classification-error`, `upstream-error http_503`, `execution-error
type_error` in order; a provider failure a plugin throws with its status
  (`UpstreamHttpError`) is an upstream error in the report and in the audit;
  a 401 followed by a successful refresh is one
  `success`; a credential refused for good is `credential_rejected` and the
  now-expired connection reports nothing more; a collector that is down
  does not fail a call; the Admin overview's sample payload has the six keys
  and the collector URL is shown without its key.
- **Validation status** — one `plugin_stats` read, cached, the row of the
  running version; a collector without the endpoint shows nothing.

Elsewhere: `admin-mutations.test.ts` classifies
`TelemetrySettingsService.setEnabled` as a mutation that writes
`config-changed`; `mutation-guard.test.ts` drives
`telemetry.handlers.setEnabled` through every refusal of the guard;
`admin-guard.test.ts` covers the page `/admin/telemetry`; `load.test.ts`
tells an explicit `telemetry.enabled` from an unset one.

## Scenarios — Authorization server of the management door

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §0
> "Delegation", §4.1 bis (OAuth, metadata discovery, "a client such as Claude
> Code connects with no special configuration", delegations visible and
> revocable), §6 "separation of the three credentials", "short, traceable
> delegated tokens", §8 (delegation granted or revoked), §10 "credential
> separation" and "OAuth delegation … by an MCP client". Handbook
> [[management-door]]. ADR [[management-door-authorization-server]]. The
> door's tools are the next section.

Unit, beside the code (`apps/gateway/src/server/oauth-as/`):

- **`pkce.test.ts`** (13) — **PKCE, S256 only**: the RFC 7636 vector; another
  verifier refused, even one character away; the challenge presented as its
  own verifier (the `plain` method) refused; verifiers shorter than 43,
  longer than 128 or outside the unreserved set; challenges that are not 43
  base64url characters.
- **`secrets.test.ts`** (6) — 256-bit secrets under a prefix per kind; the kinds
  told apart by shape; none mistaken for a mission token; SHA-256 digests;
  a secret matches its digest only.
- **`redirect-uri.test.ts`** (52) — what registers (loopback in its written forms,
  https, application schemes) and what never does (plain http off the
  loopback, look-alike hosts, fragments, credentials, `javascript:` / `data:`
  / `file:`, spaces, line breaks, backslashes); **exact match** and every
  near miss (longer or shorter path, trailing slash, added query, other host,
  sub-domain, host suffix, port, scheme, case, dot segment, encoding,
  credentials); the loopback port exception and its limits; the label the
  consent screen shows.
- **`client-metadata-document.test.ts`** (91) — the identifier's rules (canonical,
  default port, a path, no IP literal); **the address filter**: public
  addresses accepted, loopback, private, link-local (the cloud metadata
  address), carrier-grade NAT, documentation, multicast, unique-local, the
  deprecated site-local range (`fec0::/10`, first and last address), NAT64,
  IPv4-mapped and IPv4-compatible refused; the lookup fails whole when one
  address of the name is not public, and no connection is opened; the
  document's rules (status, content type, its own `client_id`, no secret,
  public clients only, name, redirect URIs); cache lifetimes; names cleaned
  of control, zero-width and bidirectional characters.
- **`endpoints.test.ts`** (15) — every URL built on `public_url`; the RFC 8414
  document advertises the code flow, S256 and one scope and nothing else, no
  registration endpoint when closed; the RFC 9728 document; the execution
  door's resource document names no authorization server. **The one scope
  and the one resource, stated once**: a scope value is split on whitespace;
  an authorization request asks for the management scope and other values
  next to it are ignored; a renewal must not widen (nothing but the
  management scope may be named); a token opens the door when its scopes
  include the management scope; the first resource that is not the
  management door is named; both refusals are worded from the constants.
- **`pages.test.ts`** (12) — the consent screen names the client, the user, the
  scope and where the code goes; says the name is a claim; warns per
  destination kind; posts an opaque id with Deny first; **escapes** a hostile
  name, client id, email and destination; never cached, never framed, no
  script, a fresh style nonce; message pages answer with the status, the
  title and the sentence, escaped, under the same headers. **The build
  footer**: on the consent screen and on a message page, with the two
  stamps `/healthz` answers (version, commit); the stamps are escaped and
  add nothing the content policy would have to allow (`default-src
'none'`, no script); absent when the handlers were given no build.
- **`clients.test.ts`** (40) — registration of a public and of a confidential
  client (secret returned once, digest stored); what a registration cannot
  decide; every refusal; unused clients forgotten after a month; **the three
  policies**, the loopback exception, the policy evaluated at every use;
  **operator decisions**: approval and its entry, disabling revokes every
  delegation with one entry each, and **a disabling interrupted by a store
  fault changes nothing** (the client is not disabled, its delegations live,
  nothing is audited); metadata documents: off by default, cache
  and refetch, a loopback client back in the queue when its document adds a
  server, fail closed, never fetched for a non-canonical identifier, rate
  limit per user.
- **`authorization.test.ts`** (41) — the client and its redirect URI first, a page
  and never a redirect when wrong; the rest of the request (response type,
  PKCE required and S256, scope, resource, oversized state not echoed); **the
  consent**: an approval creates one delegation, its entry and a code stored
  as a digest; a denial grants nothing; **answered once**, also under two
  simultaneous answers; not by another user (and spent by the attempt);
  expiry; a client disabled meanwhile; no code when the entry cannot be
  written; **the delegation is revoked when its code cannot be minted**
  (nothing stays active that no client can redeem); the response keeps the registered query and names the issuer.
- **`token-service.test.ts`** (66) — the code exchange; digests only in the
  database and the audit; **PKCE verification** (wrong verifier, the
  challenge as verifier, missing verifier; the code is spent by the failed
  attempt); **code single-use**: a replay revokes the delegation and the
  tokens it produced, with the entry; two simultaneous exchanges; expiry;
  bound to its client; **refresh rotation**: a new pair, the presented token
  spent, the lifetime restarted at each renewal; **replay revokes the whole
  family and the delegation, audited once**, whoever presents the token, and
  under two simultaneous renewals when the reuse window is 0; **the reuse
  window** (the token rotated last, presented again inside the window, gets a
  new pair; inclusive of its last second; an older generation, a second
  reuse and another client are replays; two simultaneous renewals both
  succeed; nothing for a revoked delegation or a removed user); **a grant is
  one transaction** — a refresh-token or an access-token write that fails
  leaves nothing behind; a check that fails still spends the code although
  nothing was written; a renewal whose access token cannot be written leaves
  the presented refresh token the live head, and the retry is not a replay,
  even with no reuse window; inside the reuse window the head is not rotated
  and the token is answered once the store is back; **renewals are counted
  per delegation, once the refresh token is recognised** — the budget of one
  delegation stops its renewals, changes nothing, and comes back with the
  window; another delegation of the same client is not held back; unknown
  and foreign refresh tokens spend nothing of it; a replay is never
  rate-limited (it revokes the family although the budget is spent); other
  delegations untouched; bound to its
  client; expiry without being a replay; scope and resource cannot widen;
  nothing for a revoked delegation or a removed user; access tokens expire to
  the second and follow the configuration; **revocation**: a refresh token
  ends the delegation, an access token is revoked alone, another client's or
  an unknown token changes nothing; client authentication (public,
  confidential, waiting, disabled; Basic or body, never both); the sweep.
- **`delegations.test.ts`** (26) — a user's delegations with their client, most
  recent first, with the missions each issued; `idle` when no token is left;
  the date the consent ends, and `expired` past the absolute lifetime with
  nothing written; the state derived in one place;
  **revoke cascades** to every token, with its entry, once; not another
  user's; the verifier: what resolves, what never does (a refresh token, a
  code, a client id, a mission-token shape), revocation and a removed user at
  once; **the client's status is evaluated at every verification**: a
  tightened policy applies to tokens already issued (the delegation is
  active, the token is worth nothing), an operator's approval holds whatever
  the policy becomes, a client marked disabled is refused even while one of
  its delegations is still active, a client whose redirect URIs left the
  loopback interface goes back to pending and its tokens with it;
  **`endDelegation`, the one function that revokes and leaves the entry**:
  it names the delegating user when somebody else acts and the client when
  the act came through it, and answers `null`, writing nothing, for a
  delegation already revoked or unknown. **A delegation revoked for a replay
  surfaces the missions it issued and revokes none** (ADR
  [[management-door-rotation-scope-and-replay-trace]]): the
  `delegation-revoked` entry names, in `after.missions_to_review`, the
  missions still running (a revoked and an expired one left out) and every
  mission is left as it was; the Delegations view lists them (`replayed`,
  `toReview`) until each is revoked or expires; nothing of the kind for a
  delegation the user, the client or an operator ended; when the missions
  cannot be read the delegation is still revoked and the entry written, the
  list absent, not empty, and the failure logged; an authorization code
  presented twice is surfaced the same way.

Integration, `apps/gateway/tests/integration/oauth-as/` (the real composition
root on the `:memory:` store, the in-process `FakeIdp`, the instance's HTTP
surface as one `fetch`):

- **`mcp-client-flow.test.ts`** (4) — **the official `@modelcontextprotocol/client`
  with nothing configured but the door's URL**: the `401` challenge, the two
  discovery documents and the registration, in that order; the authorization
  request it builds (S256, `mgmt`, the resource, its state); sign-in at the
  IdP and the consent screen; the code exchange; the door opens; the access
  token expires and **the client renews by itself**, the refresh token
  rotated; the user revokes and the client is sent back to the browser; a
  refusal reaches it as `access_denied`.
- **`credential-separation.test.ts`** (19) — **the three real credentials on one
  instance**: a delegated token at `/mcp` → `wrong-credential-kind`; a
  mission token at `/mcp/manage` → `wrong-credential-kind`; a web session at
  `/mcp/manage`, as cookie or as bearer → `wrong-credential-kind`; `401` with
  the RFC 9728 challenge for no credential, an unknown one or a look-alike;
  the delegated token **cannot open the interface** (as a bearer or in the
  session cookie: issue or revoke a mission, revoke a delegation, answer a
  consent) **nor answer a request**, even next to the creator's cookie.
- **`http-surface.test.ts`** (66) — each endpoint: status, headers, CORS for the
  protocol endpoints and none of their answers changed by a cookie; **the
  path-less resource document is the execution door's** (no authorization
  server, the bearer goes in the header); body limits; rate limits per
  address, and **a bounded number of registrations per hour for the whole
  instance, whatever the addresses**; **the per-client token limit**: a
  public client's budget cannot be spent by somebody who only knows its id,
  a confidential client is limited per client once its secret matched and a
  wrong secret spends nothing of it; the policies over HTTP (closed; a hosted
  client waits, a user cannot approve it, an operator does; disabling ends
  the delegations and the user finds it in their audit); the authorization
  endpoint (sign-in and back to the same request; pages that never redirect;
  errors through the redirect **only once signed in and for an approved
  client**; the bootstrap operator refused); the decision (once, not from
  another session; a failure while the delegation is recorded is a page,
  logged, and nothing is granted); **the door reads the client's status at
  every call** — a client that is no longer approved is refused although its
  delegation and its token are live; a replayed refresh token over HTTP, and
  the refresh reuse window (two simultaneous renewals); revocation; metadata
  documents fetched only for a signed-in user; **no code, token or verifier in
  the logs**.
- **`routes.test.ts`** (16) — the route table the tests drive is the
  application's: each path's route file delegates to the handler named, the
  path-less `/.well-known/oauth-protected-resource` included (it delegates
  to the discovery of the authorization server).
- **`tests/integration/store/oauth-clients.test.ts`** (16) — what migration `0006`
  added: client kinds and operator decisions, unused clients deleted,
  revocation reasons, `revokeIfActive` once, token activity, the lookups a
  replay is recognised with, the sweep that keeps a rotated token while its
  successor lives, and **the audit scope**: a user sees the entries of their
  own delegations only.

Structural: `tests/unit/server/auth/mutation-guard.test.ts` holds the three
human mutations of the module (consent answer, delegation revocation, client
decision) to the one guard, and the three protocol endpoints to **reading no
session** (an operator's cookie from a foreign origin changes nothing);
`tests/unit/app/app-guard.test.ts` and `admin-guard.test.ts` cover the
Delegations and OAuth clients pages and their routes;
`tests/integration/audit/admin-mutations.test.ts` classifies every public
method of the module's classes and drives the four that leave an entry.

## Scenarios — Management door tools

> Covers: spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §2.4 (a
> delegated token issues missions within the user's authority, executes
> nothing, grants nothing; "every mission issued this way is visible to the
> user and marked as delegated"), §4.1 bis (what the management surface
> exposes and never exposes), §6 (three credentials, traceable delegated
> tokens, surface rate limits), §7.10, §8 (the delegated client in the audit),
> §10 "OAuth delegation then issuance of a mission by an MCP client within the
> user's authority and refusal beyond it". Handbook [[management-door]].

Unit, beside the code (`apps/gateway/src/server/management/`):

- **`tools.test.ts`** (32) — **every act is the delegating user's**: each of the
  seven methods calls the mission service with `{ id: actor.userId }`;
  `issue` carries `{ delegation: { id, clientId } }`. **A draft beyond the
  authority is refused before anything is issued, with the uncovered list**,
  and does not spend the mutation budget; a draft refused for another reason
  says so. The mutations share one budget per delegation
  (`delegation:<id>:mutations`); reads and previews take none. A mission that
  is not the user's is `mission-not-found` for read, rotate and revoke.
  **The mission service decides last** — its answer after the door's own
  check stands: `issue` refuses a draft the preview accepted when the
  authority changed in between (`draft-refused`, with the service's
  preview); an issuance outcome the door does not know is a failure, not an
  answer made up here; `rotate` answers not-found or inactive for a mission
  `get` saw active, and `revoke` not-found, each with the service's refusal.
  **Rotation reaches only the missions this delegation issued**: a mission
  the user issued in the interface, one another client issued and one an
  earlier delegation of the same client issued are each refused
  `mission-not-issued-here`, nothing rotated and no budget spent; a mission
  of the calling delegation is rotated, the service told which delegation
  asks; the service's own `not-issued-by-delegation` reads as the same
  refusal; `revoke` still reaches every mission of the user; a listing says
  which missions the delegation issued (`issued_via.this_delegation`).
  **Every refusal code is in the handbook's table, and the table names no
  other** (the table of `docs/handbook/management-door.md` is read by the
  test). `get_catalog` names the providers when asked for one that does not
  exist. **Views**: the exact restriction of an owner and of a beneficiary; which
  env-qualified ids are usable (labelled resources, none, a provider that
  derives the environment); stale resources left out, hidden ones flagged;
  presets against the authority, judged with the mission module's own
  expansion on what the user holds (a base id of an env-scoped risk counts
  when one environment is held); env usability is `isResolvable` on the
  resources a mission can select, so a stale label does not count; the
  catalog flagged per connection; a mission view with its orphan reason —
  whether it can come back is the mission module's answer, for every cause —
  and never more of the token than the masked prefix.
  **Descriptions** state the rules of issuance (explicit RiskIds only, one
  connection per provider, a budget for every risk, labelled resources for
  env-qualified ids, the user is the creator and answers every request); the
  schemas refuse unknown keys; an answer is structured content and text, a
  refusal a tool error with its code.
- **`hard-deny.test.ts`** (16) — **structural**: the module's dependency type has
  exactly `admit`, `missions`, `catalog`, `rateLimit`, `build`, `logger`; no
  member of it is a service, module or repository of requests, budget,
  execution, connections, shares, groups, authority or the store
  (`Extract<Handed, Forbidden>` is `never`, with two controls that are not);
  the mission port has seven methods and no `setGate`, `duplicate`,
  `draftFrom`, `verifyToken`; no source file of the module imports a
  forbidden module, and the wiring imports only config, logging, management,
  missions and oauth-as; the tool table is the seven tools, none named after
  an act of a forbidden family; `ManagementTools` has one public method per
  tool; mutations are exactly issue, rotate, revoke.
- **`output-schemas.test.ts`** (10) — **the output schemas of the seven
  tools**: there is one per tool, and it is the one the tool definition
  carries; for each tool the schema is an object at the root and no level
  refuses a key it does not name (an answer may grow without breaking a
  client); the two answers that reveal a token name it and accept whatever
  else rides along; a refusal is not an answer — the schemas do not describe
  `{ error }`.
- **`door.test.ts`** (4) — `ManagementDoor` alone: a tool that throws is an
  `internal-error` tool result, logged with the tool and never with its
  arguments; a stateless exchange is a POST (`GET` and `DELETE` of a
  2025-era client are 405); an answer that does not match the advertised
  schema is refused by the SDK after the tool ran and leaves a trace without
  any value; an answer that matches is returned as the tool built it, extra
  keys included.

Integration (`apps/gateway/tests/integration/management/`, the real
composition root on the `:memory:` store with the shipped plugins and the
simulated IdP; the agent is the official MCP client holding a delegated token
obtained through registration, sign-in, consent and code exchange):

- **`management-door.test.ts`** (34)
  - The door lists exactly the seven tools, each with a description and a
    strict input schema; the server instructions carry the rules.
  - **Reading**: an owner sees their connections with the whole catalog,
    resources and presets, experimental plugins hidden unless asked; which
    env-qualified risks are usable on a labelled connection, an unlabelled
    one and a provider that derives the environment; **a beneficiary sees the
    shared connection with the exact restriction, and nothing else of the
    owner**; someone who holds nothing sees nothing; `get_catalog` with and
    without a connection, refused for an unknown provider or a connection
    that is not the user's.
  - **Preview**: what passes, nothing written; what exceeds as an answer;
    a preset alone bounded by the authority; an env-qualified id with no
    labelled resource; an unknown key, a missing budget and a wildcard.
  - **Issue within the authority**: the delegating user is the creator, the
    mission records the delegation, `issuedVia` names the client, the token
    is revealed once with the kit (which names both doors), the Delegations
    listing shows it, **the audit entry names the user and the client**, the
    secret is in no log and no entry, **the token opens `/mcp` and is refused
    `wrong-credential-kind` at `/mcp/manage`**, and the agent reads the
    mission back marked as its own.
  - **Refusal beyond the authority**, whole, with the uncovered list; nothing
    issued, no entry. A share narrowed after the consent narrows what the
    agent may issue. Another user's connection cannot be named by id or by
    provider.
  - **Rotate and revoke**: the old token stops, entries name the client; a
    second revocation changes and writes nothing; a revoked mission is not
    rotated. **An orphaned mission** is shown `orphaned` with its cause and
    `can_come_back`, is not rotated, serves again when the share is made
    again, and can be revoked. Another user's mission is not found, not
    rotated, not revoked. A revoked delegation stops the agent at its next
    call.
  - **Rotation scope**: an agent authorized twice holds two delegations; the
    mission the human issued in the interface (`issued_via: null`) and the
    one the first delegation issued (`this_delegation: false`) are refused
    `mission-not-issued-here` to the second, no token in the answer, no
    `mission-rotated` entry, and both mission tokens keep working at `/mcp`;
    the delegation rotates its own mission, and the human rotates theirs in
    the interface. `MissionService.rotate` asked in the name of another
    delegation answers `not-issued-by-delegation`, whoever calls it.
  - **Never exposed**: for each family of spec §4.1 bis — answering a
    request, gates, budgets, connections, shares, groups, tool execution —
    plausible tool names are neither listed nor callable; a real provider
    tool of the execution door is not callable here, and a delegated token is
    refused at `/mcp`. A mission token and a human session get
    `wrong-credential-kind` with no challenge.
  - **Rate limits**: the surface limit is per delegation, through the
    `RateLimiter` port, on `mgmt:`-prefixed keys, and does not slow another
    delegation; mutations have their own budget, which a refused draft does
    not spend.
- **`hard-deny.test.ts`** (6) — **structural, on the object graph**: from the
  door, its tools and its handler of the real root, no module, service,
  handler table or repository of the instance is reachable (the same walk
  finds the token verifier from the gate, which does hold it); the mission
  port is a frozen object of exactly seven bound methods; the catalog port is
  data with no function and no plugin; the rate-limit port only reaches
  prefixed keys.
- **`output-schemas.test.ts`** (9) — **every answer matches its advertised
  output schema**, through the official MCP client, which validates
  `structuredContent` against the `outputSchema` of `tools/list`:
  `tools/list` advertises an object output schema for each of the seven
  tools; `list_my_connections` for an owner (with and without experimental
  providers), a beneficiary and somebody who holds nothing; `get_catalog`
  for every provider of the instance, alone and against a connection;
  `preview_policy` for a draft that passes, one beyond the authority, a
  preset alone, an unresolvable environment and an unknown risk;
  `issue_mission`, `list_my_missions`, `rotate_mission_token` and
  `revoke_mission` — the token arrives, every state reads, an expired
  mission included; every tool was covered. **A refusal is unaffected by the
  output schema**: a tool error keeps its `{ error }` content, whole, and
  arguments that fail the input schema are still a tool error with the
  validation message.

Also: `tests/integration/audit/admin-mutations.test.ts` classifies the
public methods of `ManagementTools` and `ManagementDoor` and drives the three
mutations; `tests/integration/store/delegations.test.ts` covers `issuersOf`
and `rotateSuccessorOf`; the refresh reuse window is in
`src/server/oauth-as/token-service.test.ts` and
`tests/integration/oauth-as/http-surface.test.ts`
([Authorization server](#scenarios--authorization-server-of-the-management-door)).

## Scenarios — Demo mode

> Covers: handbook [[demo-mode]] ("Safety", "Run it"); ADR [[local-demo-mode]]
> D6, D7. Spec [`vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §10 ("no
> integration test against a real provider, ever": every provider request of
> the demo is answered from memory). `apps/gateway/tests/integration/demo/`.
> Only `demo-smoke` and the last four tests of `demo-safety` need a build;
> `demo-vercel` and `build-stamp` need none and open no listener.

- **`demo-smoke.test.ts`** (17; needs a build) — **the command, as a human
  runs it**: spawns `tests/demo/main.ts` on a port the system picks
  (`DEMO_PORT=0`, `DEMO_SKIP_BUILD=1`) and waits for the printed tour; the
  tour carries the banner, the three accounts, the `ssh -L` line and the list
  of things to try; the demo identity provider answers discovery and JWKS
  over HTTP under `/__demo/idp` with a prefixed issuer; an anonymous visitor
  is sent to `/login`; **Alice signs in through the account picker**, the
  redirects of `/auth/login` followed by hand with a cookie jar (authorize →
  picker → `account=alice` → `/auth/callback` → `/missions`, session cookie
  set); `/missions`, `/accounts`, `/waiting`, `/activity`, `/shares`,
  `/delegations`, `/admin/provider-apps` and `/admin/groups` answer 200 with
  one seeded item each; `tools/list` on `/mcp` with the mission token the
  tour prints lists GitHub and Redis tools; **the seeded team**: `/mcp/catalog`
  with the named token the tour prints answers `kind: named`, `holder: CI
runner` and Alice as creator, and with Alice's own token `kind: member`;
  the Audit page filtered on each holder lists its calls; **Bob signs in**,
  finds "Ship the billing page" under "Shared with you" with Alice's email,
  and its page has the teammate's sentence, "Replace my key" and the machine
  key, none of the creator's acts and no secret; `/mcp` without a token is 401;
  `SIGTERM` ends the process with code 0, deletes the data directory and
  closes the listener.
- **`demo-safety.test.ts`** (13) — **the guards**: `assertDemoAllowed` passes
  in a development or test shell and refuses `NODE_ENV=production`,
  `VAUBAAN_CONFIG_FILE` and `VAUBAAN_PUBLIC_URL`; `DEMO_PORT` (default, a
  port, `0`, garbage). **One prefix**: the identity provider and the
  installation page are under `/__demo`. **No seam in the application**: no
  route file under `src/app` serves the prefix; nothing under `src/` names
  `__demo` or `tests/demo`; a normally composed root holds the GitHub
  plugin's own credential spec (its `installUrl` answers github.com), an
  https public URL and no identity provider. **The build** (needs one): the
  standalone output holds `server.js`, **no file from a `tests/` or `demo/`
  folder** and no file naming `/__demo`; the route manifest has `/missions`
  and no route under the prefix.
- **`demo-vercel.test.ts`** (3) — **the simulated Vercel**, the shipped
  plugin run against the demo's `fetch` double: a connection made with the
  tour's values discovers one team and its two projects, each with the
  three environments (`prod`, `preview`, `development`); a REST tool
  (`vercel__list_env_vars`) and a rewrapped tool
  (`vercel__list_deployments`) are answered from memory; discovery never
  dials the provider — every recorded call was answered by a simulated
  route.
- **`build-stamp.test.ts`** (10) — **`npm run demo` serves the existing build
  only when it is the build of the sources as they are**
  (`tests/demo/build-stamp.ts`), in a temporary tree: an unstamped build is
  never fresh; a stamped one stays fresh while no input changed, whatever
  the file dates (the stamp is a digest of contents); an application source,
  a workspace package, a plugin catalog or the lockfile changing makes the
  next start build again, and so does a file added with the same contents;
  tests, dependencies and the build itself are not inputs; a matching stamp
  without a build is not fresh; the stamp lives inside the build directory
  and the inputs it names exist.

## Scenarios — Release

> Covers: [`coding-workflow.md`](../workflow/coding-workflow.md#release)
> ("One version", "Versioning policy", "Pre-releases", "Cutting a release");
> ADR [[repository-layout-and-contribution-workflow]], amendment "Release"
> (R1 to R3, R6, R10). No network, no registry, no tag: the workflow itself
> (`.github/workflows/release.yml`) is checked with `actionlint` and by its
> dry run, not by this suite.

- **`scripts/release-lib.test.mjs`** (50) — **versions**: a final version and
  the three pre-release stages parse; a leading `v`, two or four numbers, a
  leading zero, `rc1`, `preview.1`, build metadata and free text are refused;
  semver precedence orders `alpha < beta < rc < final` and numbers
  numerically. **Image tags**: a final release gives `<version>`,
  `<major>.<minor>` and `latest`; **a pre-release gives its own version only**.
  **A tag**: must name the version of `package.json` and be the highest
  release among the existing tags (tags that are not releases, such as
  `v4-final`, are ignored). **Release notes from a fixture changelog**
  (`scripts/fixtures/CHANGELOG.fixture.md`): the body of a dated section
  without its heading, stopping at the next section and never taking the
  compare links; a final release also carries the sections of its
  pre-releases, newest first; **refused**: a version whose changes are still
  titled `Unreleased`, a missing section, an undated one, an empty one, notes
  longer than GitHub accepts; a heading inside a code block is not a section.
  **Preparing**: `Unreleased` moves under a dated heading and an empty
  `Unreleased` stays above it, the rest of the file untouched; the compare
  links are rewritten from the repository URL already in the file; an empty
  `Unreleased` is refused, except to promote a release candidate unchanged;
  an existing section, a missing `Unreleased` and a bad date are refused.
  **Manifests**: `package.json` changes by its version only; both copies of
  the root version change in the lockfile. **The two scripts, end to end**,
  in a temporary copy of the files they touch: `release:prepare` edits the
  three files and prints the tag command without running it; a refusal
  writes nothing; the plan of a tag writes the notes and the workflow
  outputs, fails while the changes are still titled `Unreleased` and when the
  tag is not the version of `package.json`; a dry run previews `Unreleased`
  with a warning. **The repository itself** has an `Unreleased` section and a
  version the scripts accept.
- **`apps/gateway/tests/unit/structural/version-single-source.test.ts`** (4) —
  **one source for the version**: what `next.config.ts` stamps into the build
  is the `version` of the root `package.json`; that version fits the
  telemetry pattern of `gateway_version` and the release scripts' spelling;
  the lockfile carries the same value.
- **`apps/gateway/tests/unit/app/build-footer.test.tsx`** (3) — the footer
  renders the version and commit it is given, the stamps of the build by
  default (the ones `/healthz` answers), and `dev` for an unstamped build.

## Scenarios — The structural suite and the dependency audit

> Covers: spec §10 "Structural", §6; ADR [[dependency-audit-gate]];
> [`coding-workflow.md`](../workflow/coding-workflow.md) ("Dependency
> audit", "Refreshing the base image digests"). The structural tests live
> where their harness lives — under `apps/gateway/tests/unit/structural/`
> for the ones that read the source or the schema, under
> `tests/integration/**` or beside the code for the others, each described
> in its subsystem's section above. `manifest.ts` is what makes them one
> suite.

- **`apps/gateway/tests/unit/structural/index.test.ts`** (one group of
  tests per invariant; the count is in the table above) — **the index of
  the structural suite**. `manifest.ts` lists the invariants (an id, a
  statement, a source, the proofs: a file and the titles of the tests that
  prove it); 26 invariants today, `every-refused-call-audited` the latest
  (a call refused because a decision stage threw leaves its entry; proofs in
  the two `pipeline.test.ts`). **A proof is a test the runner will run**:
  the proof files are read with the TypeScript parser, so a title that
  survives only in a comment or in a string that is not a title, or only on
  `it.skip` / `it.todo`, does not count; a proof that runs on a condition
  (`describe.skipIf`, `it.runIf`) must say so in the manifest
  (`conditional`: what it needs and who runs it with that), and one that
  says so must be one; a shell proof (the image smoke test) is still matched
  by the message of its step. The index fails when an invariant has no
  proof, a proof names a file that is gone or a title no running test of its
  file carries, a test file
  of the folder is in no invariant, a bullet of the spec's "Structural" list
  has no invariant (or the manifest quotes a bullet the spec no longer has),
  a proof file is not one a test runner or CI runs, or the threat-model
  handbook cites an invariant or a test file that does not exist.
- **`shipped-presets.test.ts`** (4 per shipped plugin, plus 1) — read from
  the plugins the image ships (`compose/shipped-plugins.ts`): each ships at
  least one preset with at least one entry, every entry is a risk of its own
  catalog, no preset id or entry says "everything" (no wildcard), each
  preset is named once.
- **`persisted-enumerations.test.ts`** (10) — what the schema itself holds:
  `share_restrictions` and `mission_policy` store one row per risk and their
  `risk_id` refuses the empty string and any `*`; no table has a column that
  could hold a preset; `missions.status` cannot hold `orphaned` (the two
  triggers of migration `0007` exist).
- **`no-arguments-in-logs.test.ts`** (3) — with the TypeScript parser, every
  logger call of the server and of the packages it runs (`.debug`, `.info`,
  `.warn`, `.error`, `.child`, and a local name bound to one of them): none
  is handed — in its message when it is built from values, or after it — an
  identifier named like call arguments, a request body or a secret, unless
  the name says it is a non-secret derivative (`token_prefix`,
  `arguments_hash`), and a key named like a derivative does not vouch for a
  value named like the secret itself; no object that carries them handed
  over whole (`headers`, `request`, `call`, `ctx`), as a value, a shorthand
  or a spread; no `reason` of a refused call (the lines whose reason is a
  closed code are listed one by one); the scan finds log calls at all, and
  planted offences are reported through the scan itself.
- **`plugin-identifier-tests.test.ts`** (one test per plugin directory,
  plus 2) — the directories under `plugins/` are read, the template among
  them, and every shipped plugin is one of them; each has a test file that
  feeds hostile identifiers (the dot segment, an encoded or separator form)
  to both its classifier and its executor, **read with the TypeScript
  parser**: the hostile values are string literals of the code, the
  classifier and the executor are called, and at least one test of the file
  runs — an import, a comment, the word in a title or a skipped test is not
  a proof, which the suite checks on a planted file (ADR
  [[plugin-identifiers-one-grammar-for-classify-and-execute]]; the proofs
  themselves are the plugins' own suites).
- **`base-images-pinned.test.ts`** (5) — the Dockerfile builds every stage
  from the one `NODE_IMAGE`, pinned by full version and digest; **nothing
  else runs in the build**: no `# syntax=` frontend unless pinned the same
  way (the file declares none), and every `COPY --from=` / `--mount=…from=`
  names a stage of the file, never an image; the Compose
  file pins every image it pulls; the documentation quotes the pinned
  versions; the refresh procedure is written where the pins point to.
- **`scripts/audit-gate.test.mjs`** (29) — **the dependency audit gate**
  (`scripts/audit-gate.mjs`, CI job `audit`), on recorded outputs, no
  network: `parseAuditOutput` reads each advisory once by its GHSA id and a
  clean report as none, tells a registry that does not answer from an
  advisory by what `npm audit` printed, and does not take a broken tree or an
  unknown output for an outage — **nor silence**: no output at all, or
  blank output, is `unreadable` (`npm` missing, killed or crashed), a broken
  gate and not a registry that did not answer; **one advisory per package**:
  the same id on a second package is kept, not dropped, so each pair meets
  the allowlist; `decide` fails on a gated advisory the
  allowlist does not name (a low one is a notice), **gates a severity it
  does not know** (`unknown`, an empty one, `severe`, `CRITICAL` — only
  `info` and `low` are notices), passes an allowlisted one
  until its review date, that day included, fails once the date has passed,
  does not let an id allowlisted for one package cover another, and reports
  entries that matched nothing without failing; `parseAllowlist` accepts an
  entry with an id, a package, a reason and the two dates and refuses the
  malformed ones, a duplicate id and another shape; **the allowlist the
  repository ships** is valid, gives no entry more than about a quarter, and
  is what `ci.yml` runs.

## Out of scope for these tests

- **E2E** (Playwright, container smoke) → [`e2e-tests.md`](./e2e-tests.md).
- **UI rendering** (React components) — static-markup suites only
  (`apps/gateway/tests/unit/app/design-system.test.tsx`, the components of the
  design system; `field.test.tsx`, label binding; `build-footer.test.tsx`, the
  build stamps; `risk-explain.test.tsx`, the slug, the vector strip, the
  three-line risk, help and callout); how a component looks is judged on the
  gallery (`/design`), and the pages are walked by Playwright.
- **Accounting rules** (period arithmetic, quota/rate comparison, gates) —
  "Scenarios — Budget and sessions" tests them against the store's
  `decideAndDecrement`.
- **A real identity provider** (Google, Entra ID, Keycloak) — never in the
  automated suite; the manual check is in [`e2e-tests.md`](./e2e-tests.md).

## Known gaps

- **The collector's SQL against PostgREST** — `schema.sql` is checked as text
  here and was applied by hand to a local PostgreSQL 17 (insert as `anon`,
  refused read / update / delete, constraints, limits, the view). Nothing in
  the suite runs a database server, and no test goes through PostgREST: the
  `PT429` → HTTP 429 mapping and the bulk-insert request are taken from its
  documentation.
- **Telemetry classes of the shipped plugins** — the outcome reduction is
  tested on a fixture plugin, and the plugin suites of the template, Vercel,
  Upstash Redis and Cloudflare DNS assert that a provider failure is thrown
  with its status (never returned as an `isError` result); no test runs
  each shipped plugin's failures through the reduction and asserts the class
  they end in.
- **Group shares through the management door** — `list_my_connections` and
  issuance are driven for an owner and for the target of a direct share; the
  union with a group share reaches the door through the same
  `AuthorityService` and is tested there ([Authority, shares,
  groups](#scenarios--authority-shares-groups)), not once more through MCP.
- **The production fetcher of Client ID Metadata Documents over a real TLS
  connection** — the address filter, the lookup and the document rules are
  tested; a successful fetch from a public host is not (no test reaches a
  network), and the feature is off by default.
- **Claude Code against a running instance** — never done, by a human or an
  agent. The automated suites drive the door with the official MCP client
  instead (here against the handler, in the browser smoke over HTTP); the
  first session with Claude Code is step 6 of the cutover acceptance
  scenario ([`e2e-tests.md`](./e2e-tests.md)).
- **A ref the connection never discovered** is rejected with the
  classifier's sentence, not with `resource-not-in-mission`; only the
  rejection is tested.
- **Closing an orphaned mission as an owner of the connection** (spec
  §2.3) is not built; the creator's "Revoke" is tested.
- **A user removed from the IdP** — there is no deprovisioning feed:
  `users.status = 'removed'` is set by an operator's deactivation only
  (tested end to end, [Human authentication](#scenarios--human-authentication)),
  and nothing syncs with the IdP's directory.
- **A real Entra ID tenant above the group limit** — the overage markers are
  taken from the provider's documentation and replayed by the simulated IdP;
  no test signs in against Entra ID.
- **The cost of the door's authority re-check** is measured, not asserted
  (`door-latency.bench.test.ts`, skipped by default).
- **`ssh__exec` end to end** — `execute` runs over a fake `SshTransport`,
  and the real transport is driven against an in-process ssh server on
  loopback (`host-key-pinning.test.ts`). No test reaches a real host, by
  design.

## References

- Spec: [`../spec/vaubaan-gateway.md`](../spec/vaubaan-gateway.md) (v5),
  [`../spec/gateway-risk-model.md`](../spec/gateway-risk-model.md) (risk
  model).
- Handbooks: [[policy-engine]], [[plugin-sdk]], [[gateway-core]],
  [[configuration]], [[store]], [[authentication]], [[budget-and-sessions]],
  [[connections]], [[missions]], [[execution-door]], [[authority]],
  [[requests]], [[audit]], [[telemetry]], [[management-door]],
  and the provider handbooks under
  [`../handbook/providers/`](../handbook/providers/README.md).
- CI workflow: [`../workflow/coding-workflow.md`](../workflow/coding-workflow.md)
  — `npm run ci` runs type-check + lint + format:check + build + test (this
  suite).
- E2E (Playwright, container smoke): [`./e2e-tests.md`](./e2e-tests.md).
