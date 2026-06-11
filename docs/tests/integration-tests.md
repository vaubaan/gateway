---
title: Integration tests
status: current
date: 2026-06-11
tracks:
  - vitest.config.ts
  - packages/policy-engine/tests/
  - packages/providers/github/tests/
  - packages/providers/vercel/tests/
  - packages/providers/supabase/tests/
  - packages/providers/railway/tests/
  - packages/mcp-gateway/tests/
  - packages/web/tests/
  - packages/web/src/lib/bash/
  - packages/shared/src/
---

# Integration tests

Vitest, ~2s total. No browser, no Supabase server, no real GitHub /
Vercel / Supabase / Railway / SSH. La discovery est centralisée dans
`vitest.config.ts:22-28` :

```
packages/*/tests/unit/**/*.test.ts
packages/*/tests/integration/**/*.test.ts
packages/providers/*/tests/unit/**/*.test.ts
packages/*/src/**/*.test.ts
```

Env défaut : `SKIP_LIVE=1` injecté par le runner (`vitest.config.ts:21`) ;
les tests qui peuvent toucher de vrais clouds le respectent et `skip()`
en absence de la creds env vars.

## Coverage

| Suite                                                            |                Tests | Latency |
| ---------------------------------------------------------------- | -------------------: | ------: |
| `packages/policy-engine/tests/unit/evaluate.test.ts`             |                    8 |    ~5ms |
| `packages/policy-engine/tests/unit/policy.test.ts`               |                   12 |    ~7ms |
| `packages/policy-engine/tests/unit/scope-injection.test.ts`      |                   12 |    ~7ms |
| `packages/policy-engine/tests/unit/tools-filter.test.ts`         |                    4 |    ~5ms |
| `packages/providers/github/tests/unit/adapter.test.ts`           |                   25 |   ~50ms |
| `packages/providers/vercel/tests/unit/adapter.test.ts`           |                   18 |   ~15ms |
| `packages/providers/supabase/tests/unit/adapter.test.ts`         |                   11 |   ~10ms |
| `packages/providers/railway/tests/unit/adapter.test.ts`          |                   15 |   ~15ms |
| `packages/mcp-gateway/tests/unit/gateway.test.ts`                |                   14 |  ~600ms |
| `packages/mcp-gateway/tests/integration/lifecycle.test.ts`       |                    7 |  ~550ms |
| `packages/mcp-gateway/tests/integration/scope-injection.test.ts` |                    3 |  ~150ms |
| `packages/web/src/lib/bash/parse.test.ts`                        |                   11 |   ~12ms |
| `packages/web/src/lib/bash/exec.test.ts`                         |                    4 |    ~5ms |
| `packages/web/src/lib/bash/args.test.ts`                         |                    9 |    ~7ms |
| `packages/web/src/lib/bash/exec-host.test.ts`                    |                    7 |    ~6ms |
| `packages/web/tests/unit/api/members-post.test.ts`               |                    5 | ~1500ms |
| `packages/web/tests/unit/api/mgmt-tokens-delete.test.ts`         |          2 (skipped) |       — |
| `packages/web/tests/unit/api/tokens-rotate.test.ts`              |          2 (skipped) |       — |
| `packages/shared/src/api-key.test.ts`                            |                    5 |  ~120ms |
| `packages/shared/src/capability.test.ts`                         |                   28 |   ~10ms |
| **TOTAL**                                                        | **~202** (5 skipped) |     ~2s |

## Run

```bash
npm run test                              # full suite, headless
npm run test:watch                        # file-watcher mode for local dev
npx vitest run packages/policy-engine     # one package
```

## Scénarios — Policy engine

> Couvre : `docs/spec/gateway-capability-model.md` §3, §5, §6, §7 ;
> handbook [[policy-engine]].

- **`policy.test.ts`** (12) — `evaluatePolicy(caps, rules)` :
  default-deny, seed rules `*:*:*:read:* → allow` et
  `*:*:*:write:* → confirm`, deny explicite, specificity wins,
  priority desc tie-break, env-less cap → `env_pattern=*` only,
  `@prod` requiert `@prod`|`@*`, env différent → default-deny.
  - helpers `allCapsAllowed` / `confirmDecisions` / `denyDecisions`.
- **`evaluate.test.ts`** (8) — `evaluateCapability(granted, required)` :
  exact-tuple match → allowed, missing cap → reason actionable,
  filtre défensif env (`@prod` requis + `@staging` granted →
  denied ; env-less grant + `@prod` requis → denied), distinction
  level/provider, empty grant → `(none)`.
- **`tools-filter.test.ts`** (4) — `filterAvailableTools` :
  surface match env-less, ignore env du grant, provider mismatch,
  empty grant → empty.
- **`scope-injection.test.ts`** (12) — `injectionPlanFor` (github
  owner/repo, vercel projectId+teamId, supabase project_ref ; null
  si 0/2+ bindings, null si resource_ref malformé),
  `stripInjectedArgs` (retire properties + required, no-op si rien
  à injecter, no-mutate), `mergeInjectedArgs` (fill missing,
  caller-override wins, empty string = missing).

## Scénarios — GitHub adapter

> Couvre : handbook [[github-provider]] ; ADRs
> [[mint-install-token-credential]], [[oauth-app-install-per-provider]].

`adapter.test.ts` (25) :

- **authorizationUrl / handleCallback** (2) — install URL avec
  state nonce ; extraction `installation_id` ; rejet du callback
  sans `installation_id`.
- **mintUpstreamToken** (3) — JWT signing `jose` réel + échange
  fetch mocké ; fallback Bearer si pas d'installation_id mais
  access_token_encrypted ; throw si ni l'un ni l'autre + cas creds
  App manquantes.
- **executeCall** (2) — `github__list_branches` →
  `octokit.rest.repos.listBranches` ; unknown tool throws.
- **github\_\_mint_install_token** (6) — purpose=clone →
  `contents:read` ; purpose=push → `contents:write + pr:write +
metadata:read + workflows:write` ; `repoFullName` hors bindings
  → throw ; omit `repoFullName` → mint pour tous les bindings
  github ; unknown purpose → throw avant HTTP ;
  `installation_id` manquant → throw.
- **classifyGithub** (8) — read sur repo bindé →
  `repo/code:read` (env-less) ; PR read env-less ; write feature
  branch → `code:write@<branch>` ; write `@main` ; merge PR →
  `code:write@main` ; create_pull_request → `code:write@<head>` ;
  unbound repo → denied ; `toolCapabilities` surface env-less.
- **mint surface** (2) — `toolCapabilities('github__mint_install_token')`
  retourne les deux caps (clone + push).

## Scénarios — Vercel adapter

> Couvre : handbook [[vercel-provider]] ; ADRs [[rewrap-official-mcps]],
> [[vercel-augment-with-rest-tools]].

`adapter.test.ts` (18) :

- **mintUpstreamToken** (2) — retourne `access_token_encrypted` en
  Bearer ; throw si pas de token.
- **executeCall** (4) — forwards JSON-RPC `tools/call` avec
  prefix stripped + `teamId` auto-injecté ; respect d'un `teamId`
  explicite passé en args ; surface erreurs upstream JSON-RPC ;
  surface erreurs HTTP.
- **classifyVercel** (6) — account-level read →
  `runtime/account:read` env-less, no projectId required ;
  get_project → `project-settings:read` ; deploy to prod →
  `deployment:write@prod` ; upsert_env_var preview →
  `config:write@preview` ; update_project_settings →
  `project-settings:write` env-less ; deny si `projectId` non
  bindé.
- **Custom REST tools** (6) — `update_project_settings` PATCHes
  `/v9/projects/{id}` avec champs whitelistés + `teamId` query ;
  honore `teamId` explicite > admin.team_id ; throw si projectId
  manquant ; surfaces REST errors avec status. `upsert_env_var`
  POSTs `/v10/projects/{id}/env?upsert=true` avec body whitelisté.
  custom tools exposés dans `availableTools`.

## Scénarios — Supabase adapter

> Couvre : packages/providers/supabase/ (handbook absent — voir
> _Trous connus_).

`adapter.test.ts` (11) :

- **mintUpstreamToken** (1) — `access_token_encrypted` en Bearer.
- **executeCall** (3) — `supabase__get_project` →
  `/v1/projects/:ref` ; `supabase__execute_sql` POST
  `/database/query` ; unknown tool throws.
- **classifySupabase** (7) — `list_tables` → `db/tables:read@<env>`
  (env vient du binding) ; `execute_sql` → `db/rows:read@<env>`
  (MVP read-only) ; `get_advisors` → `db/rls:read@<env>` ;
  `get_project` → `db/project:read@<env>` ; read sans binding →
  denied ; unknown tool → denied ; binding `environment=null`
  → cap env-less.

## Scénarios — Railway adapter

> Couvre : handbook [[railway-provider]] ; ADR [[railway-rewrap-remote-mcp]].

`adapter.test.ts` (15) :

- **mintUpstreamToken** (3) — retourne stored token si pas near
  expiry ; throws si pas d'access token ; refresh quand dans les
  60s d'expiry (Basic auth + `resource=` audience) + persist via
  `persistRefresh` ; fallback stale token si pas de client creds.
- **executeCall** (3) — forwards JSON-RPC `tools/call` à
  `mcp.railway.com` avec prefix `railway__` stripped ; surfaces
  upstream JSON-RPC errors + HTTP errors.
- **validateBinding** (2) — rejette non-UUID ref ; accepte UUID +
  whoami liveness check.
- **classifyRailway** (7) — `whoami` → `runtime/account:read`
  (account-level, pas de binding check) ; `list-deployments` →
  `runtime/deployment:read` ; `redeploy` sur bound project →
  `runtime/deployment:write` ; `create-project` →
  `runtime/account:write` ; deny si `projectId` non bindé ; deny
  si unknown tool.

## Scénarios — MCP gateway

> Couvre : handbook [[mcp-gateway]] ; spec
> `docs/spec/vaubaan-gateway.md` §6.2, §7, §8.

`unit/gateway.test.ts` (14) :

- **authenticate** (6) — Bearer valide → context returned ;
  missing/bad header → AuthError ; cache hit re-vérifie hash
  (defense contre cache poisoning) ; rejet `vbn_mgmt_*` keys
  (auth /mgmt/\*, pas /mcp) ; rejet token past `expires_at` sur
  cold path.
- **tools/list** (1) — returns filtered tool list par capability set.
- **tools/call** (4) — routes through adapter + audit row carrying
  `capability_matched` ; write protected branch → denied (lack
  `code:write@main`) ; merge_pull_request denied (same reason) ;
  disconnected provider → deny + audit.
- **Unknown method** (1) → `-32601`.
- **initialize** (1) → MCP server info.
- **Single-use** (1) — premier matching call allowed + consumed ;
  second call rejected on `consumed (single-use)`.

`integration/lifecycle.test.ts` (7) :

- **Happy path** — auth → tools/list → tools/call allowed → audit
  row écrite (`capability_matched='github:repo/code:write@feature/x'`).
- **Protected branch** — write `@main` denied (granted set lacks
  `code:write@main`).
- **Revocation** — access token revoked → next call 401.
- **api_key rotation** — new key works, old key 401.
- **Provider disconnect** — calls targeting that provider denied.
- **merge_pull_request** denied : developer set lacks
  `code:write@main`.
- **Audit arg hash** — `arguments_hash` calculé (16 hex) et
  stocké.

`integration/scope-injection.test.ts` (3) :

- `tools/list` masque `owner+repo` quand le projet a exactement 1
  github binding.
- `tools/call` sans `owner/repo` réussit ; l'adapter reçoit les
  valeurs auto-injectées.
- Override caller pointant vers un autre repo → denied par policy
  (binding mismatch).

## Scénarios — Web REST routes

> Couvre : handbook [[web-app]] §Membership model, §Access token
> creation, §Ownership transfer.

`packages/web/tests/unit/api/`. Les routes Next.js sont importées
directement (pas de fetch), les supabase clients mockés.

- **`members-post.test.ts`** (5) — `POST /api/v1/members` : rejet
  unauth ; validation 400 (missing orgSlug, invalid email, missing
  body fields) ; 409 si user déjà membre.
- **`mgmt-tokens-delete.test.ts`** (2 — _skipped_) — `DELETE
/api/v1/mgmt/tokens/:id` : rejet unauth ; rejet d'un Bearer non
  mgmt. Skip raison : dépend d'un setup Bearer plus complet à
  débloquer.
- **`tokens-rotate.test.ts`** (2 — _skipped_) — `POST
/api/v1/tokens/:id/rotate-key` : rejet unauth 401 ; rejet
  malformed body 400. Skip raison : idem.

## Scénarios — Bash provider (lib)

> Couvre : handbook [[bash-provider]].

`packages/web/src/lib/bash/` (les `.test.ts` vivent à côté du
code) :

- **`parse.test.ts`** (11) — `parseAnnotatedBash` : happy path
  multi-rings ; chaque branche de rejet (`rings` manquant, ring
  inconnu côté tool, action invalide, `@vaubaan-arg` sans nom,
  pas de tool annoté) ; private helpers ignorés ;
  `@vaubaan-arg` typing (string/integer, required/optional,
  default=).
- **`exec.test.ts`** (4) — `buildToolInvocation` : base64 +
  `bash -s --` ; échappement POSIX single-quote ; args vides ;
  content multi-ligne ; intégration `parse → build`.
- **`args.test.ts`** (9) — `materializeArgs` : required + no
  default → error ; required + default → default (rescue) ;
  optional + default ; optional + no default → '' ; present
  raw stringify ; integer typing ; empty string treated as
  missing ; order positional.
- **`exec-host.test.ts`** (7) — `loadHostByIdInOrg` /
  `loadHostBySlugInOrg` + `execOnHost` : check org-scope ;
  bytea→PEM decode ; `sshExec` happy path ; propagation des
  erreurs SSH ; pas de host trouvé.

## Scénarios — Shared lib

> Couvre : `packages/shared/src/` — bibliothèque utilitaire
> partagée. Tests unitaires purs, listés ici pour exhaustivité du
> harness CI.

- **`api-key.test.ts`** (5) — `generateApiKey` / `parseApiKey` /
  `hashApiKey` / `verifyApiKey` ; preserve le prefix.
- **`capability.test.ts`** (28) — `parseCapability` (variantes
  notation : full, short, env-less, alias `*`, malformed) ;
  `formatCapability` round-trip ; `isGranted` exact-tuple match ;
  `Capability` type round-trip.

## Hors-scope ces tests

- **E2E avec vrais clouds** (Playwright) → cf.
  [`e2e-tests.md`](./e2e-tests.md).
- **RLS sur Supabase** — testée à `apply-prod` time côté
  `0001_init.sql` ; à porter en Supabase test container quand un
  cas d'usage l'exige.
- **UI rendering** (composants React) — pas wiré (config
  `environmentMatchGlobs: jsdom` prête côté `vitest.config.ts:30`
  pour `packages/web/tests/unit/components/**`).

## Trous connus

- ⚠️ **Supabase provider sans handbook** — les tests sont là
  (11 scénarios), mais aucun handbook `docs/handbook/supabase-provider.md`
  ne référence ce sous-système. Suggéré : `/handbook supabase-provider`.
- ⚠️ **`mgmt-tokens-delete` + `tokens-rotate`** sont _skipped_
  — setup auth Bearer à débloquer pour les ré-activer. Sans ça
  les routes mgmt/rotate sont couvertes seulement par le
  lifecycle integration (côté gateway, pas côté HTTP).
- ⚠️ **Spec bash** — le plugin `bash` est testé (31 scénarios
  côté `lib/bash/`) mais pas mentionné dans
  `docs/spec/gateway-capability-model.md`. Aligner la spec sur le
  code via `/spec gateway-capability-model`.
- ⚠️ **`approvals/` côté lib** (`packages/web/src/lib/approvals/`)
  — 6 modules (channel, manual, telegram, mint, decide, index),
  aucun test direct ; couverture indirecte via les routes
  `/api/v1/mgmt/tokens` et `/api/v1/integrations/telegram/webhook`
  (non testées en intégration côté Vitest). Candidat priorité
  haute.

## Références

- Specs couvertes : `../spec/vaubaan-gateway.md`, `../spec/gateway-capability-model.md`.
- Handbooks liés : [[policy-engine]], [[mcp-gateway]], [[github-provider]],
  [[vercel-provider]], [[railway-provider]], [[bash-provider]],
  [[capability-policy-and-approvals]], [[web-app]].
- Workflow CI : [`../workflow/coding-workflow.md`](../workflow/coding-workflow.md)
  — `npm run ci` lance type-check + lint + format:check + test (cette suite) + build.
- E2E (Playwright) : [`./e2e-tests.md`](./e2e-tests.md).
