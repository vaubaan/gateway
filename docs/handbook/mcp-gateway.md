---
title: MCP gateway
status: current
date: 2026-06-13
tracks:
  - packages/mcp-gateway/src/
  - packages/web/src/app/mcp/route.ts
  - packages/web/src/app/.well-known/oauth-protected-resource/route.ts
  - packages/web/src/lib/gateway/build.ts
---

# MCP gateway — `@vaubaan/mcp-gateway` + `/mcp` route

Le hot-path produit. Auth → context load (cached) → classify call → evaluate
capability → mint upstream JIT → executeCall → audit → JSON-RPC response.

Le moteur d'évaluation lui-même vit dans `@vaubaan/policy-engine` (cf.
[`policy-engine.md`](./policy-engine.md)) — ce handbook documente
l'orchestration côté gateway.

## Layout

```
packages/mcp-gateway/
  src/
    cache.ts        # MemoryCacheClient + RedisCacheClient (Upstash)
    audit.ts        # AuditWriter interface + Memory/Supabase impls + hashArguments
    errors.ts       # JSON-RPC error/success builders + AuthError class
    gateway.ts      # McpGateway class — orchestration
    index.ts        # barrel
  tests/
    unit/gateway.test.ts               (14 tests)
    integration/lifecycle.test.ts      (7  tests)
    integration/scope-injection.test.ts (3  tests)
```

Et côté Next.js :

```
packages/web/src/
  app/mcp/route.ts          # POST handler
  lib/gateway/build.ts      # buildGateway() — wires Supabase + GitHub adapter
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

Méthodes supportées (`gateway.ts:177-200`) :

- `initialize` → renvoie `protocolVersion: '2024-11-05'`, capabilities,
  `serverInfo: { name: 'vaubaan-gateway', version: '0.1.0' }`.
- `tools/list` → tools du `granted set` filtrés par
  `filterAvailableTools` + stripping des args injectés (cf. infra).
- `tools/call` → classify → evaluateCapability → executeCall + audit.
- `ping` → no-op.
- Autres méthodes → `-32601 'method not supported'`.

Préfixes provider supportés (`providerFor`, `gateway.ts:391-398`) :
`github__` / `vercel__` / `supabase__` / `railway__` / `bash__`. Un
tool sans préfixe matching → denied avec audit row.

## Decision flow détaillé

```
POST /mcp
  │
  ├─[parse body → JsonRpcRequest]
  │
  ├─[McpGateway.authenticate(authHeader)]                    (gateway.ts:128)
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
  ├─[McpGateway.handle(ctx, req)]                            (gateway.ts:177)
  │     switch req.method
  │       case 'tools/list' →                                (gateway.ts:202)
  │         for each provider (github/vercel/supabase/railway/bash) :
  │           filterAvailableTools(ctx.capabilities, adapter)
  │           if !adapter.selfContained :
  │             injectionPlanFor(provider, {bindings, vercelTeamId})
  │             stripInjectedArgs(tool, plan)
  │       case 'tools/call' →                                (gateway.ts:229)
  │         provider = providerFor(toolName)
  │         if adapter.selfContained :                       (gateway.ts:253)
  │           classify → evaluateCapability → executeCallSelfContained
  │         else :
  │           check provider_admins[provider].status === 'connected'
  │           args = mergeInjectedArgs(rawArgs, injectionPlan)
  │           classify(toolName, args, bindings) → Capability | denied
  │           evaluateCapability(ctx.capabilities, required) → allowed | denied
  │           if denied → audit(decision='denied', denial_reason) ; return -32603
  │           if allowed :
  │             if ctx.access_token.single_use :
  │               consumeAccessToken(id) → atomic UPDATE, lose-race rejects
  │               cache.del(vaubaan:ctx:<prefix>)            (gateway.ts:346)
  │             admin = adapter.loadProviderAdmin(orgId, provider)
  │             result = adapter.executeCall(admin, binding, tool, args)
  │             audit(decision='allowed', capability_matched, upstream_latency_ms)
  │             return rpcSuccess(id, shapeMcpResult(result))
  │
  └─[JSON response — always 200, JSON-RPC error envelope encodes denies]
```

Single-use consumption order : burn **avant** l'appel upstream
(`gateway.ts:338-348`). Un upstream qui échoue ne laisse pas le token
réutilisable.

## Cache

`packages/mcp-gateway/src/cache.ts` exporte :

- `MemoryCacheClient` — `Map<string, {value, expiresAt}>`. Per-process. Default fallback.
- `RedisCacheClient` — Upstash REST over fetch (no SDK dep). Production hot-path.

`buildCacheClient(env)` lit `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
Absent ⇒ Memory.

Key naming :

- `vaubaan:ctx:<api_key_prefix>` → AccessTokenContext, TTL 60s.

Invalidation explicite :

- `cache.del('vaubaan:ctx:<prefix>')` après PATCH access_token,
  rotate-key, ou single-use consume côté gateway (`gateway.ts:278/346`).
- Les routes REST mutantes (`/api/v1/tokens/[tokenId]/rotate-key`,
  PATCH access_token) sont responsables de l'invalidation post-mutation.

## Audit

`SupabaseAuditWriter` écrit dans `audit_log` via le service_role client. Une
row par MCP call (allowed + denied). Failure côté audit log loud-but-degrade :
on log l'erreur et on renvoie la réponse au client (le call n'est pas avorté).
Cf. `audit` méthode (`gateway.ts:413-439`).

Colonnes peuplées :

- `organization_id`, `project_id`, `access_token_id`
- `tool_name`, `arguments_hash` (16 hex via `hashArguments`)
- `capability_matched` (notation shorthand de la cap qui a autorisé,
  ou `null` si denied)
- `decision: 'allowed' | 'denied'`, `denial_reason`
- `upstream_latency_ms` (ms entre admin loaded et executeCall return)
- `client_ip`, `client_user_agent`

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

L'authentification, classify, evaluateCapability, single-use consume
et audit row passent par le même chemin que les non-self-contained
(cf. `gateway.ts:253-299`). Seules l'injection de scope et le check
`provider_admin` diffèrent.

> **Status bash** : l'adapter `bash` n'est pas encore wiré dans
> `buildGateway()` (cf. `lib/gateway/build.ts:251-254`) — les
> invocations passent par le REST shortcut `/api/v1/bash-bindings/:id/run-tool`.
> Le pattern self-contained sera son chemin quand le dispatch arrive.

## Sécurité

- L'`api_key_hash` n'est lu QUE par le gateway via service_role client. La RLS
  côté app web ne l'expose à personne.
- Cache Redis ne contient PAS de token upstream en clair. Seul l'AccessTokenContext
  (sans `access_token_encrypted`) est caché.
- Le GitHub installation token (mint JIT 1h) est _éphémère_ — pas de cache
  persistant en clair en MVP (peut être ajouté en v1.1 — cache 50min Upstash
  pour éviter le mint à chaque call ; cf. ADR [[redis-cache-upstash-with-memory-fallback]]).

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

- Unit (`packages/mcp-gateway/tests/unit/gateway.test.ts`) : 14 tests —
  auth flow (Bearer parsing, cache hit/miss, expired/consumed), tools/list
  filter, allow/deny dispatch, audit row shape, self-contained branch.
- Integration (`packages/mcp-gateway/tests/integration/`) :
  - `lifecycle.test.ts` (7) — access token lifecycle, rotation,
    revocation, provider disconnect, single-use consume.
  - `scope-injection.test.ts` (3) — `tools/list` strip + `tools/call`
    merge avec injection plan résolu depuis les bindings.

## Références

- Spec : [`docs/spec/vaubaan-gateway.md`](../spec/vaubaan-gateway.md) §6.2 (hot path), §7 (engine), §8 (single-use).
- Spec capabilities : [`docs/spec/gateway-capability-model.md`](../spec/gateway-capability-model.md) §3, §6, §7.
- Handbooks voisins : [[policy-engine]] (4 modules purs cités ici), [[web-app]] (`/mcp` route wrapper + `buildGateway()`), [[capability-policy-and-approvals]] (mint flow amont), [[bash-provider]] (self-contained pattern).
- ADRs : [[redis-cache-upstash-with-memory-fallback]], [[mcp-only-mvp-scope]], [[programmatic-access-token-minting]].
