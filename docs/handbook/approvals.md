---
title: Approvals — mint flow, channels, long-poll
status: current
date: 2026-06-16
tracks:
  - packages/web/src/lib/approvals/
  - packages/web/src/lib/mint/
  - packages/web/src/lib/auth/require-token.ts
  - packages/web/src/app/api/v1/tokens/mint/route.ts
  - packages/web/src/app/api/v1/tokens/preview/route.ts
  - packages/web/src/app/api/v1/tokens/pending/[id]/route.ts
  - packages/web/src/app/api/v1/mgmt/approvals/[id]/route.ts
  - packages/web/src/app/api/v1/projects/[projectId]/approvals/[approvalId]/decide/route.ts
  - packages/web/src/app/api/v1/integrations/telegram/webhook/route.ts
  - packages/web/src/app/api/v1/integrations/email/decide/route.ts
  - supabase/migrations/0013_approvals.sql
  - supabase/migrations/0014_single_use_tokens.sql
  - supabase/migrations/0017_approval_sweeper_cron.sql
  - supabase/migrations/0032_unified_tokens_table.sql
  - supabase/migrations/0033_data_migration_to_tokens.sql
  - supabase/migrations/0034_audit_log_delegation_chain.sql
  - supabase/migrations/0035_drop_legacy_token_tables.sql
---

# Approvals — mint flow, channels, long-poll

> **Historique.**
>
> - Ce handbook s'appelait `capability-policy-and-approvals.md` jusqu'au
>   2026-06-15. Le pivot v4 `chore(v1-drop)` a supprimé l'ensemble
>   `policy_rules` / `Capability[]` / `evaluatePolicy`. Seul le pan
>   **approval** reste valide (lifecycle, channels, long-poll).
> - 2026-06-16, refacto unified-tokens (ADR
>   [[unified-tokens-delegation-chain-and-escalation-channel]]) :
>   `org_management_keys` + `access_tokens` fusionnent dans la table
>   unique `tokens` (`scope='org'|'project', parent_id, delegation_chain`).
>   Les endpoints `/api/v1/mgmt/tokens*` et `/api/v1/projects/[id]/mint*`
>   sont retirés au profit d'un endpoint unique `POST /api/v1/tokens/mint`.
>   Le préfixe `vbn_mgmt_*` disparaît ; tous les Bearers sont `vbn_live_*`.

Le mint d'un token résout les `effective_gate` par risk_id
(catalog × project policy × env binding). Si tous les gates valent
`allow`, le token est minté immédiatement comme child du Bearer
appelant (`parent_id = caller.id`). Si au moins un vaut `confirm`,
une `approval_request` est créée et notifiée via un channel
(manual / telegram / email). Si au moins un vaut `deny`, refus 403 final.

L'agent (SDK) peut attendre la décision via un **long-poll borné 25 s**
sur `GET /api/v1/tokens/pending/:id?wait=25`.

## Mint flow

```
POST /api/v1/tokens/mint
  Authorization: Bearer vbn_live_…
  { scope: 'org' | 'project',
    projectId? | projectSlug?,                  // requis si scope='project'
    bindings[], accepted_risks[], denied_risks?,
    name?, ttlHours?, ttlSeconds?, singleUse?, context? }
  │
  ├─ requireToken  (vbn_live_* → guard.token = MintParent)
  ├─ resolve project (scope='project') ; org-scoped skip
  ├─ load catalogs (per-provider) + project_risk_policies (eq project_id)
  ├─ computePreview(bindings × accepted_risks × catalogs × policies)
  │     → per-risk { gate: allow|confirm|deny, origin }
  │
  ├─ any deny  → 403 { error, denied_risks, risks }
  ├─ all allow → mintChildToken(svc, { parent: guard.token, ... })
  │              → checkMintInvariants (subset, depth, expires, denied)
  │              → INSERT tokens (api_key_prefix, api_key_hash,
  │                               parent_id, depth, delegation_chain, …)
  │              → 201 { token, api_key, expires_at, accepted_risks }
  │
  └─ any confirm → INSERT approval_requests(status='pending', …)
                 → pickChannel(svc, projectId) → manual | telegram | email
                 → channel.open(payload)        → ✉️ side-effect
                 → 202 { approval_id, channel, poll_url, expires_at,
                         needs_approval, risks }
```

Le caller authentifié peut être :

- un **`vbn_live_*` project-scoped** (un Coding Agent qui re-mint un
  sub-token) — invariants subset/depth strict appliqués.
- un **`vbn_live_*` org-scoped root** (`scope='org', depth=0,
accepted_risks=[]`) — bénéficie du **carte-blanche bypass**
  (cf. `isCarteBlancheParent` dans `mint.ts`). Ces tokens correspondent
  aux anciens `org_management_keys` migrés. Bypass justifié : un mgmt
  key historique n'avait pas de risk grant, l'autorisation venait de
  l'appartenance org.

L'endpoint preview (`POST /api/v1/tokens/preview`) calcule la même
résolution sans persister — consommé par le composant `mint-form.tsx`
pour afficher la checklist des risques en temps réel. L'helper pur
`computePreview` (`lib/mint/risk-preview.ts`) est partagé entre les
deux routes — single source of truth.

## Carte-blanche shim (external-channel decisions)

Les décisions externes (Telegram callback, Email click, UI session
org-member click) **n'ont pas de parent Bearer authentifié** à
decide-time. Pour passer le check subset de `mintChildToken`, elles
synthétisent un **parent root carte-blanche** via le helper
`externalApprovalParent` (`lib/approvals/external-mint.ts`) :

```ts
externalApprovalParent({
  approvalId,
  organizationId,
  channel: 'email' | 'telegram' | 'user-session',
  createdBy, // user id when known, null otherwise
});
// → MintParent { scope: 'org', depth: 0, accepted_risks: [], … }
// → isCarteBlancheParent(parent) === true → subset check skipped
```

Le `name` du parent synthétique (`email-approval` / `telegram-approval`
/ `user-session-approval`) est propagé dans le `delegation_chain` du
child minté — l'audit row remembers which channel authorized the
bypass.

**Dette** : à terme, `approval_requests` portera un
`requester_token_id` qui pointera vers le bearer original, et le
parent synthétique sera remplacé par un load du vrai parent. Cf.
W3 dans `.vaubaan/reports/clean-code-report.md`.

## Approval lifecycle

```
pending ──✅──→ approved ──poll──→ consumed
   │                                  │
   ├──❌──→ denied                    └─ (api_key returned ONCE)
   │
   └──(TTL 15min)──→ expired
```

- TTL par défaut 15 min (`approval_requests.expires_at` default column).
- La fonction SQL `expire_stale_approval_requests()` (définie dans
  `0013_approvals.sql`) flippe les rows stale à `expired` et clear tout
  `pending_api_key` oublié. Schedulée par `0017_approval_sweeper_cron.sql`
  (pg_cron, à côté du purge `0010_purge_expired_access_tokens.sql`).
- À l'approve, `mintForApproval` consomme la row pending et inscrit
  l'`access_token` + stash le `pending_api_key` plaintext sur la row
  pour la sortie de poll suivant. Cleared à la première lecture.

## Channels

Trois channels actifs (un projet peut en avoir N actifs simultanément
via la table `project_approval_channels` — décidé pour fan-out /
redondance).

### `ManualChannel`

Approbation sans notification. L'opérateur appelle directement
`POST /api/v1/mgmt/approvals/:id` (Bearer `vbn_live_*`) ou
`POST /api/v1/projects/:projectId/approvals/:id/decide` (session
org-member) avec `{ decision: 'approve' | 'deny' }`. Utile pour dev / CI
/ clients sans intégration chat.

> Le préfixe `vbn_mgmt_*` n'existe plus ; la route `mgmt/approvals/[id]`
> reste sous ce path pour compat URL côté SDK, mais accepte n'importe
> quel `vbn_live_*` de la même org.

### `TelegramChannel`

Le bot Vaubaan poste un message dans le chat configuré avec deux
inline buttons ✅/❌. Le clic envoie un `callback_query` au webhook
`POST /api/v1/integrations/telegram/webhook` qui :

1. Vérifie `X-Telegram-Bot-Api-Secret-Token` quand `TELEGRAM_WEBHOOK_SECRET`
   est set.
2. Parse `callback_query.data` (format `vbn:<approvalId>:<approve|deny>`).
3. Route vers `decideApproval` ; sur approve, mint + stash `pending_api_key`.

Setup bot :

1. `@BotFather` → `/newbot` → récupérer `TELEGRAM_BOT_TOKEN`.
2. `POST https://api.telegram.org/bot<token>/setWebhook
{ url: 'https://<host>/api/v1/integrations/telegram/webhook',
  secret_token: '<TELEGRAM_WEBHOOK_SECRET>' }`.
3. Per-project : INSERT `project_approval_channels` avec
   `channel='telegram', telegram_chat_id='<chat_id>'`. Le bot token peut
   être surchargé per-project (`telegram_bot_token_encrypted` bytea) ;
   sinon fallback sur `process.env.TELEGRAM_BOT_TOKEN`.

### `EmailChannel` (Phase 6, commit 05c6420)

Envoie un email avec deux liens signés HMAC pointant vers
`GET /api/v1/integrations/email/decide?token=<signed-token>`. Le token
embed `(approval_id, decision, expiry)` et est signé avec
`EMAIL_SIGNING_SECRET`. CSRF mitigé par la signature : un attaquant qui
ne connaît pas le secret ne peut pas forger un token valide.

Implémentation : `lib/approvals/email.ts` (channel) +
`lib/approvals/email-token.ts` (sign/verify HMAC). Provider d'envoi =
Resend par défaut (configurable).

Env vars :

| Env var                 | Valeur                                                      | Notes                                                                |
| ----------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `EMAIL_SIGNING_SECRET`  | Random 32+ bytes (base64 ou hex)                            | **Secret.** Rotation casse les liens en vol — à coordonner avec TTL. |
| `RESEND_API_KEY`        | `re_<...>` (clé Resend)                                     | **Secret.** Required pour envoyer effectivement.                     |
| `EMAIL_SENDER_ADDRESS`  | `approvals@<your-domain>` ou `onboarding@resend.dev` (test) | From: header. Doit être validé dans Resend.                          |
| `EMAIL_PUBLIC_BASE_URL` | `https://vaubaan.com`                                       | Base URL des liens signés (utile pour preview-deploys / local).      |

Setup per-project : INSERT `project_approval_channels` avec
`channel='email', email_address='<recipient>'`. La colonne
`email_address` a été ajoutée à `project_approval_channels` par la
migration de la Phase 6.

`pickChannel` (`lib/approvals/index.ts`) sélectionne le channel actif
par priorité (manual > telegram > email — ajustable). Sans aucune row
active, fallback `ManualChannel` (le mint passe en 202 sans
notification ; opérateur approuve via API).

## Single-use tokens

`singleUse: true` + un `ttlSeconds` court (capé à 3600s côté mgmt) font
qu'**approve the mint ≡ approve the act**. Sur le premier `/mcp` call
allowed :

- `gateway.callTool` appelle `contextLoader.consumeAccessToken(id)` —
  atomic SQL `UPDATE … SET status='revoked', consumed_at=now()
WHERE id=? AND single_use=true AND consumed_at IS NULL`. Wins la race
  ou no-ops sur un perdant (rejected avec `consumed (single-use)` reason).
- Cache invalidé pour que l'auth suivante recharge `status='revoked'`.
- `authenticate()` asserte `consumed_at IS NULL` sur les deux chemins
  cold et cache.

Le `/mcp` hot-path reste **stateless** — la seule "state" est l'UPDATE
atomique qui tourne une fois par token + l'invalidation cache qui suit.

## Long-poll (`?wait=25`)

```
GET /api/v1/tokens/pending/:approval_id?wait=25
  Authorization: Bearer vbn_live_…
  ├─ requireToken
  ├─ wait_seconds = min(query.wait, MAX_WAIT_SECONDS=25)
  ├─ loop until deadline (or req.signal.aborted) :
  │     row = svc.from('approval_requests').select(...).eq(id, ...)
  │     switch row.status :
  │       'approved' → 201 { token, api_key, expires_at }
  │                    (and CLEAR pending_api_key after read,
  │                     mark approval_requests.status='consumed')
  │       'denied' | 'expired' | 'cancelled' | 'consumed'
  │                  → 410 { status, decided_at }
  │       'pending'  → sleep 500ms (AbortSignal-aware) → re-loop
  │
  └─ at deadline still pending → 202 { status: 'pending', expires_at }
```

L'endpoint vit dans `app/api/v1/tokens/pending/[id]/route.ts`. Le
cap de 25 s reste sous le mur Vercel Edge (30 s avant 1er byte) et
Cloudflare (100 s origin idle). Le SDK agent encapsule le re-poll
jusqu'au wall-clock global (par défaut 15 min = TTL de l'approval).

Détail impl :

- Runtime Node, `dynamic = 'force-dynamic'`, `maxDuration: 30`.
- Poll DB toutes les 500 ms au MVP (acceptable pour le volume MVP).
- Switch en `pg_notify` / `Postgres LISTEN` si métriques le justifient.

Cf. spec [`gateway-risk-model.md`](../spec/gateway-risk-model.md) §11 et
[`mcp-gateway.md`](./mcp-gateway.md) §Long-poll mint.

## Operational bits

- **Approval channels précédence.** `pickChannel` lit
  `project_approval_channels` (table à composite key
  `(project_id, channel)`). Plusieurs rows actives → fan-out (toutes
  les channels notifient simultanément, première décision gagne).
- **Decide routes (operator side).**
  `POST /api/v1/projects/:projectId/approvals/:approvalId/decide`
  pour approve/deny depuis l'UI org-member (différent de la route
  `mgmt/approvals/[id]` qui consomme un PAT Vaubaan).
- **RLS.** Le `pending_api_key` est plaintext sur la row au plus
  `expires_at` (15 min) ; cleared on first poll ou par le sweeper. RLS
  sur `approval_requests` est service_role-only en write ; org members
  peuvent SELECT pour la (future) dashboard.

## Références

- Spec : [`docs/spec/gateway-risk-model.md`](../spec/gateway-risk-model.md)
  §9 (mint flow), §10 (channels), §11 (long-poll).
- Handbooks voisins : [[mcp-gateway]] (hot-path qui consomme les tokens
  mintés ici), [[policy-engine]] (résolution `effective_gate` =
  `risk-policy.ts`), [[web-app]] (UI mint form + sidebar).
- Migrations : `0013_approvals.sql`, `0014_single_use_tokens.sql`,
  `0017_approval_sweeper_cron.sql`, `0032`-`0035` (unified-tokens).
- ADRs : [[mcp-only-mvp-scope]],
  [[unified-tokens-delegation-chain-and-escalation-channel]] (current),
  [[programmatic-access-token-minting]] (superseded).
- Tests : `packages/web/tests/unit/lib/approvals/*.test.ts`
  (email-token, mint, external-mint, decide),
  `packages/web/tests/unit/api/tokens-preview.test.ts`
  (12 tests gate-resolution scénarios).
