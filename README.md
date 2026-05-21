# cloud-resource-manager

> Cloud Resource Manager (CRM) — Vauban Core's inventory of cloud resources, zero-knowledge sealed credentials, and MCP exports.

## What is this

The Cloud Resource Manager is the Vauban Core subsystem that catalogs the cloud resources an organisation owns (GitHub orgs/repos, Vercel teams/projects, Supabase orgs/projects, etc.), stores their access tokens as multi-recipient sealed blobs that only authorised browsers can decrypt, provisions new project-level resources via admin tokens directly from the user's browser, and exports the inventory + MCP server config that the Coding Agent Runner (CAR) needs to inject credentials into ephemeral sessions.

The invariant is zero-knowledge: no cleartext credential ever transits through, or persists on, Vauban Core. Sealing and unsealing happen client-side; Core only ever sees opaque sealed bundles. See [`docs/spec/cloud-resource-manager.md`](./docs/spec/cloud-resource-manager.md) §2.3 for the full statement.

## Quick start

Requires Node.js 20+ and npm 10+.

```bash
git clone https://github.com/sbw-vauban/cloud-resource-manager.git
cd cloud-resource-manager
npm install

# Copy the env example and fill in your Supabase credentials.
cp packages/web/.env.local.example packages/web/.env.local
# edit packages/web/.env.local

# Run the Next.js app on http://localhost:3000.
npm run dev
```

Other useful scripts (run from the repo root):

```bash
npm run type-check    # tsc --noEmit across all workspaces
npm run lint          # ESLint flat config, --max-warnings=0
npm run format        # prettier --write .
npm run format:check  # prettier --check .
npm run build         # next build + tsc -p tsconfig.build.json
npm run test          # Vitest unit suites
npm run test:e2e      # Playwright (requires .env.test, see docs/tests/e2e-tests.md)
```

## Documentation

The repo follows the Vauban six-pillars convention (`README.md` + `docs/{spec,decisions,handbook,tests,workflow}/`). Every commit that ships code also ships its doc — see `AGENTS.md` (harness-injected, not committed) for the doc-first contract.

- **Spec** — [`docs/spec/cloud-resource-manager.md`](./docs/spec/cloud-resource-manager.md) : vision, vocabulary, domain model, REST API, RLS rules, crypto layer, test posture, cutover plan.
- **Decisions** — [`docs/decisions/`](./docs/decisions/) : 6 founding ADRs (stack choice, crypto primitive, single-keypair-per-user, RLS minimaliste, secret-manager, greenfield rip-and-replace).
- **Handbook** — [`docs/handbook/`](./docs/handbook/) : 7 implementation stubs (crypto-zk, catalog-and-plugins, resources-and-access, secret-managers, exports-mcp-env, provisioning-rotation, audit-log). All marked "not yet implemented" in v1 init.
- **Tests** — [`docs/tests/integration-tests.md`](./docs/tests/integration-tests.md) and [`docs/tests/e2e-tests.md`](./docs/tests/e2e-tests.md) : scenarios planned, conventions, sweeper for orphaned cloud resources.
- **Workflow** — [`docs/workflow/coding-workflow.md`](./docs/workflow/coding-workflow.md) : CI pipeline, env variants, branch model, release process, rollback.

Build plans and orchestrated phases live under `.claude/build-plans/` (operator-side, harness-injected — not committed).

## Layout

```
.
├── packages/
│   ├── web/          Next.js 15 App Router app (deployed to Vercel)
│   ├── crm-catalog/  Types-only contracts for ResourceKind + SecretManager
│   └── core/         Placeholder for shared business logic (empty in v1 init)
├── supabase/
│   ├── migrations/   Numbered SQL migrations (applied to prod via GH Actions)
│   ├── config.toml   Supabase CLI local stack config
│   └── seed.sql      Local dev fixtures (empty)
├── .github/workflows/
│   ├── ci.yml                  type-check / lint / format / build / test on push to main
│   ├── supabase-migrations.yml apply migrations to the prod project on push to main
│   └── nightly.yml             E2E + sweeper stub (filled in later phases)
└── docs/             Spec, ADRs, handbook, tests, workflow — see above
```

## Contributing

Solo dev project in v1 — no formal PR process yet, see [`docs/workflow/coding-workflow.md`](./docs/workflow/coding-workflow.md) for the current rules. The doc-first contract (handbook, test plan, and ADR updates ship together with the code they describe) is enforced by the harness, even though `AGENTS.md` itself is not committed.

## License

UNLICENSED — proprietary, all rights reserved. See [`LICENSE`](./LICENSE) if present (none committed at v1 init).
