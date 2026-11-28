---
title: Code quality
tracks:
  - eslint.config.js
  - tsconfig.base.json
  - apps/gateway/tests/unit/structural/
  - vitest.config.ts
last_reviewed: 2026-11-28
---

# Code quality

What a change must hold before it reaches `main`. The tools enforce most of it; the project rules
cover what they cannot see yet, each one checkable by reading the diff. Nobody reviews the pull
request: the agent that writes the change checks these rules itself, then merges on a green CI
([coding workflow](../workflow/coding-workflow.md)).

## Mechanical checks

`npm run check:changed` runs them on the changed workspaces before each commit; CI
(`.github/workflows/ci.yml`) runs them all.

- **TypeScript** — `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `useUnknownInCatchVariables`.
- **ESLint** — `eslint.config.js`, `recommendedTypeChecked` plus `no-floating-promises`,
  `no-misused-promises`, `consistent-type-imports`, `no-unused-vars` (`_` prefix to ignore) and
  `no-console` (only `warn` and `error`). `npm run lint` runs with `--max-warnings=0`: a warning
  fails like an error. Two repo-specific rules:
  - a file under `plugins/` imports `@vaubaan/plugin-sdk` and nothing else of the gateway, by
    package or by path (ADR [plugin-contract-and-credential-spec](../decisions/plugin-contract-and-credential-spec.md));
  - the host never tests an SDK error with `instanceof`, only with its guard (`isUpstreamAuthError`…):
    a pinned plugin carries its own copy of the SDK (ADR
    [plugins-bundled-or-pinned-by-the-operator](../decisions/plugins-bundled-or-pinned-by-the-operator.md)).
- **Prettier** — `.prettierrc` (100 columns, single quotes, trailing commas); `npm run format:check`.
- **Semgrep** — `.semgrep/vaubaan.yml` through `scripts/sast.sh`: no `process.env` in plugins, no
  dynamic code, `child_process` only in allowed modules, encryption only in the crypto module, no
  weak hash, no secret-bearing value logged, no TLS verification off, no plugin `fetch` without a
  redirect policy.
- **Supply chain** — `scripts/audit-gate.mjs` (npm audit against the reviewed allowlist),
  `scripts/lockfile-gate.mjs` (every entry from the npm registry with a sha512 integrity),
  actionlint on the workflows, shellcheck on every `*.sh` and git hook.
- **Secrets** — gitleaks over the whole history (`scripts/secret-scan.sh`, exceptions in
  `.gitleaks.toml`), on every branch push (`.github/workflows/ci.yml`).
- **Docs** — `npx vaubaan-harness lint`: schema, links, `tracks`, generated files fresh.
- **Structural tests** — `apps/gateway/tests/unit/structural/`, indexed by `manifest.ts` and
  `index.test.ts` (every invariant keeps a live proof). The ones that guard code shape:
  - `client-imports` — a `'use client'` file never pulls a server module;
  - `named-barrels` — package barrels name their exports, no `export *`;
  - `keyed-lookups` — tokens, shares and held arguments are read only with their parent (no IDOR);
  - `no-arguments-in-logs` — no logger call carries call arguments in clear;
  - `no-hardcoded-config` — no literal URL, secret or project reference in server code;
  - `persisted-enumerations` — persisted restrictions are closed lists, never wildcards;
  - `module-mocks-isolated` — a `vi.mock` lives only in the isolated project of `vitest.config.ts`;
  - `one-word-per-thing`, `no-french-vocabulary` — the words of
    ADR [one-word-per-thing-account-service-plugin](../decisions/one-word-per-thing-account-service-plugin.md);
  - `plugin-transport`, `plugin-names-declared-once`, `plugin-identifier-tests`,
    `plugin-versions` — a plugin reads answers through the SDK transport, names its tools once,
    tests hostile identifiers, and declares one version.

## Project rules

1. **A source file stays at or under 800 lines; a file already over it only shrinks.**
   30 files were over 800 on 2026-11-28 (`lib/vocabulary.ts` 2158, `missions/mission-service.ts`
   1771); the live list is the baseline of
   `apps/gateway/tests/unit/structural/file-size-budget.test.ts`, which enforces the rule and may
   only lose entries or lines. Check: `wc -l` on every touched file.
2. **A service class exposes at most 30 public methods; past that, it splits by use case.**
   `missions/mission-service.ts` was split on 2026-11-20, regrew to ≈59 methods, and was split
   again on 2026-11-28: 29 public methods that delegate to use-case modules over a shared
   `mission-lookups.ts`; `accounts/service.ts` held ≈70 methods until its use cases left for
   modules of their own the same day. Check: a diff that adds a public method to a class over the
   budget moves at least as many out to a use-case module.
3. **A `catch` without binding rethrows, logs, or carries a `// expected: <why>` comment.**
   On 2026-11-28, 95 catches ignored their error in `apps/gateway/src` outside four folders:
   81 now say why (`// expected: …`, 16 of them an older comment reworded), 3 lost a real failure
   and now log it (telemetry ×2, the pinned catalog of a plugin activation), 11 already rethrew,
   logged or said why. `server/accounts`, `auth`, `execution` and `git` are listed as not yet
   under the rule. Check: `apps/gateway/tests/unit/structural/no-silent-catch.test.ts`, which
   enforces it; its exception set may only lose folders.
4. **No backward-compatible code: no redirect, alias, tolerated old key or "legacy" branch.**
   Only the team runs the gateway (owner decision 2026-11-26); a throwaway script migrates existing
   data instead, and is not kept. Check: grep the diff for `legacy`, `old`, `before migration`,
   `fallback to`. Protocol paths stay (see Accepted deviations).
5. **A schema change is a new numbered migration; an applied migration is never edited.**
   Migrations are forward-only and checksummed (`apps/gateway/migrations/0001…0043`), tables are
   `STRICT`, and a closed-set column is read through `parseEnum` ([store handbook](../handbook/store.md),
   ADR [embedded-store-sqlite-and-migrations](../decisions/embedded-store-sqlite-and-migrations.md)).
   Check: the diff adds a file under `migrations/`, never modifies one; a new enum column has its
   `parseEnum` in the mapper.
6. **New source code adds no non-null `!` and no `as unknown as`; it narrows instead.**
   Source holds 140 `!` and 15 `as unknown as` today, each a type the compiler stopped checking.
   Tests are exempt (1051 `!` there). Check: the counts in `apps/*/src`, `packages/*/src` and
   `plugins/*/src` never grow in a diff.
7. **Server modules depend in one direction: a diff adds no new mutual import between two
   modules of `apps/gateway/src/server/`.**
   Two cycles exist (`accounts`↔`auth`, `execution`↔`git`); `compose/` (`root.ts` and its
   `wire-*.ts`) is the one place that imports nearly every module (31 of 35). Check: a new
   `from '../<module>/'` import, and whether `<module>` already imports back; shared code moves
   down, not sideways.

## Accepted deviations

- **The files over 800 lines on 2026-11-28** — listed in the baseline of the file-size budget, each one may
  only shrink (rule 1).
- **The two mutual module dependencies** `accounts`↔`auth` and `execution`↔`git` — existing, not
  to be copied (rule 7).
- **Protocol paths and public website redirects** — `/connections/callback`, `/r`, `/mcp`, `/api`
  and the site's redirects keep their old forms: clients outside the team call them (rule 4).
- **`no-control-regex` disabled line by line** — in input validators that refuse control
  characters (`server/http/return-to.ts`, `server/groups/service.ts`, `plugins/onedrive/src/identifiers.ts`…):
  matching them is the point; each disable says so.
- **`preserve-caught-error` disabled in `server/mail/index.ts`** — an SMTP error can quote the
  address; the cause is withheld on purpose.
- **`no-unsafe-*` and `no-console` off for `scripts/**` and `apps/desktop/scripts/*.mjs`** — ops
  scripts in plain `.mjs` get Node types as `any` and print to stdout by design (`eslint.config.js`).
- **`require-await`, `no-base-to-string`, `unbound-method` off** — reasons in `eslint.config.js`:
  promise-returning contracts, the policy engine's deliberate string coercion, test mocks.
- **`exactOptionalPropertyTypes: false`** in `tsconfig.base.json` — `undefined` and an absent key
  are treated alike across the codebase.
- **`docs/research/` is in French** — archived working sessions saved byte for byte; each file is
  a named exception, with its reason, in `no-french-vocabulary.test.ts`.
