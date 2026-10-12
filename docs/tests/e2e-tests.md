---
title: E2E tests
status: planned
date: 2026-05-22
tracks:
  - playwright.config.ts
  - apps/gateway/tests/e2e/
  - deploy/docker/smoke.sh
  - .github/workflows/ci.yml
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

## Setup pré-requis (manuel, opérateur Vaubaan)

- Org GitHub dédié `sbw-vauban-test` avec un repo `playground` créé à la main.
- GitHub App "Vaubaan Gateway (test)" installée sur l'org.
- `.env.test` (gitignored) :
  ```bash
  GH_TEST_APP_ID=...
  GH_TEST_APP_PRIVATE_KEY=...
  GH_TEST_INSTALLATION_ID=...
  E2E_BASE_URL=https://staging.vaubaan.com     # ou http://localhost:3000
  E2E_USER_EMAIL=...                           # un compte test signup
  E2E_SUPABASE_URL=...
  E2E_SUPABASE_SERVICE_ROLE_KEY=...
  # Railway (Auth app "Vaubaan Gateway (test)") :
  RAILWAY_CLIENT_ID=...
  RAILWAY_CLIENT_SECRET=...
  RAILWAY_REDIRECT_URI=https://127.0.0.1:3000/api/integrations/railway/callback
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
3. Assert PR créée côté GitHub avec actor='Vaubaan Gateway[bot]'
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

### Scenario 7 — Railway OAuth + rewrap (Phase 5+)

```
1. Clic Connect Railway → authorize backboard.railway.com (PKCE + resource binding)
2. Callback échange le code → provider_admins row railway, access+refresh+expires_at set
3. tools/list → 10 railway__ tools visibles selon le role
4. Bind project.railway (UUID), token railway:viewer → tools/call railway__list-projects
   → assert allowed + audit row
5. railway:viewer → tools/call railway__redeploy → assert denied (read-only)
6. railway:member → tools/call railway__accept-deploy → assert denied (default-deny, member ne grant pas ce tool)
7. railway:deployer → tools/call railway__accept-deploy sur project bindé → assert allowed
   (et railway:member + railway:deployer combinés → also allowed, par union d'allows)
8. Force expires_at dans le passé → next call déclenche un refresh (provider_admins
   access_token muté) → call OK
```

## v5 — Container smoke (P0.4, automated in CI)

> Covers: plan P0.4 DoD ("`docker compose up` serves the UI stub on the
> configured port; container exits with a named variable when config is
> incomplete"), spec §4.3, §6. Script `deploy/docker/smoke.sh <image>`, run
> by the `docker` job of `.github/workflows/ci.yml` after the image build
> and locally with `npm run docker:build && npm run docker:smoke`.

1. **Incomplete configuration** — `docker run` with only `VAUBAAN_PUBLIC_URL`
   exits non-zero (78) and stderr names `encryption.master_key` with
   `VAUBAAN_MASTER_KEY or VAUBAAN_MASTER_KEY_FILE`, `store.path` and
   `bootstrap_token`.
2. **http public URL** — a complete configuration with `http://` exits
   non-zero; stderr contains `public_url: must use https`.
3. **Complete configuration** — the container stays up and
   `GET /healthz` answers 200 `{"status":"ok",...}` within 30 s; the logs
   contain neither the master key nor the bootstrap token.
4. **Native addons** — `argon2` hashes and `libsodium-wrappers` loads inside
   the image (file tracing of prebuilt binaries).
5. **Non-root** — the process runs as uid 10001.

## Sweeper

Cron nightly qui ratisse les PRs/branches `vauban-e2e-*` >24h sur GitHub.
Exit code 0/1/2/3 selon nb orphelins (CI alerting).

Pas implémenté en MVP — voir `scripts/e2e-sweeper.ts` (vide).

## Conventions

Ressources transitoires nommées `vauban-e2e-<testfile-hash6>-<run-uuid8>`.
