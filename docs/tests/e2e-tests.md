---
title: E2E tests
status: planned
date: 2026-05-22
tracks:
  - playwright.config.ts
  - packages/web/tests/e2e/
---

# E2E tests — Playwright contre vrais clouds

Posture "no-mock" héritée de v3 (cf. spec §14.3).

## Statut MVP

Le harness Playwright est wired (`playwright.config.ts`) avec deux projets :

- `smoke` — checks Playwright is alive, no creds needed.
- `e2e-real-clouds` — scénarios contre `sbw-vauban-test` (org GitHub dédiée).

Aucun scénario n'est implémenté en MVP. Les scénarios listés ci-dessous sont
le **plan de test** validé en spec ; ils seront codés en Phase 5
(post-déploiement staging).

## Setup pré-requis (manuel, opérateur Vauban)

- Org GitHub dédié `sbw-vauban-test` avec un repo `playground` créé à la main.
- GitHub App "Vauban Gateway (test)" installée sur l'org.
- `.env.test` (gitignored) :
  ```bash
  GH_TEST_APP_ID=...
  GH_TEST_APP_PRIVATE_KEY=...
  GH_TEST_INSTALLATION_ID=...
  E2E_BASE_URL=https://staging.vauban.run     # ou http://localhost:3000
  E2E_USER_EMAIL=...                           # un compte test signup
  E2E_SUPABASE_URL=...
  E2E_SUPABASE_SERVICE_ROLE_KEY=...
  ```

## Scénarios planifiés

### Scenario 1 — Onboarding GitHub

```
1. User signup via magic-link Supabase (capture le link en SMTP test inbox)
2. Crée org 'sbw-vauban-test'
3. Clic Connect GitHub → simule callback OAuth en injectant
   installation_id directement (test mode)
4. Assert provider_admins row created with status='connected'
```

### Scenario 2 — Project + binding

```
1. Crée project 'playground'
2. POST binding github 'sbw-vauban-test/playground'
3. Assert validateBinding live returns ok=true
4. Assert provider_bindings row created
```

### Scenario 3 — Bot creation

```
1. POST /api/v1/bots {name: 'claude-dev', roleIds: [github:developer]}
2. Assert api_key visible 1× in response body
3. Assert api_key_prefix correct, api_key_hash non-null in DB
```

### Scenario 4 — Allow flow

```
1. Use api_key in real MCP client (or curl simulation)
2. Send tools/call github__create_pull_request {head:'feature/test-X', base:'main'}
3. Assert PR créée côté GitHub avec actor='Vauban Gateway[bot]'
4. Assert audit_log row decision='allowed', role_matched='github:developer'
```

### Scenario 5 — Deny flow

```
1. Same bot, tools/call github__push_files {branch:'main', ...}
2. Assert JSON-RPC error with denial_reason mentioning 'feature/*'
3. Assert audit_log row decision='denied'
```

### Scenario 6 — Revocation

```
1. POST /bots/:id/rotate-key → new api_key
2. Old api_key → 401
3. New api_key → 200
4. PATCH bot status='revoked' → new api_key also → 401
```

## Sweeper

Cron nightly qui ratisse les PRs/branches `vauban-e2e-*` >24h sur GitHub.
Exit code 0/1/2/3 selon nb orphelins (CI alerting).

Pas implémenté en MVP — voir `scripts/e2e-sweeper.ts` (vide).

## Conventions

Ressources transitoires nommées `vauban-e2e-<testfile-hash6>-<run-uuid8>`.
