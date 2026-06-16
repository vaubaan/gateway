# Vaubaan Agent Bootstrap

> Self-contained reference for an LLM (or any MCP client) that has been
> handed a `vbn_live_*` token and needs to do useful work through the
> Vaubaan gateway.

---

## 1. What you have

A **`vbn_live_*` token**. It carries:

- `accepted_risks: RiskId[]` — the set of risks your token-issuer agreed
  you may touch. Any call that touches a risk **not** in this set is
  refused at runtime with a structured error you can act on.
- `context.escalation_channel` (optional) — when present, an HTTP
  endpoint your parent owns to elevate your scope at runtime when you
  hit a missing risk. Absent on root tokens (humans).
- `expires_at` — once past, the gateway returns `401`.

Treat it like a password : never log it, never commit it. The bootstrap
client that spawned you keeps it in memory only.

## 2. Endpoint and auth

|              |                                      |
| ------------ | ------------------------------------ |
| Base URL     | `https://vaubaan.com/mcp`            |
| Method       | `POST` (JSON-RPC 2.0)                |
| Auth         | `Authorization: Bearer <vbn_live_…>` |
| Content-Type | `application/json`                   |

The gateway is **stateless per Bearer** : every request authenticates
independently, there is no `Mcp-Session-Id` to manage, and an
`initialize` handshake is not required before `tools/call`.

## 3. Discovery

### 3.1 `tools/list` (your callable surface)

```bash
curl -sS https://vaubaan.com/mcp \
  -H "Authorization: Bearer $VBN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

The response is statically filtered to tools whose **declared risks
intersect** with your token's `accepted_risks` (an env-less, plane-level
pre-filter — sharper denials happen at the call-site). A missing tool
usually means your token doesn't carry a relevant risk ; see §6.

### 3.2 `GET /api/v1/catalog` (the full risk catalog of a provider)

```bash
curl -sS "https://vaubaan.com/api/v1/catalog?provider=github" \
  -H "Authorization: Bearer $VBN"
```

Returns the array of `RiskEntry` objects for that provider :
`{ id, label, reason, matches, vector, acceptable_in_envs? }`. Use this
to understand which risks the gateway tracks and what each one means.

## 4. Call shape

```jsonc
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "tools/call",
  "params": {
    "name": "github__create_or_update_file",
    "arguments": {
      "owner": "sbw-vaubaan",
      "repo": "gateway",
      "branch": "feature/auth-bug-789",
      "path": "src/auth.ts",
      "content": "…",
      "message": "fix(auth): expire cookies on logout",
    },
  },
}
```

On success the gateway forwards to the provider's upstream MCP server
and returns its response verbatim. The response shape matches that
upstream — Vaubaan does not rewrite it.

## 5. Error model — `risk-not-accepted`

When a call touches a risk that is **not** in your
`accepted_risks`, you get a JSON-RPC error :

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32603,
    "message": "Vaubaan risk-not-accepted",
    "data": {
      "error": "risk-not-accepted",
      "missing_risks": ["github.merge-protected"],
      "executed_slices": [
        {
          "provider": "github",
          "path": [
            { "kind": "name", "value": "repo" },
            { "kind": "ident", "value": "sbw-vaubaan/gateway" },
            { "kind": "name", "value": "branch" },
            { "kind": "ident", "value": "main" },
            { "kind": "name", "value": "file" },
            { "kind": "ident", "value": "src/auth.ts" }
          ],
          "action": "W"
        }
      ],
      "hint": "Request escalation via your token's context.escalation_channel"
    }
  }
}
```

Read it like this :

- `error` — the discriminator (`"risk-not-accepted"`). Duplicated at the
  top of `data` so clients can dispatch without parsing `message`.
- `missing_risks` — the `RiskId[]` you'd need accepted to make this
  call succeed.
- `executed_slices` — `Slice[]` objects (see `packages/shared/src/risk.ts`),
  each a structured `{ provider, path, action }` triple. The path is a
  list of typed segments (`name` | `ident` | `list` | `wild-one` |
  `wild-rec`). Useful for debugging or surfacing to the operator.
- `hint` — a one-liner pointing to the next action (escalate, or stop).

## 6. Escalation flow (`context.escalation_channel`)

If you got a `risk-not-accepted` and your token carries
`context.escalation_channel`, you can ask your parent to re-mint you
with a wider scope. The channel is an HTTP endpoint your parent owns —
Vaubaan does not proxy it.

```jsonc
// On your token at mint :
"context": {
  "escalation_channel": {
    "transport": "http",
    "endpoint_url": "https://parent.example.com/escalations",
    "auth_token": "ek_…"   // bearer YOU send when posting
  }
}
```

POST to that endpoint :

```bash
curl -sS -X POST "$ESC_URL" \
  -H "Authorization: Bearer $ESC_AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "child_token_id": "tok_abc123",
    "risks_needed": ["github.merge-protected"],
    "justification": "Re-merge feature/auth-bug-789 after upstream review.",
    "executed_slice": "github.repo[sbw-vaubaan/gateway].branch[main].file[src/auth.ts].W"
  }'
```

The parent decides. On **cede**, the parent re-mints a new token for
you (via a side-channel — out of Vaubaan's scope ; this is the parent's
responsibility). When you receive that new token, **retry the call**
with the new Bearer.

**Roots have no parent.** If your token has no `escalation_channel`,
escalation isn't possible from your side — surface the error to the
human operator and stop.

## 7. Mint a child for delegation

You can mint child tokens of your own (e.g. to delegate a narrower
scope to a sub-agent) :

```bash
curl -sS -X POST https://vaubaan.com/api/v1/tokens/mint \
  -H "Authorization: Bearer $VBN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "feature-x-helper",
    "scope": "project",
    "projectSlug": "gateway",
    "accepted_risks": ["github.feature-branch-write", "github.create-pr"],
    "bindings": [
      { "provider": "github", "resource_ref": "sbw-vaubaan/gateway", "env": "feature" }
    ],
    "context": {
      "escalation_channel": {
        "transport": "http",
        "endpoint_url": "https://your-agent.example.com/escalations",
        "auth_token": "ek_…"
      }
    },
    "ttlHours": 1,
    "singleUse": false
  }'
```

Responses :

- `201` → the child token. The `api_key` is shown **once** — copy it
  immediately. `accepted_risks` is echoed back for confirmation.
- `403` → either the request violates an invariant (max-depth, depth
  cap of 5 reached, child `expires_at` exceeds parent's, scope
  mismatch, denial-propagation), or at least one risk in
  `accepted_risks` is not in **your** `accepted_risks` (subset rule)
  or not acceptable in the binding env (catalog `acceptable_in_envs`).
  Body includes `not_acceptable` and `not_inherited` arrays.
- `400` → schema (Zod) failure or TTL out of bounds.

## 8. Audit and forensics

Every `tools/call` writes to `audit_log` with the token snapshot, the
executed slices, the risks touched, and the **delegation_chain** — the
ancestry of your token back to the root. Operators can reconstruct
"who minted whom under what conditions" from this chain. You do not
read this log yourself ; it's the trace your operator inspects when
something goes wrong.

## 9. Conventions

- **Resource refs.** When bindings carry `resource_ref` :
  - GitHub : `owner/repo` (e.g. `sbw-vaubaan/gateway`).
  - Vercel : `prj_<id>`.
  - Supabase : project ref (the short id, not the slug).
  - Railway : project id.
  - Bash / SSH : the host slug.
- **Single-use tokens.** When `singleUse: true`, the first successful
  `tools/call` revokes the token. Use for short, scripted operations.
- **Depth cap = 5.** Your token has a `depth` ; child tokens you mint
  carry `depth + 1`. Mint refuses past depth 5.
