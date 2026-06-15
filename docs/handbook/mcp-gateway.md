---
title: MCP gateway
status: current
date: 2026-06-15
tracks:
  - packages/mcp-gateway/src/
  - packages/web/src/app/mcp/route.ts
  - packages/web/src/app/.well-known/oauth-protected-resource/route.ts
  - packages/web/src/lib/gateway/build.ts
---

# MCP gateway — `@vaubaan/mcp-gateway` + `/mcp` route

Le hot-path produit du modèle v4 risk-based (spec
[`gateway-risk-model.md`](../spec/gateway-risk-model.md) §8). Chaque
access token porte `accepted_risks: RiskId[]` + `denied_risks: RiskId[]`.
À chaque `tools/call`, le gateway classifie la requête en **slices**,
intersecte avec le **risk catalog** du provider, et refuse si un risque
touché n'est pas accepté (strict-fail).

```
auth → load context (cached) → parse RPC → route by method →
  classifyV4 slice(s) → risksTouchedByAll → check ⊆ accepted_risks →
  mint upstream JIT → executeCall → audit → respond.
```

Le moteur de décision pure vit dans `@vaubaan/policy-engine` (cf.
[`policy-engine.md`](./policy-engine.md)) — ce handbook documente
l'orchestration côté gateway.

## Layout

```
packages/mcp-gateway/
  src/
    cache.ts          # MemoryCacheClient + RedisCacheClient (Upstash)
    audit.ts          # AuditWriter interface + Memory/Supabase impls + hashArguments
    errors.ts         # JSON-RPC error/success builders + AuthError class
    gateway.ts        # McpGateway class — orchestration v4
    risk-gateway.ts   # evaluateCallForToken + denyResponseBody (helpers purs)
    index.ts          # barrel
  tests/
    unit/gateway.test.ts             (14 tests)
    unit/risk-gateway.test.ts        (6  tests)
    integration/lifecycle.test.ts    (7  tests)
    integration/scope-injection.test.ts (3 tests)
```

Et côté Next.js :

```
packages/web/src/
  app/mcp/route.ts                                   # POST handler /mcp
  app/.well-known/oauth-protected-resource/route.ts  # RFC 9728 probe
  lib/gateway/build.ts                               # buildGateway() — wires adapters + catalogs + cache + audit
```

## Endpoint

```
POST /mcp HTTP/1.1
Host: vaubaan.com
Authorization: Bearer vbn_live_<8-char prefix>_<32-char secret>
Content-Type: application/json

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": { "name": "github__create_pull_request", "arguments": {...} },
  "id": 42
}
```

Méthodes supportées (`gateway.ts:177-196`) :

- `initialize` → renvoie `protocolVersion: '2024-11-05'`, capabilities,
  `serverInfo: { name: 'vaubaan-gateway', version: '0.1.0' }`.
- `tools/list` → liste **coarse** par provider (cf. §tools/list ci-dessous).
- `tools/call` → classifyV4 → evaluateCall → executeCall + audit.
- `ping` → no-op.
- Autres méthodes → `-32601 'method not supported'`.

Préfixes provider supportés : `github__` / `vercel__` / `supabase__` /
`railway__` / `bash__`. Un tool sans préfixe matching → denied avec audit row.

## Decision flow détaillé

```
POST /mcp
  │
  ├─[parse body → JsonRpcRequest]
  │
  ├─[McpGateway.authenticate(authHeader)]                  (gateway.ts:128)
  │     ├─ parse `Bearer vbn_live_<prefix>_<secret>`
  │     ├─ reject vbn_mgmt_* (admin credential, wrong audience)
  │     ├─ cache GET vaubaan:ctx:<prefix>
  │     │     ├─ hit  → re-vérifie argon2id verify(hash, raw) + status
  │     │     │        + assertNotExpired + assertNotConsumed → ctx
  │     │     └─ miss → contextLoader.loadAccessTokenForAuth(prefix) →
  │     │              argon2id verify → loadAccessTokenContext(tokenId) →
  │     │              cache.set(ctx, ttl=60s)
  │     └─ touchLastUsed(tokenId) (fire-and-forget)
  │
  ├─[McpGateway.handle(ctx, req)]                          (gateway.ts:177)
  │     switch req.method
  │       case 'tools/list' →                              (gateway.ts:207)
  │         for each provider where ctx.accepted_risks targets it :
  │           include adapter.availableTools (no per-tool filter)
  │           if !adapter.selfContained :
  │             plan = injectionPlanFor(provider, {bindings, vercelTeamId})
  │             if plan : stripInjectedArgs(tool, plan)
  │       case 'tools/call' →                              (gateway.ts:243)
  │         provider = providerFor(toolName)
  │         catalog  = cfg.catalogByProvider[provider]
  │         plan     = injectionPlanFor(provider, {bindings, vercelTeamId})
  │         args     = mergeInjectedArgs(rawArgs, plan)
  │         verdict  = evaluateCallForToken({
  │                      tool, args, bindings: ctx.bindings,
  │                      token: { id, accepted_risks, denied_risks },
  │                      adapter: { classifyV4 }, catalog
  │                    })
  │         switch verdict.kind
  │           'no-catalog'      → audit denied + 403 (fail-closed)
  │           'classify-denied' → audit denied + 403 (plugin reason)
  │           'deny'            → audit denied(slices, missing_risks)
  │                              + 403 'risk-not-accepted' body
  │           'allow' :
  │             if ctx.access_token.single_use :
  │               consumeAccessToken(id) → atomic, lose-race rejects
  │               cache.del(vaubaan:ctx:<prefix>)
  │             admin = adapter.loadProviderAdmin(orgId, provider)
  │             result = adapter.executeCall(admin, binding, tool, args)
  │             audit allowed(slices_executed, risks_touched,
  │                            token_accepted_risks_snapshot, upstream_latency_ms)
  │             return rpcSuccess(id, shapeMcpResult(result))
  │
  └─[JSON response — always 200, JSON-RPC error envelope encodes denies]
```

Single-use consumption order : burn **avant** l'appel upstream
(`gateway.ts:389-399`). Un upstream qui échoue ne laisse pas le token
réutilisable.

### `denyResponseBody` shape (spec §8)

```jsonc
{
  "error": "risk-not-accepted",
  "missing_risks": ["github.branch-protection-write"],
  "executed_slices": ["github.repo[sbw-vaubaan/gateway].branch-protection[main].W"],
  "hint": "this access token is not granted [github.branch-protection-write]. Re-mint a token with this risk accepted, or restrict the operation.",
}
```

L'agent (Claude Code, Cursor, etc.) lit `missing_risks` et soit re-mint
auprès de son orchestrateur (Story Dev), soit renvoie la balle au humain
via le long-poll endpoint.

## `tools/list` — coarse filter

Volontairement large : on liste **tous les tools** d'un provider dès que
le token a au moins un `accepted_risk` qui cible ce provider (préfixe
`<provider>.` ou `<provider>[`). Trade-off explicité spec §A6 : un tool
peut apparaître en liste et 403 au call si la slice exécutée touche un
risk non accepté. **Coarse mais prévisible** — l'agent reçoit une raison
explicite (`risk-not-accepted` + `missing_risks`) plutôt qu'un tool
silencieusement absent.

Scope-injection s'applique avant retour : si le projet a 1 binding pour
le provider, `stripInjectedArgs` retire `owner/repo`, `projectId`,
`project_ref`, `teamId` du `inputSchema` (cf.
[`policy-engine.md`](./policy-engine.md) §scope-injection). Les adapters
`selfContained: true` (bash/ssh) sautent l'injection — credentials
chargées per-call depuis `ssh_bindings`.

## Catalogue chargement (boot)

Le wrapper `buildGateway()` (`lib/gateway/build.ts`) consomme
`getCatalog(provider)` du loader `lib/risk-catalog/loader.ts` qui import
les catalogues TS de chaque provider et les indexe une fois par runtime.
Un catalogue absent au call → verdict `no-catalog` → 403 fail-closed.
Cf. [`policy-engine.md`](./policy-engine.md) §Wiring côté gateway.

## Cache

`packages/mcp-gateway/src/cache.ts` exporte :

- `MemoryCacheClient` — `Map<string, {value, expiresAt}>`. Per-process. Default fallback.
- `RedisCacheClient` — Upstash REST over fetch (no SDK dep). Production hot-path.

`buildCacheClient(env)` lit `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
Absent ⇒ Memory.

Key naming :

- `vaubaan:ctx:<api_key_prefix>` → AccessTokenContext (avec
  `accepted_risks` + `denied_risks` + `bindings` + `provider_admins`),
  TTL 60s.

Invalidation explicite :

- `cache.del('vaubaan:ctx:<prefix>')` après PATCH access_token,
  rotate-key, ou single-use consume côté gateway
  (`gateway.ts:336/399`).
- Les routes REST mutantes (`/api/v1/tokens/[tokenId]/rotate-key`,
  PATCH access_token) sont responsables de l'invalidation post-mutation.

## Audit

`SupabaseAuditWriter` écrit dans `audit_log` via le service_role client. Une
row par MCP call (allowed + denied). Failure côté audit log loud-but-degrade :
on log l'erreur et on renvoie la réponse au client (le call n'est pas avorté).
Cf. `audit` méthode (`gateway.ts:471-499`).

Colonnes v4 :

- `organization_id`, `project_id`, `access_token_id`
- `tool_name`, `arguments_hash` (16 hex via `hashArguments`)
- `slices_executed: Slice[] | null` — slices émises par `classifyV4`
  (forme structurée, sérialisable JSON).
- `risks_touched: RiskId[]` — sortie de `risksTouchedByAll` (vide si
  classify-denied ou deny pré-classify).
- `token_accepted_risks_snapshot: RiskId[]` — snapshot du token au moment
  du call. Indispensable pour la reproductibilité forensique (le token
  peut être revoked / re-minted entre temps).
- `decision: 'allowed' | 'denied'`, `denial_reason`
- `upstream_latency_ms` (ms entre admin loaded et executeCall return)
- `client_ip`, `client_user_agent`

> Les trois champs `slices_executed`, `risks_touched`,
> `token_accepted_risks_snapshot` sont les **nouveautés v4** par rapport
> à v1 (qui stockait `capability_matched`). Five Eyes (2026-05) + NIST AI
> RMF Agentic Profile exigent traçabilité 100% par action — la slice
> capture le détail technique, le risk capture l'intention métier.

Le marker `denial_reason = 'rest-bypass'` (cf. bash provider) identifie
les rows qui n'ont pas traversé la pipeline `/mcp` policy mais le REST
shortcut. Pratique pour ségréger une fois le wiring `/mcp` bash en place.

## Self-contained adapters

Pattern pour les providers dont les credentials ne vivent pas sur
`provider_admins` org-scoped (ex : bash où chaque host_slug a sa propre
clé SSH stockée sur `ssh_bindings`).

Marqueurs `UpstreamAdapter` (`gateway.ts:86-105`) :

- `selfContained: true` — le gateway skip `provider_admins.status`
  check + `loadProviderAdmin` + scope-injection (auto-fill/strip).
- `executeCallSelfContained(ctx, tool, args)` — reçoit l'`AccessTokenContext`
  complet pour résoudre per-call les credentials/permissions internes.

L'authentification, classifyV4, evaluateCall, single-use consume et audit
row passent par le même chemin que les non-self-contained
(`gateway.ts:317-374`). Seules l'injection de scope et le check
`provider_admin` diffèrent.

> **Status bash** : l'adapter `bash` n'est pas encore wiré dans
> `buildGateway()` (cf. `lib/gateway/build.ts:251-254`) — les
> invocations passent par le REST shortcut `/api/v1/bash-bindings/:id/run-tool`.
> Le pattern self-contained sera son chemin quand le dispatch arrive.

## Long-poll mint (`?wait=25`)

L'endpoint `GET /api/v1/mgmt/tokens/pending/:approval_id?wait=25` bloque
côté serveur jusqu'à décision OU 25 s (spec v4 §11). Permet à l'agent
d'attendre une approval channel (manual / telegram / email) sans
busy-loop. Détails :

- Wait cap côté serveur : 25 s (sous le mur Vercel Edge 30 s et
  Cloudflare 100 s origin idle).
- Poll interne DB toutes les 500 ms (MVP — switch en
  `pg_notify` / Postgres LISTEN à terme si les métriques le justifient).
- Le SDK agent encapsule le re-poll jusqu'au wall-clock global (par
  défaut 15 min = TTL de l'approval).
- Réponses : 200 (decided, retourne `api_key` une fois si approved) ;
  202 (still pending au timeout) ; 404 (approval inconnue) ; 410 (expired).

L'implémentation vit côté Next.js
(`packages/web/src/app/api/v1/mgmt/tokens/pending/[id]/route.ts`),
**hors du `McpGateway` core** — c'est un endpoint d'approval, pas de
dispatch MCP. Documenté pour cohérence : c'est le contre-poids amont au
`tools/call` strict-fail (au lieu de tenter un step-up runtime, l'agent
re-mint via cet endpoint).

Cf. [`approvals.md`](./approvals.md) §Long-poll pour le détail des
transitions d'état.

## Sécurité

- L'`api_key_hash` n'est lu QUE par le gateway via service_role client. La RLS
  côté app web ne l'expose à personne.
- Cache Redis ne contient PAS de token upstream en clair. Seul l'AccessTokenContext
  (sans `access_token_encrypted`) est caché.
- Le GitHub installation token (mint JIT 1h) est _éphémère_ — pas de cache
  persistant en clair en MVP (peut être ajouté en v1.1 — cache 50min Upstash
  pour éviter le mint à chaque call ; cf. ADR [[redis-cache-upstash-with-memory-fallback]]).
- Strict-fail = **pas de step-up runtime**. Un token immuable, aucune
  race condition d'approval mid-flow (spec §8).

## Client compatibility — Claude Code OAuth probe

Claude Code (and other MCP clients suivant la spec auth) probent
`/.well-known/oauth-protected-resource` au connect pour découvrir un
serveur OAuth. Sur 404 (notre état initial), Claude Code régresse côté
client : il n'envoie plus le `Authorization: Bearer vbn_live_*` configuré
dans `.mcp.json` — cf. [anthropics/claude-code#59467](https://github.com/anthropics/claude-code/issues/59467).

Pour court-circuiter : `packages/web/src/app/.well-known/oauth-protected-resource/route.ts`
répond 200 en RFC 9728 avec `authorization_servers: []` et
`bearer_methods_supported: ["header"]`. Le client lit "pas d'OAuth, juste
des bearers" et retombe sur le header statique.

> Si un client reste bloqué sur le flow OAuth malgré la metadata, le
> workaround côté lanceur Claude Code est :
>
> ```bash
> claude --permission-mode bypassPermissions \
>        --strict-mcp-config \
>        --mcp-config .mcp.json
> ```
>
> `--strict-mcp-config` désactive les sources MCP implicites (config user)
> et force l'usage exclusif du fichier passé en argument.

## Tests

- Unit (`packages/mcp-gateway/tests/unit/`) :
  - `gateway.test.ts` (14) — auth flow (Bearer parsing, cache hit/miss,
    expired/consumed), tools/list filter coarse (un provider apparaît
    iff un accepted_risk cible), allow/deny dispatch, audit row shape
    (slices_executed, risks_touched, snapshot), self-contained branch.
  - `risk-gateway.test.ts` (6) — `evaluateCallForToken` pure : allow,
    deny missing risks, classify-denied, no-catalog, multi-slice union,
    denied_risks shadow.
- Integration (`packages/mcp-gateway/tests/integration/`) :
  - `lifecycle.test.ts` (7) — access token lifecycle, rotation,
    revocation, provider disconnect, single-use consume.
  - `scope-injection.test.ts` (3) — `tools/list` strip + `tools/call`
    merge avec injection plan résolu depuis les bindings.

## Références

- Spec : [`docs/spec/gateway-risk-model.md`](../spec/gateway-risk-model.md)
  §8 (decision flow), §11 (long-poll), §12 (audit shape).
- Handbooks voisins : [[policy-engine]] (6 modules purs cités ici),
  [[web-app]] (`/mcp` route wrapper + `buildGateway()`),
  [[approvals]] (mint flow amont + channels + long-poll endpoint),
  [[bash-provider]] (self-contained pattern).
- ADRs : [[redis-cache-upstash-with-memory-fallback]],
  [[mcp-only-mvp-scope]], [[programmatic-access-token-minting]].
