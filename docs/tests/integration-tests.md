---
title: Integration tests
status: current
date: 2026-05-22
tracks:
  - packages/policy-engine/tests/
  - packages/providers/github/tests/
  - packages/mcp-gateway/tests/
---

# Integration tests

Vitest, ~1s total. No browser, no Supabase server, no real GitHub.

## Coverage

| Suite                                                      |    Tests | Latency |
| ---------------------------------------------------------- | -------: | ------: |
| `packages/policy-engine/tests/unit/operators.test.ts`      |       20 |   ~10ms |
| `packages/policy-engine/tests/unit/evaluate.test.ts`       |       12 |   ~15ms |
| `packages/policy-engine/tests/unit/dsl.test.ts`            |        7 |   ~10ms |
| `packages/policy-engine/tests/unit/tools-filter.test.ts`   |        3 |    ~8ms |
| `packages/providers/github/tests/unit/adapter.test.ts`     |       18 |   ~50ms |
| `packages/providers/vercel/tests/unit/adapter.test.ts`     |        7 |    ~7ms |
| `packages/providers/supabase/tests/unit/adapter.test.ts`   |        5 |   ~12ms |
| `packages/providers/railway/tests/unit/adapter.test.ts`    |       11 |   ~10ms |
| `packages/mcp-gateway/tests/unit/gateway.test.ts`          |       13 |  ~520ms |
| `packages/mcp-gateway/tests/integration/lifecycle.test.ts` |        7 |  ~500ms |
| **TOTAL**                                                  | **~108** |   ~1.3s |

## Run

```bash
npm run test                    # full suite, headless
npm run test:watch              # file-watcher mode for local dev
npx vitest run packages/policy-engine    # one package
```

## Scénarios — Policy engine

- **operators.test.ts** : property tests pour les 7 opérateurs sur strings,
  numbers, booleans, undefined values, regex invalides, array OR semantics.
- **evaluate.test.ts** : default deny, allow basic, allow with constraint,
  constraint mismatch → actionable suggestion, deny override allow,
  priority tie-break, target resolution via bindings, missing args =
  deny, first allow wins, provider filtering.
- **dsl.test.ts** : version != 1 reject, rule without tool/tool_matches
  reject, unknown operator reject, github:developer shape parses OK.
- **tools-filter.test.ts** : keeps tools matched by at least one allow,
  drops tools only mentioned by deny, empty roles → empty.

## Scénarios — GitHub adapter

- `authorizationUrl` returns the App install URL with state nonce.
- `handleCallback` extracts installation_id, rejects missing.
- `mintUpstreamToken` signs JWT (real `jose` lib), exchanges via mocked fetch,
  handles 4xx errors gracefully.
- `executeCall` dispatches `github__list_branches` → `octokit.rest.repos.listBranches`,
  unknown tool throws.
- `resolveTarget('project.repos', bindings)` returns concrete `resource_ref`s,
  `resolveTarget('*', ...)` returns wildcard.
- `github__mint_install_token` (ADR mint-install-token-runner-credential):
  `purpose=clone` → body `contents:read`; `purpose=push` → body
  `contents:write + pull_requests:write + metadata:read`; `repoFullName`
  outside project bindings throws; omitting `repoFullName` mints for every
  github binding; unknown `purpose` throws before any HTTP call.

## Scénarios — Railway adapter

- `mintUpstreamToken` returns the stored token when not near expiry ; throws
  when no token.
- `mintUpstreamToken` refreshes (mocked `backboard.railway.com/oauth/token`,
  Basic auth + `resource=` audience) when within 60s of expiry, and calls
  `persistRefresh` with the new pair ; falls back to the stale token when no
  client credentials are configured.
- `executeCall` forwards `tools/call` to `mcp.railway.com` with the `railway__`
  prefix stripped ; surfaces upstream JSON-RPC errors + HTTP errors.
- `validateBinding` rejects a non-UUID ref ; accepts a UUID and confirms token
  liveness via `whoami`.
- `resolveTarget('project.railway', bindings)` returns railway refs only ;
  `'*'` returns wildcard.

## Scénarios — MCP gateway

- Authenticate valid api_key → context returned.
- Authenticate missing/malformed → AuthError thrown.
- Authenticate cache hit re-verifies hash (defensive against cache poisoning).
- `tools/list` returns filtered tools per Bot roles.
- `tools/call` allowed → routes to adapter + audit row.
- `tools/call` denied (constraint mismatch) → JSON-RPC error with actionable
  Suggestion line + audit row decision='denied'.
- `tools/call` explicit deny rule → blocks even when allow could match.
- `tools/call` disconnected provider → denies with explicit reason.
- Unknown method → -32601.
- `initialize` returns MCP server info.

## Scénarios — Lifecycle integration

- Auth → tools/list → tools/call allowed → audit row written.
- Constraint mismatch → denied with branch-rename suggestion.
- Bot revocation → next call 401.
- api_key rotation → new key works, old key 401.
- Provider disconnect → calls targeting that provider denied.
- Explicit deny rule blocks `github__delete_file`.
- Arguments hash computed (16 hex chars) and stored.

## Hors-scope ces tests

- E2E avec vrai GitHub (cf. `docs/tests/e2e-tests.md`).
- RLS sur Supabase (vit dans `supabase/migrations/0001_init.sql`, à
  tester en Phase 5 avec un Supabase test container).
- UI rendering (cf. Playwright `smoke.spec.ts` — à drafter en Phase 5).
