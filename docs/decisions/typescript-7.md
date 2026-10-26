---
title: TypeScript stays on 6.0 until typescript-eslint supports TypeScript 7
status: proposed
date: 2026-10-26
author: Renaud Pelissier (product owner), drafted with Claude
extends:
  - repository-layout-and-contribution-workflow
  - ci-billed-minutes-budget
---

# TypeScript stays on 6.0 until typescript-eslint supports TypeScript 7

> Asked by the product owner on 2026-10-26: take every major of Dependabot's
> pull request #124, TypeScript 7 included. Status `proposed`: TypeScript 7
> is not adopted; the blocker and the condition to revisit are below.
> Procedure: [coding-workflow](../workflow/coding-workflow.md), "TypeScript
> and lint baseline", "Dependency updates".

## Context

Dependabot proposed `typescript` 5.9.3 → 7.0.2. TypeScript 7 is the native
(Go) compiler. Its `tsc` is fast: on this repository, a full check without
build info takes 2.5 s for `apps/gateway` against 15.2 s with TypeScript 6
(0.3 s against 2.2 s for `plugins/github`). Type-checking runs in every CI
gate (`npm run type-check`, then the image build's own `next build` pass),
and CI is budgeted in billed minutes (ADR
[ci-billed-minutes-budget](ci-billed-minutes-budget.md)): a faster check is
a real saving.

But TypeScript 7.0 **ships no compiler API**: the `typescript` package's
main export is `lib/version.cjs` (`version`, `versionMajorMinor`), the
API is announced "new and different" for 7.1, and the unstable
`typescript/unstable/*` exports are not the API tools use today. Tried on
this tree (2026-10-26):

- **typescript-eslint** (8.71.2, and 8.72.0, the latest) declares the peer
  `typescript >=4.8.4 <6.1.0`. Its typed rules (`recommendedTypeChecked`,
  `no-floating-promises`, `no-misused-promises`… — `eslint.config.js`)
  run on the TypeScript program. With 7.0.2 installed, `npm run lint`
  stops at once: "typescript-eslint does not support TS 7.0", pointing at
  the side-by-side setup below and at typescript-eslint issue #10940
  (support for TypeScript ≥ 7.1).
- **Our own tests** use the compiler API to read source:
  `tests/unit/structural/index.test.ts`, `authority-not-snapshotted`,
  `plugin-identifier-tests`, `no-arguments-in-logs` and
  `tests/integration/audit/admin-mutations.test.ts`
  (`ts.createSourceFile`, `ts.forEachChild`, `ts.is*`). Under 7.0 they do
  not compile (`Property 'createSourceFile' does not exist`) and would not
  run.
- **Next.js 16.4** is not a blocker: its build-time check runs the
  package's `tsc` binary by default (`experimental.useTypeScriptCli`
  defaults to `true`), not the API. With 7.0 installed, `next build`
  started its check through 7.0's `tsc` and stopped on the same test files.
- The **configuration** is ready: no option TypeScript 6 deprecates and 7
  removes (`baseUrl`, `moduleResolution: node10`, `target: es5`,
  `downlevelIteration`, `esModuleInterop: false`, `alwaysStrict: false`…)
  is used, every `tsconfig.json` names its `types`, and TypeScript 7's
  `tsc` checks every workspace with no error once the API-based test
  files can import a TypeScript that has the API.

TypeScript 6.0 is the last JavaScript compiler, the bridge release: it
deprecates what 7 removes, keeps the API, and is inside typescript-eslint's
range.

## Decision

1. **TypeScript 6.0.3** is the repository's compiler (root `devDependencies`,
   exact pin; `^6.0.3` in `plugins/ssh`). Nothing else changed: every
   workspace type-checks, lints, builds and tests under it as it did under
   5.9.
2. **TypeScript 7 is not adopted yet.** Dependabot ignores `typescript`
   7 and above (`.github/dependabot.yml`, comment pointing here), so the
   weekly majors pull request stops proposing it; 6.x patches and minors
   still come.
3. **Revisit when** typescript-eslint publishes a version whose peer range
   includes TypeScript 7 (issue #10940; expected with the TypeScript 7.1
   API). Then, in one pull request: TypeScript 7, that typescript-eslint,
   the five test files ported to the new API (or to a parser that does not
   need it), `next build` run once without `VAUBAAN_BUILD_TYPECHECKED`, the
   Dependabot ignore removed, and this ADR accepted
   or superseded with the measured CI time.

## Consequences

### Positive

- The upgrade path is clean: TypeScript 6 reports, as errors, the options
  7 removes; none is used, so the move to 7 will be a version change.
- One compiler, one program: the type-check and the type-aware lint see
  the same types.
- Dependabot's majors pull request no longer carries an update nobody can
  merge.

### Negative / constraints

- The CI gate keeps TypeScript 6's speed: about 13 s more per full check
  of `apps/gateway` than TypeScript 7 would take, less when the build info
  is cached (`scripts/type-check.mjs` is incremental), plus the image
  build's own pass.
- The Dependabot ignore must be removed by hand when the condition is met;
  until then, nothing reminds us but this ADR and typescript-eslint's
  release notes.

## Rejected alternatives

### TypeScript 7 alone, now

Not possible without giving up the typed lint rules (typescript-eslint
refuses to start) and the five structural tests. Both guard real
invariants (unhandled promises; authority not snapshotted; every
administrative mutation audited); dropping them for a faster compiler is
the wrong trade.

### TypeScript 7 and 6 side by side (npm aliases)

TypeScript 7's announcement documents it: `typescript` aliased to
`@typescript/typescript6` for the tools that import it (typescript-eslint,
our tests), and `@typescript/native` aliased to `typescript@7`
for `tsc`. It works, and would give the fast check today. Rejected for
now: two compilers that may disagree, the type-check on one and the
typed lint on the other; a package named `typescript` that is not
TypeScript, which Dependabot, the lockfile gate and every contributor's
editor have to see through; and `scripts/type-check.mjs`, the
documentation and the image build to change for a setup that the
TypeScript 7.1 API is meant to end. If the 7.1 API is late and the CI
minutes press, this is the first option to reopen.

### Stay on 5.9

Nothing gained: 6.0 passes the whole gate unchanged, stays in
typescript-eslint's range, and turns what 7 removes into errors now.

### Drop typescript-eslint's typed rules for a faster linter

Out of scope of a dependency update, and the typed rules
(`no-floating-promises`, `no-misused-promises`) are the ones the gateway
relies on (coding-workflow, "TypeScript and lint baseline").

## References

- Dependabot pull request #124 (superseded by the pull request carrying
  this ADR).
- TypeScript 7.0 announcement, "Running side-by-side with TypeScript 6.0".
- typescript-eslint issue #10940 (support for TypeScript ≥ 7.1).
- ADR [ci-billed-minutes-budget](ci-billed-minutes-budget.md).
