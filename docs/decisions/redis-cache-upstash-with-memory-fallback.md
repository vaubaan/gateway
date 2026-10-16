---
title: Cache hot-path — Upstash Redis + fallback in-memory
status: superseded
date: 2026-05-22
superseded-by: pivot-v4-to-v5-on-prem-mission-tokens
superseded-date: 2026-10-12
---

> **Superseded on 2026-10-12** by [[pivot-v4-to-v5-on-prem-mission-tokens]]. Legacy v4 decision kept for history; body unchanged.

# Cache hot-path — Upstash Redis + fallback in-memory

## Contexte

Le hot-path `/mcp` doit résoudre, à chaque call :

- `api_key_prefix → bot, project, organization, roles, bindings, provider_admin`.

Faire ce lookup en DB à chaque MCP call ≈ 5-6 queries Supabase / call,
~50ms de latence ajoutée, et un quota PostgREST consommé pour rien. Le
spec §4.3 fixe la cible p50 < 50ms côté gateway _hors upstream_ — il
faut un cache.

## Décision

**Cache "context complet par api_key_prefix" en Upstash Redis (TTL 60s)
avec fallback in-memory si Redis indisponible.**

- Key : `vaubaan:ctx:<api_key_prefix>` (le prefix est suffisant — le hash
  est revérifié sur cache hit avant d'accepter le call).
- Value : objet JSON sérialisé `{ bot, project, org, roles, bindings,
provider_admin (sans tokens en clair) }`. **Aucun token en clair n'est
  stocké en Redis.** Les tokens upstream sont mintés JIT à chaque call
  autorisé (ou pris du cache GitHub-spécifique cf. ci-dessous).
- TTL : 60s. Invalidation explicite sur write côté admin (PATCH bot,
  PATCH role, DELETE provider_admin, etc.) via `redis.del` ciblé.

**Cache spécifique GitHub installation token** (séparé) :

- Key : `vaubaan:ghtok:<installation_id>` → installation token (string).
- TTL : 50min (l'installation token GitHub vit 1h ; marge de 10min).
- Justification : le mint de l'installation token est cher (~150ms : JWT
  sign + POST GitHub) ; cacher 50min réduit la latence amortie.

Si Upstash est down ou non configuré (dev local sans `UPSTASH_REDIS_*`
env vars), le gateway tombe sur un **`Map<string, {value, expiresAt}>`
in-memory** mono-process. C'est suffisant pour dev local + acceptable en
prod (chaque Vercel function instance a son cache, donc le hit-rate
chute mais le system reste fonctionnel).

Implementation : `packages/mcp-gateway/src/cache.ts` exporte `CacheClient`
interface avec `get/set/del` async. Deux impls : `RedisCacheClient`
(production, lazy-loaded Upstash) et `MemoryCacheClient` (dev / fallback).

## Conséquences

**Positives :**

- **Latence amortie cible.** Cache hit ≈ 1-2ms vs 50ms DB roundtrip.
- **DB load réduite.** En régime nominal, 1 lookup DB toutes les 60s par
  Bot actif.
- **Fallback sain.** Le system marche sans Redis (dev, hors-prod) — un
  contributeur peut faire tourner les tests sans setup Upstash.
- **Invalidation simple.** Un seul key pattern par bot ; `redis.del` ciblé
  est trivial.

**Négatives :**

- **Fenêtre de 60s d'inconsistency** : si on PATCH un Bot et qu'on oublie
  l'invalidation explicite, le change met jusqu'à 60s à se propager.
  Mitigation : invalidation explicite obligatoire dans chaque route REST
  qui mute un objet du contexte, garde-fou via test integration.
- **Upstash dépendance externe en prod.** Si Upstash a un outage, fallback
  → in-memory par-instance → potentiel cache miss à chaque cold start
  Vercel function. Latence dégradée mais pas d'indisponibilité.
- **Pas de cache distribué sans Redis.** Une fonction Vercel A et B ont
  des caches in-memory séparés → le même api_key peut frapper la DB sur
  les deux instances. Acceptable.

## Alternatives rejetées

- **Supabase Realtime PG channels comme bus d'invalidation.** Rejeté en
  MVP : ajoute une couche de complexité (channels, subscriptions
  serverless) sans bénéfice immédiat. Reconsidérable si on tape sur de
  vrais scale issues.
- **Pas de cache du tout** (DB query à chaque call). Rejeté : viole la
  cible p50 < 50ms.
- **Cache côté gateway uniquement in-memory.** Rejeté pour prod
  multi-instance : hit-rate inacceptable, invalidation cross-instance
  impossible.
- **Cache du token upstream entier (pas seulement context).** Rejeté :
  stocker un access_token Vercel/Supabase en Redis (même chiffré)
  augmente la surface ; le cost de mint est typiquement bas (use direct
  pour Vercel, refresh dance pour Supabase). Seul GitHub bénéficie d'un
  cache du token upstream (cf. cache spécifique ci-dessus).
