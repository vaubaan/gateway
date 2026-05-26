---
title: MCP gateway
status: current
date: 2026-05-26
tracks:
  - packages/mcp-gateway/src/
  - packages/web/src/app/mcp/route.ts
  - packages/web/src/lib/gateway/build.ts
---

# MCP gateway — `@vaubaan/mcp-gateway` + `/mcp` route

Le hot-path produit. Auth → context load (cached) → policy evaluate → mint
upstream JIT → executeCall → audit → JSON-RPC response.

## Layout

```
packages/mcp-gateway/
  src/
    cache.ts        # MemoryCacheClient + RedisCacheClient (Upstash)
    audit.ts        # AuditWriter interface + Memory/Supabase impls
    errors.ts       # JSON-RPC error/success builders + AuthError class
    gateway.ts      # McpGateway class — orchestration
    index.ts        # barrel
  tests/
    unit/gateway.test.ts          (11 tests)
    integration/lifecycle.test.ts (7 tests)
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

Méthodes supportées :

- `initialize` → renvoie `protocolVersion`, capabilities, serverInfo.
- `tools/list` → renvoie les tools que les Roles de l'access token peuvent
  potentiellement appeler (static filter).
- `tools/call` → policy evaluate + dispatch + audit.
- `ping` → no-op.

## Decision flow détaillé

```
POST /mcp
  │
  ├─[parse body → JsonRpcRequest]
  │
  ├─[McpGateway.authenticate(authHeader)]
  │     ├─ parse `Bearer vbn_live_<prefix>_<secret>`
  │     ├─ cache GET vaubaan:ctx:<prefix>
  │     │     ├─ hit  → re-vérifie argon2id verify(hash, full) → ctx
  │     │     └─ miss → contextLoader.loadAccessTokenForAuth(prefix) →
  │     │              argon2id verify → loadAccessTokenContext(tokenId) →
  │     │              cache.set(ctx, ttl=60s)
  │     └─ touchLastUsed(tokenId) (fire-and-forget)
  │
  ├─[McpGateway.handle(ctx, req)]
  │     switch req.method
  │       case 'tools/list' → filterAvailableTools(roles, adapter.availableTools)
  │       case 'tools/call' →
  │         provider = parse 'github__'/'vercel__'/'supabase__'
  │         check provider_admins[provider].status === 'connected'
  │         evaluatePolicy(roles, bindings, {provider, tool, args})
  │         if denied → audit(decision='denied', denial_reason) ; return -32603
  │         if allowed →
  │           admin = adapter.loadProviderAdmin(orgId, provider)
  │           result = adapter.executeCall(admin, binding, tool, args)
  │           audit(decision='allowed', role_matched, upstream_latency_ms)
  │           return rpcSuccess(id, shapeMcpResult(result))
  │
  └─[JSON response]
```

## Cache

`packages/mcp-gateway/src/cache.ts` exporte :

- `MemoryCacheClient` — `Map<string, {value, expiresAt}>`. Per-process. Default fallback.
- `RedisCacheClient` — Upstash REST over fetch (no SDK dep). Production hot-path.

`buildCacheClient(env)` lit `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
Absent ⇒ Memory.

Key naming :

- `vaubaan:ctx:<api_key_prefix>` → AccessTokenContext, TTL 60s.

Invalidation explicite (à appeler depuis les routes REST mutantes) :

- `cache.del('vaubaan:ctx:<prefix>')` après PATCH access_token, PATCH role, etc.

## Audit

`SupabaseAuditWriter` écrit dans `audit_log` via le service_role client. Une
row par MCP call (allowed + denied). Failure côté audit log loud-but-degrade :
on log l'erreur et on renvoie la réponse au client (le call n'est pas avorté).

## Sécurité

- L'`api_key_hash` n'est lu QUE par le gateway via service_role client. La RLS
  côté app web ne l'expose à personne.
- Cache Redis ne contient PAS de token upstream en clair. Seul l'AccessTokenContext
  (sans `access_token_encrypted`) est caché.
- Le GitHub installation token (mint JIT 1h) est _éphémère_ — pas de cache
  persistant en clair en MVP (peut être ajouté en v1.1 — cache 50min Upstash
  pour éviter le mint à chaque call ; cf. ADR [[redis-cache-upstash-with-memory-fallback]]).

## Tests

- Unit (`packages/mcp-gateway/tests/unit/`) : 11 tests — auth flow, tools/list
  filter, allow/deny dispatch, audit row shape.
- Integration (`packages/mcp-gateway/tests/integration/`) : 7 tests — access
  token lifecycle, rotation, revocation, provider disconnect.
