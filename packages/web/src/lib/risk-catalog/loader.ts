/**
 * Risk-catalog loader — boots once per Next.js runtime, reads every
 * `packages/providers/<vendor>/src/risk-catalog.yaml`, validates them via
 * `indexCatalog` (`@vaubaan/policy-engine`), and caches the
 * `IndexedRiskCatalog` per provider in module scope.
 *
 * Spec : docs/spec/gateway-risk-model.md §1, §4, ADR D8.
 *
 * Design notes
 *  - The catalog is **statically loaded at module init** (top-level
 *    `try/catch` per provider). A missing or malformed YAML emits a
 *    `console.warn` and the provider's catalog stays `undefined` — the
 *    preview/mint endpoints check `getCatalog(provider)` and refuse the
 *    request with a clear 4xx if absent. The five provider worktrees are
 *    expected to ship the catalogs in parallel.
 *  - We resolve the YAML path **once** per call to `loadAllCatalogs` (the
 *    initializer) using `fileURLToPath(import.meta.url)` as the anchor —
 *    works in both the Node.js runtime and the Vercel Node Lambda.
 *  - This module is intentionally NOT exported from a shared package : it
 *    is a web-side concern (next.js runtime, filesystem reads, jsonb
 *    boundary). Other runtimes can build their own loader.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import yaml from 'js-yaml';
import { indexCatalog, type IndexedRiskCatalog } from '@vaubaan/policy-engine';
import type { Provider, RiskCatalog, RiskEntry, RiskId } from '@vaubaan/shared';

/** Vendor → YAML path relative to repo root. The five provider worktrees
 *  ship these files in parallel. Keep in sync with
 *  `packages/providers/<vendor>/src/risk-catalog.yaml`. */
const CATALOG_RELATIVE_PATHS: Record<Provider, string> = {
  github: 'packages/providers/github/src/risk-catalog.yaml',
  vercel: 'packages/providers/vercel/src/risk-catalog.yaml',
  supabase: 'packages/providers/supabase/src/risk-catalog.yaml',
  railway: 'packages/providers/railway/src/risk-catalog.yaml',
  bash: 'packages/providers/ssh/src/risk-catalog.yaml',
};

/** All providers we know about. Keep in sync with `Provider` in shared. */
const PROVIDERS: readonly Provider[] = ['github', 'vercel', 'supabase', 'railway', 'bash'];

/** Compute the repo root from this module's location. We're at
 *  `packages/web/src/lib/risk-catalog/loader.ts` — five levels deep. */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // .../packages/web/src/lib/risk-catalog → up 5 to repo root
  return resolvePath(here, '..', '..', '..', '..', '..');
}

/** Per-provider cache, built once on first call to `getCatalog`. `undefined`
 *  means the YAML is missing or invalid — the provider's runtime path will
 *  refuse the call with a typed error. */
const CACHE: Map<Provider, IndexedRiskCatalog | undefined> = new Map();
let initialised = false;

/** Try to load + validate one provider's YAML catalog. Returns `undefined`
 *  on any error and logs a warning. Errors are non-fatal so the web app
 *  keeps booting even if a provider worktree hasn't shipped its catalog. */
function tryLoadCatalog(provider: Provider, absolutePath: string): IndexedRiskCatalog | undefined {
  let raw: string;
  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(
      `[risk-catalog-loader] could not read catalog for provider '${provider}' at '${absolutePath}': ${message}. ` +
        `Risk-based mint flow will reject calls for this provider until the file is committed.`,
    );
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[risk-catalog-loader] YAML parse failed for provider '${provider}': ${message}.`);
    return undefined;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('provider' in parsed) ||
    !('risks' in parsed)
  ) {
    console.warn(
      `[risk-catalog-loader] catalog for '${provider}' does not have the {provider,risks} shape.`,
    );
    return undefined;
  }
  try {
    // We use `indexCatalog` (not `prepareCatalog`) on purpose : the latter
    // enforces the RISK_ID_REGEX which today is stricter than the YAML
    // catalogs we ship (the cardinality-marker `.W` / `.R` suffix is upper
    // case while the regex requires `[a-z][a-z0-9-]+` per segment). The
    // strict regex check belongs to the catalog-author lint (a CI gate),
    // not to the boot-time loader — fail-soft here so the gateway keeps
    // serving the well-formed catalogs even if one author shipped a
    // legacy-segment id.
    return indexCatalog(parsed as RiskCatalog);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[risk-catalog-loader] catalog for '${provider}' failed validation: ${message}.`);
    return undefined;
  }
}

function ensureInitialised(): void {
  if (initialised) return;
  initialised = true;
  const root = repoRoot();
  for (const provider of PROVIDERS) {
    const rel = CATALOG_RELATIVE_PATHS[provider];
    const abs = resolvePath(root, rel);
    CACHE.set(provider, tryLoadCatalog(provider, abs));
  }
}

/** Public API : fetch the indexed catalog for a provider. Returns
 *  `undefined` if the YAML failed to load — caller should reject the
 *  request with a 4xx. */
export function getCatalog(provider: Provider): IndexedRiskCatalog | undefined {
  ensureInitialised();
  return CACHE.get(provider);
}

/** Public API : test-only seam to inject a pre-built catalog (skips disk
 *  read). Useful for unit tests so we don't need real YAML on the filesystem. */
export function __setCatalogForTests(
  provider: Provider,
  indexed: IndexedRiskCatalog | undefined,
): void {
  initialised = true;
  CACHE.set(provider, indexed);
}

/** Public API : test-only seam to reset the module state between tests. */
export function __resetForTests(): void {
  initialised = false;
  CACHE.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk-id qualification helpers (spec §4.4)
// ─────────────────────────────────────────────────────────────────────────────

/** Turn a non-env-qualified `RiskId` (e.g. `supabase.bulk-row-write`) into
 *  its env-qualified form (`supabase[staging].bulk-row-write`) when the
 *  catalog declares the risk as env-scoped (i.e. has `acceptable_in_envs`
 *  set OR the caller asks for a specific env binding). The non-qualified
 *  form is returned unchanged when the env is null or when the entry is
 *  not env-scoped.
 *
 *  Rule (cf. ADR §D2) :
 *   - `<provider>[<env>].<name>`  : env-scoped, env is a slug
 *   - `<provider>.<name>`         : account-scope / not env-bound
 *
 *  Note: the YAML stores the **non-qualified** id ; qualification is a
 *  presentation/wire concern, computed per binding at mint time. */
export function qualifyRiskId(
  baseId: RiskId,
  env: string | null,
  entry: RiskEntry | undefined,
): RiskId {
  if (env === null || env.length === 0) return baseId;
  // Only inject env when the catalog entry says this risk is env-scoped.
  // Convention : `acceptable_in_envs` non-empty ⇒ env-scoped. Account-scope
  // entries (e.g. `github.mint-install-token`) leave it absent and stay
  // non-qualified across bindings.
  if (!entry || !entry.acceptable_in_envs || entry.acceptable_in_envs.length === 0) {
    return baseId;
  }
  // Already qualified ? Leave alone (defensive).
  if (/\[[a-z][a-z0-9-]*\]/.test(baseId)) return baseId;
  // Insert `[env]` between provider and the first dot.
  const dot = baseId.indexOf('.');
  if (dot < 0) return baseId; // shouldn't happen per regex
  const provider = baseId.slice(0, dot);
  const rest = baseId.slice(dot);
  return `${provider}[${env}]${rest}`;
}

/** Inverse of `qualifyRiskId` — strip the `[env]` qualifier to recover the
 *  base id used as the lookup key in the YAML catalog. Returns the input
 *  unchanged if it has no env qualifier. */
export function unqualifyRiskId(qualifiedId: RiskId): RiskId {
  return qualifiedId.replace(/\[[a-z][a-z0-9-]*\]/, '');
}

/** Public API : compute the IndexedRiskCatalog for all providers. Useful
 *  for endpoints that want to walk every catalog (e.g. a /api/v1/catalog
 *  refresh). Returns only providers whose YAML loaded successfully. */
export function getAllCatalogs(): Partial<Record<Provider, IndexedRiskCatalog>> {
  ensureInitialised();
  const out: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const provider of PROVIDERS) {
    const c = CACHE.get(provider);
    if (c) out[provider] = c;
  }
  return out;
}
