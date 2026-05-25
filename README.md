# Vauban MCP Proxy

> Policy-enforcing **MCP gateway** for coding agents. Filter and audit each
> tool call from Claude Code / Cursor / Continue without ever giving them a
> cloud provider token.

```
Coding Agent ──── MCP call ────▶ ┌─────────────────────────────┐
                                  │  Vauban MCP Proxy  /mcp     │
                                  │  ┌────────────────────────┐ │
                                  │  │ Auth (Bearer vbn_live_) │ │
                                  │  │ Policy evaluate         │ │
                                  │  │ Mint upstream JIT       │ │
                                  │  │ Forward + Audit         │ │
                                  │  └────────────────────────┘ │
                                  └────────────┬────────────────┘
                                               │
                                               ▼
                                       ┌──────────────┐
                                       │  Provider    │
                                       │  (GitHub …)  │
                                       └──────────────┘
```

## Pitch

- **L'agent ne voit jamais de cred provider.** Il s'authentifie auprès de
  Vauban avec une `vbn_live_<key>`, et le gateway mint un token éphémère
  côté provider JIT à chaque call.
- **Une policy déclarative** filtre par tool et arguments — `github:developer`
  peut push sur `feature/*` mais pas merger sur `main`. Default deny.
- **Audit immutable** côté Vaubaan — 1 row par call, allow ou deny.

Cf. `docs/spec/mcp-proxy.md` pour la spec complète.

## Quick start

### Prerequisites

- Node ≥ 20, npm ≥ 10
- Supabase project (anon + service_role keys)
- GitHub App "Vaubaan Gateway" registered (one-time operator setup)
- (optional) Upstash Redis for hot-path cache

### Setup

```bash
npm install
cp packages/web/.env.local.example packages/web/.env.local
# fill in NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GITHUB_APP_*
npm run dev
# open http://localhost:3000
```

### Apply DB schema

```bash
# via Supabase CLI (recommended)
supabase db push

# or via psql against the Session Pooler (IPv4)
psql "postgresql://postgres.<ref>@<pooler-host>:5432/postgres" \
  -f supabase/migrations/0001_init.sql
```

### Run a Bot's first call

After UI flow (org → connect GitHub → project → binding → bot create), copy
the api_key into your agent's `mcp.json` :

```jsonc
{
  "mcpServers": {
    "vauban": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer vbn_live_..." },
    },
  },
}
```

Restart your agent. `tools/list` should now return GitHub tools filtered by
the Bot's roles.

## Scripts

| Script                 | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `npm run dev`          | Next.js dev server                               |
| `npm run build`        | Production build (Next.js)                       |
| `npm run test`         | Vitest run (unit + integration)                  |
| `npm run test:watch`   | Vitest file-watcher                              |
| `npm run test:e2e`     | Playwright (smoke + real-clouds, gated by creds) |
| `npm run lint`         | ESLint                                           |
| `npm run format`       | Prettier write                                   |
| `npm run format:check` | Prettier check                                   |
| `npm run type-check`   | tsc --noEmit across workspaces                   |
| `npm run ci`           | type-check + lint + format:check + test + build  |

## Architecture

```
packages/
  shared/              # cross-package types + api_key generation (argon2id)
  policy-engine/       # DSL + decision flow + 7 operators + tools/list filter
  providers/github/    # ProviderAdapter (App install, JIT JWT, Octokit dispatch)
  mcp-gateway/         # auth, cache, audit, JSON-RPC dispatcher
  web/                 # Next.js 15 App Router (UI + REST + /mcp)
supabase/migrations/   # SQL schema (9 tables + RLS + builtin roles seed)
```

## Documentation

The 6 doc pillars (cf. `docs/spec/` is the source of truth ; the rest captures
how that spec is realized) :

| Pillar        | Path                     | Purpose                                |
| ------------- | ------------------------ | -------------------------------------- |
| **Spec**      | `docs/spec/mcp-proxy.md` | Vision, vocabulary, hors-scope, domain |
| **Decisions** | `docs/decisions/`        | ADRs — why we chose what we chose      |
| **Handbook**  | `docs/handbook/`         | How features are actually implemented  |
| **Tests**     | `docs/tests/`            | Integration + E2E test plans           |
| **Workflow**  | `docs/workflow/`         | CI, branches, env variants, PR process |
| **README**    | this file                | Pitch + quick start                    |

ADRs landed for the v4 pivot :

- [pivot-v3-to-v4-policy-gateway](docs/decisions/pivot-v3-to-v4-policy-gateway.md)
- [rbac-org-role-bot-project](docs/decisions/rbac-org-role-bot-project.md)
- [roles-naming-provider-scoped](docs/decisions/roles-naming-provider-scoped.md)
- [mcp-only-mvp-scope](docs/decisions/mcp-only-mvp-scope.md)
- [oauth-app-install-per-provider](docs/decisions/oauth-app-install-per-provider.md)
- [trust-model-clear-at-rest-idp-style](docs/decisions/trust-model-clear-at-rest-idp-style.md)
- [policy-dsl-declarative-jsonb](docs/decisions/policy-dsl-declarative-jsonb.md)
- [dispatch-upstream-option-a-synthese](docs/decisions/dispatch-upstream-option-a-synthese.md)
- [redis-cache-upstash-with-memory-fallback](docs/decisions/redis-cache-upstash-with-memory-fallback.md)
- [api-key-format-vbn-live-argon2id](docs/decisions/api-key-format-vbn-live-argon2id.md)

## Status

MVP — vertical slice GitHub. 69 unit + integration tests green. Phase 5
(Vercel + Supabase providers, custom roles UI, audit alerting) à venir.

## License

UNLICENSED. Vaubaan-internal.
