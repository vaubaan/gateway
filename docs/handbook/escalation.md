---
title: Escalation — runtime channel for risk re-mint
status: current
tracks:
  - packages/web/src/lib/mint/child-mint.ts
  - packages/shared/src/risk.ts
  - packages/web/src/app/api/v1/tokens/mint/route.ts
  - packages/web/src/app/api/v1/tokens/preview/route.ts
  - docs/decisions/unified-tokens-delegation-chain-and-escalation-channel.md
  - docs/decisions/unified-gates-drop-confirm.md
last_synced: 2026-06-16
---

# Escalation — runtime channel for risk re-mint

> Successeur du handbook `approvals.md` (mint-time approval flow).
> Le 3-gate `allow/confirm/deny` et le flow `approval_requests` ont été
> droppés (ADR [unified-gates-drop-confirm](../decisions/unified-gates-drop-confirm.md)).
> Ce qui les remplace : un **escalation_channel** porté par le token,
> consulté **au runtime** quand un child reçoit un 403 `risk-not-accepted`.

## §1. Le contrat en 2 phrases

1. Un token est minté avec un set fermé `accepted_risks`. Au runtime,
   tout call qui touche un risk **hors** de ce set est refusé strict
   (403 / JSON-RPC error code `-32603`).
2. Si le token porte `context.escalation_channel`, l'agent peut POSTer
   à cet endpoint pour demander à son parent de le re-minter avec un
   scope élargi. Vaubaan ne proxy pas — c'est un endpoint HTTP libre
   que le parent qui mint configure.

## §2. Anatomie du `escalation_channel`

```ts
// packages/shared/src/types.ts (extrait)
type EscalationChannel = {
  transport: 'http'; // seul transport en MVP
  endpoint_url: string; // url HTTP du parent
  auth_token: string; // Bearer envoyé par le child
};
```

Le champ vit dans `tokens.context.escalation_channel` (jsonb sur la
table `tokens`). Le parent qui mint le child le pose au mint. Le child
**le lit** à la résolution de son context — il ne l'écrit pas.

## §3. Quand l'agent l'utilise

Le runtime renvoie l'erreur structurée suivante quand un call touche un
risk pas dans `accepted_risks` :

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32603,
    "message": "Vaubaan policy denied: risk-not-accepted",
    "data": {
      "missing_risks": ["github.merge-protected"],
      "executed_slices": ["github.repo[owner/repo].branch[main].file[…].W"],
      "hint": "Request escalation via your token's context.escalation_channel"
    }
  }
}
```

L'agent (côté SDK / client) doit :

1. Si `context.escalation_channel` est absent → surfacer l'erreur à
   l'humain et stopper.
2. Sinon POST `endpoint_url` avec `Authorization: Bearer ${auth_token}`
   et body `{ child_token_id, risks_needed, justification,
executed_slice }`.
3. Attendre la réponse parent.
4. Sur cede, le parent re-minte le child (via une side-channel — out
   of gateway). Le child reçoit le nouveau Bearer.
5. Retry le call avec le nouveau Bearer.

## §4. Mint side — où le parent pose le channel

`POST /api/v1/tokens/mint` accepte un champ `context` dont
`escalation_channel` fait partie :

```json
{
  "name": "feature-x-helper",
  "scope": "project",
  "projectSlug": "gateway",
  "accepted_risks": ["github.feature-branch-write", "github.create-pr"],
  "bindings": [{ "provider": "github", "resource_ref": "sbw-vaubaan/gateway", "env": "feature" }],
  "context": {
    "escalation_channel": {
      "transport": "http",
      "endpoint_url": "https://your-agent.example.com/escalations",
      "auth_token": "ek_…"
    }
  },
  "ttlHours": 1
}
```

Le champ est opaque au gateway — Vaubaan ne valide pas
`endpoint_url`, ne signe pas `auth_token`, ne ping pas l'endpoint au
mint. C'est volontaire : le parent owns l'escalation, le gateway
n'arbitre que les invariants subset + acceptable_in_envs.

## §5. Pourquoi ce design (vs. l'ancien `approval_requests`)

Cf. ADR unified-gates-drop-confirm §1 + §2 :

- Le `confirm` gate au mint et l'escalation runtime sont la **même
  primitive** (notification → décision humaine → mint élargi) à un
  timing près. Garder les deux doublait l'infrastructure (table
  `approval_requests`, table `project_approval_channels`, webhook
  Telegram, signed-link Email, route long-poll).
- L'escalation runtime déclenche la décision humaine **au moment où
  elle est utile** (le call qui veut le risk) plutôt qu'à l'avance
  (au mint, "au cas où"). Aligné OAuth RFC 9470 (step-up auth).
- Le gateway ne porte plus de "comment notifier un humain" — c'est
  un service séparé que Vaubaan peut offrir (ex.
  `vaubaan.com/escalations/<user_id>` comme bridge HTTP→Telegram/Email)
  mais qui n'est pas dans le scope du gateway.

## §6. Code surface

- `packages/web/src/lib/mint/child-mint.ts` — `mintChildToken`,
  `checkMintInvariants` (subset / depth / expires_at).
- `packages/web/src/app/api/v1/tokens/mint/route.ts` — endpoint mint
  (201 ou 403, plus de 202).
- `packages/web/src/app/api/v1/tokens/preview/route.ts` — preview
  (`{ acceptable, inherited }` par row, plus de `effective_gate`).
- `packages/web/src/lib/mint/risk-preview.ts` — pure-compute de la
  preview.

## §7. Audit

Toute mint génère une ligne `audit_log` avec
`token_accepted_risks_snapshot`, `delegation_chain` et le contexte de
mint (parent_id implicite via `delegation_chain[]`). Toute escalation
réussie produit un nouveau child token — donc une nouvelle ligne
audit, naturellement chaînée via `delegation_chain`. Pas de table
dédiée aux escalations côté Vaubaan : la trace est dans
`delegation_chain` + le timestamp `created_at`.

## §8. Limites connues

- Pas de retry / dead-letter côté agent SDK MVP : si l'endpoint
  parent est down, l'agent stalle. À durcir côté SDK.
- Pas de cooldown anti-spam (un agent en boucle peut spammer son
  parent). À traiter côté parent (rate-limit / dedup applicatif).
- `escalation_channel.auth_token` est en clair dans
  `tokens.context.jsonb`. À durcir (encryption-at-rest column-level)
  ou à pivoter vers un secret-id résolu côté gateway.
