/**
 * Risk-catalog loader — YAML in, validated and indexed catalog out.
 *
 * This module is the entry point ; the rules live beside it :
 * `catalog-document.ts` and `catalog-risk-entry.ts` (structure),
 * `catalog-rules.ts` (semantics, also run on a TypeScript catalog).
 *
 * Spec : docs/spec/gateway-risk-model.md §4 (schema, versioning, mandatory
 *        fallback), §4.6 (macro-actions : every entry in exactly one, each
 *        with a base budget).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md (YAML loaded
 *        at boot, TypeScript twins retired) ;
 *        docs/decisions/fallback-risk-only-when-uncategorized.md (one
 *        fallback per catalog, flagged `fallback: true`, in no macro-action) ;
 *        docs/decisions/macro-actions-and-trust-crans-prefill-the-policy.md
 *        (presets retired : a catalog with a `presets` key does not load).
 *
 * The loader is strict : any structural issue, unknown key, malformed id,
 * duplicate, missing fallback, fallback that is not the catch-all write,
 * a `presets` key, a foreign or fallback macro-action entry, an entry in no
 * macro-action, or an illegal budget fails the boot with every issue listed, path-qualified
 * (`risks[3].vector.blast`). The semantic rules (`semanticIssues`) also run
 * on a catalog written in TypeScript, through `definePlugin`, the registry
 * and the test kit — the budget rule itself is `budgetIssues` of the policy
 * engine, shared with the application. Its one warning : a fallback
 * recognised by convention (pattern or id) instead of the `fallback: true`
 * flag — accepted for third-party catalogs, refused by the test kit.
 * A catalog is reviewed in a pull request ; the loader is the CI gate that
 * makes the review mechanical.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CORE_SCHEMA, YAMLException, load } from 'js-yaml';

import { prepareCatalog, type IndexedRiskCatalog } from '@vaubaan/policy-engine';
import type { MacroAction, RiskCatalog } from '@vaubaan/shared';

import { structuralIssues } from './catalog-document.ts';
import { catalogWarnings, semanticIssues, type SemanticOptions } from './catalog-rules.ts';

/** A catalog as the SDK requires it : macro-actions present. */
export interface PluginCatalog extends RiskCatalog {
  readonly macro_actions: readonly MacroAction[];
}

export interface LoadedCatalog {
  readonly catalog: PluginCatalog;
  /** Patterns parsed once, ready for the runtime. */
  readonly indexed: IndexedRiskCatalog;
}

export interface LoadCatalogOptions extends SemanticOptions {
  /** Name used in error messages ; defaults to the file path or `<inline>`. */
  readonly source?: string;
  /** Receives non-fatal findings (`catalogWarnings` : a fallback without the flag). Defaults to `console.warn`. */
  readonly warn?: (message: string) => void;
}

export class CatalogError extends Error {
  constructor(
    readonly source: string,
    readonly issues: readonly string[],
  ) {
    super(`Invalid risk catalog '${source}':\n  - ${issues.join('\n  - ')}`);
    this.name = 'CatalogError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

/** Parse and validate a YAML catalog held in memory. Throws `CatalogError`. */
export function parseCatalogYaml(text: string, options: LoadCatalogOptions = {}): LoadedCatalog {
  const source = options.source ?? '<inline>';
  let doc: unknown;
  try {
    doc = load(text, { filename: source, schema: CORE_SCHEMA });
  } catch (e) {
    const detail = e instanceof YAMLException ? e.reason : errorMessage(e);
    throw new CatalogError(source, [`YAML syntax: ${detail}`]);
  }
  return validateCatalog(doc, { ...options, source });
}

/** Read, parse and validate `risk-catalog.yaml`. Synchronous : runs at boot and at module load. */
export function loadCatalogFile(
  path: string | URL,
  options: LoadCatalogOptions = {},
): LoadedCatalog {
  const filePath = typeof path === 'string' ? path : fileURLToPath(path);
  const text = readFileSync(filePath, 'utf8');
  return parseCatalogYaml(text, { source: filePath, ...options });
}

/**
 * Validate an already-parsed document (YAML or JSON) and index it. Throws
 * `CatalogError` listing every issue. Also runs `prepareCatalog`, so the
 * boot-time checks of the policy engine (duplicate ids, id grammar, pattern
 * syntax) apply to every plugin.
 */
export function validateCatalog(doc: unknown, options: LoadCatalogOptions = {}): LoadedCatalog {
  const source = options.source ?? '<inline>';
  const structural = structuralIssues(doc);
  if (structural.issues.length > 0 || !structural.catalog) {
    throw new CatalogError(source, structural.issues);
  }
  const catalog = structural.catalog;
  const issues: string[] = [];
  let indexed: IndexedRiskCatalog | undefined;
  try {
    indexed = prepareCatalog(catalog, {
      warn: () => {
        // The missing-fallback warning is turned into an issue below.
      },
    });
  } catch (e) {
    issues.push(errorMessage(e));
  }
  issues.push(...semanticIssues(catalog, options));
  if (issues.length > 0 || !indexed) throw new CatalogError(source, issues);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  for (const warning of catalogWarnings(catalog))
    warn(`[plugin-sdk] catalog '${source}': ${warning}`);
  return { catalog, indexed };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
