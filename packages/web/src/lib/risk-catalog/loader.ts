/**
 * Risk-catalog loader — boots once per Next.js runtime, imports every
 * provider's `risk-catalog.ts` (a static TS export — no YAML at runtime),
 * validates them via `indexCatalog` (`@vaubaan/policy-engine`), and caches
 * the `IndexedRiskCatalog` per provider in module scope.
 *
 * Spec : docs/spec/gateway-risk-model.md §1, §4, ADR D8.
 *
 * Design notes
 *  - The catalog is statically loaded at module init. We import the TS
 *    exports directly from each provider package : Vercel's Next.js
 *    bundler does NOT include `.yaml` files in the Lambda bundle, so the
 *    earlier `readFileSync`-based loader broke at runtime in production
 *    (all mints returned `risk catalog for provider 'X' is not loaded`).
 *    The TS exports are bundled like any other code path.
 *  - The YAML siblings (`packages/providers/<vendor>/src/risk-catalog.yaml`)
 *    remain the canonical reviewable form ; a per-provider unit test
 *    (`tests/unit/risk-catalog-sync.test.ts`) lints that the two stay in
 *    sync.
 *  - This module is intentionally NOT exported from a shared package : it
 *    is a web-side concern (next.js runtime, jsonb boundary). Other
 *    runtimes can build their own loader.
 */

import { githubRiskCatalog } from '@vaubaan/providers-github';
import { vercelRiskCatalog } from '@vaubaan/providers-vercel';
import { supabaseRiskCatalog } from '@vaubaan/providers-supabase';
import { railwayRiskCatalog } from '@vaubaan/providers-railway';
import { sshRiskCatalog } from '@vaubaan/providers-ssh';
import { upstashRedisRiskCatalog } from '@vaubaan/providers-upstash-redis';
import { gmailRiskCatalog } from '@vaubaan/providers-gmail';
import { stripeRiskCatalog } from '@vaubaan/providers-stripe';
import {
  indexCatalog,
  qualifyRiskId as engineQualifyRiskId,
  unqualifyRiskId as engineUnqualifyRiskId,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
import type { Provider, RiskCatalog } from '@vaubaan/shared';

/** All providers we know about. Keep in sync with `Provider` in shared. */
const PROVIDERS: readonly Provider[] = [
  'github',
  'vercel',
  'supabase',
  'railway',
  'bash',
  'ssh',
  'upstash-redis',
  'gmail',
  'stripe',
];

/** Provider → its TS-exported risk catalog. The `bash` provider key maps
 *  to the SSH provider package (cf. shared/src/types.ts — historic naming). */
const PROVIDER_CATALOGS: Record<Provider, RiskCatalog> = {
  github: githubRiskCatalog,
  vercel: vercelRiskCatalog,
  supabase: supabaseRiskCatalog,
  railway: railwayRiskCatalog,
  bash: sshRiskCatalog,
  ssh: sshRiskCatalog,
  'upstash-redis': upstashRedisRiskCatalog,
  gmail: gmailRiskCatalog,
  stripe: stripeRiskCatalog,
};

/** Per-provider cache, built once on first call to `getCatalog`. `undefined`
 *  means the catalog failed validation — the provider's runtime path will
 *  refuse the call with a typed error. */
const CACHE: Map<Provider, IndexedRiskCatalog | undefined> = new Map();
let initialised = false;

/** Validate one provider's static TS catalog. Returns `undefined` on any
 *  error and logs a warning. Errors are non-fatal so the web app keeps
 *  booting even if a provider's catalog is malformed. */
function tryIndexCatalog(provider: Provider, catalog: RiskCatalog): IndexedRiskCatalog | undefined {
  try {
    // We use `indexCatalog` (not `prepareCatalog`) on purpose : the latter
    // enforces the RISK_ID_REGEX which today is stricter than the catalogs
    // we ship (the cardinality-marker `.W` / `.R` suffix is upper case
    // while the regex requires `[a-z][a-z0-9-]+` per segment). The strict
    // regex check belongs to the catalog-author lint (a CI gate), not to
    // the boot-time loader — fail-soft here so the gateway keeps serving
    // the well-formed catalogs even if one author shipped a legacy-segment
    // id.
    return indexCatalog(catalog);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.warn(`[risk-catalog-loader] catalog for '${provider}' failed validation: ${message}.`);
    return undefined;
  }
}

function ensureInitialised(): void {
  if (initialised) return;
  initialised = true;
  for (const provider of PROVIDERS) {
    const catalog = PROVIDER_CATALOGS[provider];
    CACHE.set(provider, tryIndexCatalog(provider, catalog));
  }
}

/** Public API : fetch the indexed catalog for a provider. Returns
 *  `undefined` if the catalog failed to load — caller should reject the
 *  request with a 4xx. */
export function getCatalog(provider: Provider): IndexedRiskCatalog | undefined {
  ensureInitialised();
  return CACHE.get(provider);
}

/** Public API : test-only seam to inject a pre-built catalog (skips static
 *  import). Useful for unit tests so we can exercise a minimal catalog. */
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
//
// The implementations live in `@vaubaan/policy-engine` (centralised so the
// mint-form client and the runtime use the same code). We re-export here
// for backward compatibility with existing call sites in `web/`.
// ─────────────────────────────────────────────────────────────────────────────

export const qualifyRiskId = engineQualifyRiskId;
export const unqualifyRiskId = engineUnqualifyRiskId;

/** Public API : compute the IndexedRiskCatalog for all providers. Useful
 *  for endpoints that want to walk every catalog (e.g. a /api/v1/catalog
 *  refresh). Returns only providers whose catalog loaded successfully. */
export function getAllCatalogs(): Partial<Record<Provider, IndexedRiskCatalog>> {
  ensureInitialised();
  const out: Partial<Record<Provider, IndexedRiskCatalog>> = {};
  for (const provider of PROVIDERS) {
    const c = CACHE.get(provider);
    if (c) out[provider] = c;
  }
  return out;
}
