---
title: Plugin catalogs are located with a filesystem path helper and traced into the standalone output
status: accepted
date: 2026-10-13
extends:
  - plugin-contract-and-credential-spec
  - docker-image-and-config-format
amends:
  - plugin-contract-and-credential-spec
---

# Plugin catalogs are located with a filesystem path helper and traced into the standalone output

> How a plugin finds its `risk-catalog.yaml` at import time so that the same
> line works in vitest, `next dev`, `next build` (Turbopack) and the
> standalone server inside the Docker image, and how the build is told to
> ship the YAML files. Fixes the pattern that ADR
> [[plugin-contract-and-credential-spec]] D4 documented
> (`loadCatalogFile(new URL('./risk-catalog.yaml', import.meta.url))`).
> Implemented in P1.2-SDK.

## Context

The plugin SDK loads the catalog from disk at module import (ADR
plugin-contract D4 : YAML is the only catalog artefact, the TypeScript twins
are gone). The template, `plugins/README.md` and the handbook showed
`loadCatalogFile(new URL('./risk-catalog.yaml', import.meta.url))`.

The stripe migration (P1.2e) found two problems when `apps/gateway` imports
a plugin :

1. **Turbopack rewrites the literal.** Next.js 16 builds the server with
   Turbopack, which recognises `new URL('<literal>', import.meta.url)` as an
   asset reference and rewrites it into `/_next/static/media/<hash>.yaml`.
   `loadCatalogFile` then throws during page-data collection and
   `next build` fails. `join(dirname(fileURLToPath(import.meta.url)),
'risk-catalog.yaml')` is a plain expression the bundler leaves alone.
   In the server bundle Turbopack compiles `import.meta.url` into a
   runtime `file:` URL built from the chunk's own location and the source
   path relative to the tracing root (`plugins/stripe/src/index.ts`), so
   the computed path points at `<output root>/plugins/stripe/src/
risk-catalog.yaml` wherever the server runs from — the repository in
   `next dev`/`next start`, `.next/standalone` in the image. The build
   passed, and stripe switched to it with a local comment.
2. **The YAML is not traced.** `output: 'standalone'` copies only the files
   Next's file tracer (nft) can see from the route graph. A `readFileSync`
   behind a computed path is invisible to it, so the standalone output —
   and therefore the Docker image — contains the plugin's compiled module
   but not its `risk-catalog.yaml`. The container would fail at boot with
   `ENOENT` as soon as a plugin is registered in the composition root.

Both would have been copied by the four parallel migrations, each with its
own fix.

## Decision

### D1 — One SDK helper owns the path computation

`catalogPathNextTo(moduleUrl, fileName = 'risk-catalog.yaml')` in
`@vaubaan/plugin-sdk` returns `join(dirname(fileURLToPath(moduleUrl)),
fileName)`. It accepts the `import.meta.url` string or a `URL`, and throws a
named error when the URL is not `file:` — the symptom of a bundler rewrite —
instead of letting `readFileSync` fail with an `ENOENT` far from the cause.
Every plugin writes :

```ts
export const myCatalog = loadCatalogFile(catalogPathNextTo(import.meta.url));
```

The template, the SDK fixture, `plugins/README.md`, the handbook and the
`definePlugin` error message use this form. The literal
`new URL('./risk-catalog.yaml', import.meta.url)` is retired from the
documentation.

### D2 — The build traces every plugin YAML with one glob

`apps/gateway/next.config.ts` adds `'../../plugins/*/src/**/*.yaml'` to
`outputFileTracingIncludes['/*']`. Paths are relative to the Next project
root (`apps/gateway`) ; with `outputFileTracingRoot` at the repository
root the files land in `.next/standalone/plugins/<id>/src/risk-catalog.yaml`,
which is exactly the path a module at `plugins/<id>/src/index.ts` computes
relative to itself, both in the image (`/app/plugins/…`, build and runtime
share `WORKDIR /app`) and locally. No per-plugin entry : a new plugin is
traced the day it is added.

In the same file `transpilePackages` no longer enumerates plugins by hand :
the P0 cycle-end pass derives it from the app's own `package.json`
dependencies (`workspaceDependencies()`), so a plugin is transpiled the day
`apps/gateway` depends on it — one source for the provider list, no second
list in the build config.

### D3 — Tests prove the path in both contexts

- `plugins/_template/tests/unit/plugin.test.ts` recomputes the template
  catalog path with the helper and asserts it exists on disk (vitest).
- `packages/plugin-sdk/tests/unit/catalog-path.test.ts` covers the helper :
  default name, `URL` input, the fixture resolving to a readable file, and
  the two rewrite shapes (`https://…/_next/static/media/…`, bare
  `/_next/static/…`) raising the named error.
- `apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts`
  (`describe.skipIf` when `.next/standalone` is absent, like the native
  addons test) asserts the template YAML and every
  `plugins/*/src/risk-catalog.yaml` of the repository are present in the
  standalone output after `next build`. CI builds before testing, so it
  runs there.

## Consequences

- A plugin author copies one line and never meets the Turbopack rewrite ;
  the explanation lives in the helper's doc comment, not in ten plugins.
- The Docker image ships every catalog ; `deploy/docker/smoke.sh` boots the
  image and would catch a regression once plugins are registered.
- `next.config.ts` reads the filesystem at config time (plugins folder).
  It already did for `package.json` ; the cost is a directory listing.
- The stripe plugin's local `join(dirname(fileURLToPath(...)))` keeps
  working and is replaced by the helper in P1.2-align, with the other
  plugins.
- Negative : the helper hides a bundler-specific pitfall behind a name,
  so a reader must follow the reference to understand why the obvious
  pattern is forbidden. Accepted : the comment in the template and this
  ADR carry the reason.

## Rejected alternatives

### Externalize `@vaubaan/plugin-*` with `serverExternalPackages`

Would make Node load the plugins from `node_modules` at runtime, where nft
traces whole packages (YAML included). But the plugins are TypeScript
sources (`exports: ./src/index.ts`) with no build step ; Node cannot load
them without transpilation, so externalizing them means adding a `tsc`
build to every plugin, publishing `dist/`, and keeping `plugins/*` in sync
with the app build. Far heavier than one tracing glob, for a layout the
repository ADR deliberately keeps workspace-internal. Rejected.

### Import the YAML as a module (Turbopack `?raw` rule or a loader)

Makes the catalog a bundler artefact : the SDK would need a bundler-aware
import in plugins, vitest and plain Node would need their own handling, and
`loadCatalogFile`'s path-qualified error messages would lose the source
path. Rejected ; the file stays a file.

### Keep the TypeScript catalog twins

The v4 workaround for Vercel's Lambda bundling, retired by the plugin
contract ADR because two sources of truth for the security artefact under
review is what the sync tests were compensating for. Rejected again.

### Copy the YAML files in the Dockerfile

A `COPY plugins/*/src/*.yaml` line would fix the image but not
`.next/standalone` locally, where the integration test and `next start`
run ; it also duplicates in the Dockerfile a fact about the build. Rejected
; tracing is the mechanism Next provides for exactly this.

## References

- ADR amended : [[plugin-contract-and-credential-spec]] D4 ; context
  [[docker-image-and-config-format]] (standalone output, nft tracing) ;
  sibling [[fallback-risk-only-when-uncategorized]].
- Handbook : [[plugin-sdk]] ("Catalog path").
- Code : `packages/plugin-sdk/src/catalog-path.ts`,
  `apps/gateway/next.config.ts`,
  `apps/gateway/tests/integration/standalone-plugin-catalogs.test.ts`,
  `plugins/_template/src/index.ts`.
- Next.js : `outputFileTracingIncludes` (route globs → file globs resolved
  from the project root), `output: 'standalone'`.
