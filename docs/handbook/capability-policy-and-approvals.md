---
title: Capability policy + human-gate approvals
status: current
date: 2026-06-08
tracks:
  - packages/policy-engine/src/policy.ts
  - packages/web/src/lib/approvals/
  - packages/web/src/app/api/v1/mgmt/tokens/route.ts
  - packages/web/src/app/api/v1/mgmt/tokens/pending/[id]/route.ts
  - packages/web/src/app/api/v1/mgmt/approvals/[id]/route.ts
  - packages/web/src/app/api/v1/integrations/telegram/webhook/route.ts
  - supabase/migrations/0012_policy_rules.sql
  - supabase/migrations/0013_approvals.sql
  - supabase/migrations/0014_single_use_tokens.sql
---

# Capability policy + human-gate approvals

Two-layer authorization model (cf. `docs/spec/gateway-capability-model.draft.md`
§5, §5.1, §8) :

1. **Plugin layer (mechanical, native semantics)** — `classify()` answers
   "which capability does this concrete `(tool, args)` call require ?". Lives
   in each `packages/providers/<vendor>/src/classify.ts`. Knows nothing about
   rights.
2. **Policy layer (client config)** — `policy_rules` answers "_who_ is
   allowed to be granted this capability — AI-autonomously, or behind a human
   approval ?". Lives in Postgres (per-project), consumed only at **mint**
   (`POST /api/v1/{mgmt,}/tokens`), never at the `/mcp` hot path.

The capability `{provider, plane, level, action, env?}` tuple is the contract
between the two layers.

## Policy rules

```sql
policy_rules (
  id, project_id,
  provider, plane, level,           -- exact slug or '*'
  action,                            -- 'read' | 'write' | '*'
  env_pattern,                       -- exact slug or '*'
  gate                               -- 'ai' | 'human'
  priority                           -- ties broken by desc
)
```

- **Default-deny** : no matching rule ⟹ `gate='human'`. The rule database is
  an allow-list.
- **Most-specific wins** : specificity = number of fields ≠ `*`. Ties broken
  by `priority desc`.
- **Anti-pattern guard** (SQL CHECK) : refuses
  `(action='write', env_pattern='*', gate='ai')` — a blanket ai-allow on
  writes would silently authorize prod (spec §5.1 #2).
- **Env-less caps** match `env_pattern='*'` only. The env-less _fan-out_ case
  (e.g. Vercel all-env env var) is therefore default-human-gated, which is
  the safe direction until `@all` is modeled (§5.1 #3).

**Seed** : every project is auto-seeded (trigger) with two priority-0 rules :
`*:*:*:read:* → ai` and `*:*:*:write:* → human`. Operators add specific
overrides (e.g. `github:repo/code:write@feature/* → ai`) without touching the
defaults.

`evaluatePolicy(caps, rules)` is the pure function. Tested in
`packages/policy-engine/tests/unit/policy.test.ts` (10 tests).

## Mint flow

```
POST /api/v1/mgmt/tokens { projectSlug, capabilities, ttlHours?, singleUse?, context? }
  │
  ├─ requireManagementKey  (vbn_mgmt_… → orgId, managementKeyId)
  ├─ parse capabilities[]  (notation provider:plane/level:action@env)
  ├─ load policy_rules     (eq project_id)
  ├─ evaluatePolicy(caps, rules)
  │
  ├─ all-ai ?  ───── YES → INSERT access_tokens(..., single_use)
  │                        → 201 { access_token, api_key, expires_at }
  │
  └─ NO  → INSERT approval_requests(status='pending', requested_single_use, ...)
         → pickChannel(svc, projectId) → manual | telegram
         → channel.open(payload)        → ✉️ side-effect (Telegram sendMessage…)
         → 202 { approval_id, channel, poll_url, expires_at, gated[] }
```

### Approval lifecycle

```
pending ──✅──→ approved ──poll──→ consumed
   │                                  │
   ├──❌──→ denied                    └─ (api_key returned ONCE)
   │
   └──(TTL 15min)──→ expired
```

Operator decision paths :

- **Telegram** — webhook `POST /api/v1/integrations/telegram/webhook` reads
  `callback_query.data` (`vbn:<approvalId>:<approve|deny>`), routes to
  `decideApproval` ; on approve, mints + stashes `pending_api_key`. The
  caller polls `/api/v1/mgmt/tokens/pending/:approvalId` to retrieve it.
  Webhook is shared across projects ; per-project routing is by `approvalId`.
  Verifies `X-Telegram-Bot-Api-Secret-Token` when `TELEGRAM_WEBHOOK_SECRET`
  is set.
- **Manual** — operator calls `POST /api/v1/mgmt/approvals/:approvalId`
  with `{ decision: 'approve' | 'deny' }`. Useful for dev / CI / clients
  without a chat integration.

`mintForApproval` and `decideApproval` (`packages/web/src/lib/approvals/`)
are the shared helpers. The `pending_api_key` is plaintext on the row for at
most `expires_at` (15 min) ; cleared on first poll or by the
`expire_stale_approval_requests()` sweeper. RLS on `approval_requests` is
service-role-only for writes ; org members can SELECT for the (future)
dashboard.

## Single-use tokens

`singleUse: true` + a short `ttlSeconds` (capped at 3600s) make
"approve the mint ≡ approve the act". On the first `/mcp` call that matches
a granted capability :

- `gateway.callTool` calls `contextLoader.consumeAccessToken(id)` — atomic
  SQL `UPDATE … SET status='revoked', consumed_at=now() WHERE id=? AND
single_use=true AND consumed_at IS NULL`. Wins the race or no-ops on a
  loser ; loser hits the rejected path with `consumed (single-use)` reason.
- Cache invalidated so next auth's re-verify picks up `status='revoked'`.
- `authenticate()` asserts `consumed_at IS NULL` on both cold and cache
  paths.

The `/mcp` hot path remains **stateless** — the only "state" is the atomic
UPDATE that runs once per token, and the cache invalidation that follows.

## Operational bits

- **Bot setup** — create via @BotFather, set `TELEGRAM_BOT_TOKEN` env var
  (and `TELEGRAM_WEBHOOK_SECRET` if you want signature verification).
  `POST https://api.telegram.org/bot<token>/setWebhook
{ url: 'https://<host>/api/v1/integrations/telegram/webhook',
  secret_token: '<TELEGRAM_WEBHOOK_SECRET>' }`.
- **Per-project channel** — insert a `project_approval_channels` row with
  `channel='telegram', telegram_chat_id='<chat_id>'`. Without it, the
  picker falls back to `ManualChannel` and the mint returns 202 with no
  notification — operator approves via the API.
- **Approval TTL** — 15 min by default (column default). The
  `expire_stale_approval_requests()` SQL function flips stale rows to
  `expired` and clears any forgotten `pending_api_key`. Wire it into the
  existing nightly cron next to the `purge_expired_access_tokens` call.
