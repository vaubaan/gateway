---
title: API key Bot — format `vbn_live_*` + argon2id hash, visible 1×
status: accepted
date: 2026-05-22
tracks:
  - docs/spec/vaubaan-gateway.md
  - packages/mcp-gateway/src/auth.ts
  - packages/shared/src/api-key.ts
---

# API key Bot — format `vbn_live_*` + argon2id hash, visible 1×

## Contexte

Chaque Bot porte une `api_key` que l'agent met dans son `mcp.json` :

```jsonc
{
  "mcpServers": {
    "vauban": {
      "url": "https://vaubaan.com/mcp",
      "headers": { "Authorization": "Bearer vbn_live_AbCd...XyZ" },
    },
  },
}
```

Choix à figer : format de l'api_key, méthode de hash, UX de révélation.

## Décision

**Format**

```
vbn_live_<8 char prefix>_<32 char random secret>
```

- Préfixe constant `vbn_live_` (9 chars) — convention Stripe-style ;
  `vbn_test_` pour les tests E2E.
- `<8 char prefix>` (8 chars) — **chargé en clair en DB dans `api_key_prefix`**.
  Sert au lookup du Bot au moment de l'auth (`bots.api_key_prefix` est
  indexé unique). Visible dans l'UI (préfixe pour identifier le Bot
  dans audit log).
- `<32 char secret>` (32 chars base62 random) — secret pur. Combiné au
  prefix, total entropy ≈ 32 × log2(62) ≈ 190 bits.

**Hash**

```ts
api_key_hash = argon2id(api_key, {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB — moderate
  timeCost: 2,
  parallelism: 1,
});
```

Paramètres conservateurs (OWASP 2023 recommends 19 MiB / 2 iter / p=1).
Stocké en `bots.api_key_hash text`.

**Lookup au hot-path**

1. Parse `Authorization: Bearer vbn_live_<prefix>_<secret>` → extract prefix.
2. `SELECT … FROM bots WHERE api_key_prefix = $1 AND status = 'active'`.
3. Si match, `argon2.verify(row.api_key_hash, full_api_key)`. Si fail → 401.
4. Cache `(api_key_prefix → bot context)` 60s (cf. [[redis-cache-upstash-with-memory-fallback]]).

**UX**

- Création : `POST /bots` retourne `{ bot, api_key }`. L'api_key est
  visible **1 seule fois** dans le response body et dans une modal UI
  "Copy this api_key now, it won't be shown again."
- Liste : seul l'`api_key_prefix` apparaît dans la UI (`vbn_live_AbCdEfGh`
  preview pour identification).
- Rotate : `POST /bots/:id/rotate-key` génère nouvelle api_key, invalide
  l'ancienne immédiatement (PATCH `api_key_hash` + `api_key_prefix` +
  invalidation cache).
- Révoke : `PATCH bots {status: 'revoked'}` → toutes les calls suivants 401.
- L'`api_key_hash` n'est jamais lu par l'app web — seul le service d'auth
  du gateway le lit, avec un service_role key séparé (cf. spec §3.3).

## Conséquences

**Positives :**

- **Lookup O(1)** via `api_key_prefix` indexé (UNIQUE) sans scanner toute
  la table `bots`.
- **Compromis DB read-only ≠ compromis api_keys.** Seul le `prefix` est
  en clair en DB ; le secret est argon2id-hashed.
- **UX familière** — pattern Stripe / OpenAI / etc., zero apprentissage
  pour les devs.
- **Rotation indolore.** L'ancien hash est écrasé, l'ancien prefix change
  → l'ancien api_key tape un `WHERE prefix = ...` qui ne retourne rien
  → 401.
- **Logs / metrics safe** : on log `api_key_prefix` uniquement (8 chars
  suffisent pour identifier le bot, insuffisant pour s'auth).

**Négatives :**

- **Argon2id coût CPU non-négligeable** au hot-path. ~10-30ms par verify.
  Mitigation : cache 60s sur `api_key_prefix → bot context`, donc 1
  argon2 verify toutes les 60s par bot actif. Acceptable.
- **api_key visible 1× = friction onboarding.** Si l'utilisateur ferme
  la modal sans copier, il doit rotater. Mitigation : modal UX très
  insistante (warning visuel + bouton Copy dédié).
- **Pas de scope par-api_key** (un api_key = un Bot = N Roles fixés). Si
  l'user veut un sous-scope plus serré ponctuellement, il crée un autre
  Bot. Pas de "key avec moins de droits que son bot". Volontaire —
  garde le mental model simple.

## Alternatives rejetées

- **JWT signé par Vaubaan au lieu de random api_key.** Rejeté : un JWT
  porte du state (claims) qui peut s'écarter de l'état DB ; révocation
  exige une blacklist ou un rotate de la signing key (cross-Bot
  impactant). Random api_key + DB lookup est plus simple.
- **bcrypt au lieu d'argon2id.** Rejeté : argon2id est l'algo moderne
  recommandé OWASP 2023+ ; bcrypt suffit techniquement mais on choisit
  argon2id pour le futurisme et la résistance GPU.
- **Hash plain SHA-256.** Rejeté : pas adaptive — un cluster GPU casse
  des millions d'api_keys/s par bruteforce sur le secret 32 chars. Argon2id
  est memory-hard.
- **Visible plusieurs fois (reveal toggle).** Rejeté : viole le principe
  "secrets in DB are non-recoverable" ; ouvre la porte à du paste-token
  flow accidentel via shoulder-surfing.
