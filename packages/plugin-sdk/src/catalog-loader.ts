/**
 * Risk-catalog loader — YAML in, validated and indexed catalog out.
 *
 * Spec : docs/spec/gateway-risk-model.md §4 (schema, versioning, mandatory
 *        fallback) ; docs/spec/vaubaan-gateway.md §3.2 and §10 (presets :
 *        at least one per plugin, every entry a risk of the same catalog,
 *        never a wildcard).
 * ADR  : docs/decisions/plugin-contract-and-credential-spec.md (YAML loaded
 *        at boot, TypeScript twins retired) ;
 *        docs/decisions/fallback-risk-only-when-uncategorized.md (one
 *        fallback per catalog, flagged `fallback: true`, never in a preset).
 *
 * The loader is strict : any structural issue, unknown key, malformed id,
 * duplicate, missing fallback, foreign or wildcard preset entry, or a preset
 * entry on the fallback fails the boot with every issue listed,
 * path-qualified (`risks[3].vector.blast`). Its one warning : a fallback
 * recognised by convention (pattern or id) instead of the `fallback: true`
 * flag — accepted for third-party catalogs, refused by the test kit.
 * A catalog is reviewed in a pull request ; the loader is the CI gate that
 * makes the review mechanical.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CORE_SCHEMA, YAMLException, load } from 'js-yaml';

import {
  fallbackEntriesOf,
  fallbackRiskPrefix,
  isAcceptableInEnv,
  isEnvScopedEntry,
  prepareCatalog,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
import {
  ENV_LABEL_PATTERN,
  GATES,
  RISK_VECTOR_AXES,
  WILDCARD_CHARS,
  baseRiskId,
  isExplicitRiskId,
  isProviderId,
  isRiskId,
  parseRiskId,
  type Preset,
  type RiskCatalog,
  type RiskEntry,
  type RiskVector,
} from '@vaubaan/shared';

/** A catalog as the SDK requires it : presets present. */
export interface PluginCatalog extends RiskCatalog {
  readonly presets: readonly Preset[];
}

export interface LoadedCatalog {
  readonly catalog: PluginCatalog;
  /** Patterns parsed once, ready for the runtime. */
  readonly indexed: IndexedRiskCatalog;
}

export interface LoadCatalogOptions {
  /** Name used in error messages ; defaults to the file path or `<inline>`. */
  readonly source?: string;
  /** Fail when no `<provider>.uncategorized-*` entry exists. Default true (risk-model spec §4.3). */
  readonly requireFallback?: boolean;
  /** Fail when the catalog ships no preset. Default true (spec §10). */
  readonly requirePresets?: boolean;
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
    const detail = e instanceof YAMLException ? e.reason : (e as Error).message;
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
    issues.push((e as Error).message);
  }
  issues.push(...semanticIssues(catalog, options));
  if (issues.length > 0 || !indexed) throw new CatalogError(source, issues);
  const warn = options.warn ?? ((message: string) => console.warn(message));
  for (const warning of catalogWarnings(catalog))
    warn(`[plugin-sdk] catalog '${source}': ${warning}`);
  return { catalog, indexed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Semantic checks (reused by the test kit and `definePlugin`)
// ─────────────────────────────────────────────────────────────────────────────

/** Issues beyond structure : fallback, presets, wildcards. Empty array = valid. */
export function semanticIssues(catalog: RiskCatalog, options: LoadCatalogOptions = {}): string[] {
  const issues: string[] = [];
  const requireFallback = options.requireFallback ?? true;
  const requirePresets = options.requirePresets ?? true;
  issues.push(...fallbackIssues(catalog, { requireFallback }));
  issues.push(...wildcardIssues(catalog));
  issues.push(...presetIssues(catalog, { requirePresets }));
  return issues;
}

/**
 * Fallback rules (risk-model spec §4.3 ; ADR fallback-risk-only-when-
 * uncategorized) : exactly one fallback entry — `fallback: true`, or
 * detected by the catch-all pattern `<provider>.**.W` or the
 * `<provider>.uncategorized-` id — and that entry is named
 * `<provider>.uncategorized-*`, so audit logs read the same for every
 * provider.
 */
export function fallbackIssues(
  catalog: RiskCatalog,
  options: { readonly requireFallback?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const fallbacks = fallbackEntriesOf(catalog);
  const prefix = fallbackRiskPrefix(catalog.provider);
  if (fallbacks.length === 0) {
    if (options.requireFallback ?? true) {
      issues.push(
        `missing fallback risk: declare a '${prefix}-*' entry matching '${catalog.provider}.**.W' with fallback: true (risk-model spec §4.3)`,
      );
    }
    return issues;
  }
  if (fallbacks.length > 1) {
    issues.push(
      `fallback: exactly one fallback entry per catalog, found ${fallbacks.length} (${fallbacks
        .map((r) => `'${r.id}'`)
        .join(
          ', ',
        )}) — only one entry may be flagged fallback: true or match '${catalog.provider}.**.W'`,
    );
  }
  for (const entry of fallbacks) {
    if (!entry.id.startsWith(prefix)) {
      const i = catalog.risks.indexOf(entry);
      issues.push(`risks[${i}].id '${entry.id}' is the fallback and must be named '${prefix}-*'`);
    }
  }
  return issues;
}

/**
 * The fallback entry must carry `fallback: true` (ADR fallback-risk-only-
 * when-uncategorized D2, as amended by P1.2-align) : a reader of the YAML
 * sees that the entry behaves differently, and the runtime never depends on
 * the pattern convention. An entry recognised by convention alone (the
 * `<provider>.**.W` pattern or the `<provider>.uncategorized-` id) is
 * reported here ; the loader surfaces it as a warning so a third-party
 * catalog written before the flag still boots, the test kit
 * (`assertPluginWellFormed`) as a failure.
 */
export function fallbackFlagIssues(catalog: RiskCatalog): string[] {
  return fallbackEntriesOf(catalog)
    .filter((entry) => entry.fallback !== true)
    .map((entry) => {
      const i = catalog.risks.indexOf(entry);
      return `risks[${i}].id '${entry.id}' is the fallback by convention only — set fallback: true on it`;
    });
}

/**
 * Non-fatal findings the loader reports through `warn` : today only
 * `fallbackFlagIssues`. A preset that includes the fallback used to be a
 * warning ; it is an error since no plugin needs it (`presetIssues`).
 */
export function catalogWarnings(catalog: RiskCatalog): string[] {
  return fallbackFlagIssues(catalog);
}

/** Risk ids and preset entries that are patterns or sentinels instead of explicit ids. */
export function wildcardIssues(catalog: RiskCatalog): string[] {
  const issues: string[] = [];
  catalog.risks.forEach((risk, i) => {
    if (WILDCARD_CHARS.test(risk.id))
      issues.push(`risks[${i}].id '${risk.id}' contains a wildcard`);
  });
  (catalog.presets ?? []).forEach((preset, p) => {
    preset.entries.forEach((entry, e) => {
      if (!isExplicitRiskId(entry.risk_id)) {
        issues.push(
          `presets[${p}].entries[${e}].risk_id '${entry.risk_id}' is not an explicit RiskId (no wildcard, no sentinel)`,
        );
      }
    });
  });
  return issues;
}

/**
 * Preset rules (spec §3.2, §10) : at least one preset ; ids unique ; every
 * entry references a risk of this catalog ; an env-qualified entry targets
 * an env-scoped risk and an allowed env ; no duplicate risk within a preset ;
 * never the fallback — it fires only on writes the catalog has not reviewed
 * (ADR fallback-risk-only-when-uncategorized D3, tightened by P1.2-align),
 * so a preset including it would pre-accept exactly those. A mission
 * creator may still accept it by hand at issuance.
 */
export function presetIssues(
  catalog: RiskCatalog,
  options: { readonly requirePresets?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const presets = catalog.presets ?? [];
  if ((options.requirePresets ?? true) && presets.length === 0) {
    issues.push('presets: every plugin ships at least one preset (spec §3.2)');
    return issues;
  }
  const byId = new Map<string, RiskEntry>(catalog.risks.map((r) => [r.id, r]));
  const fallbackIds = new Set(fallbackEntriesOf(catalog).map((r) => r.id));
  const presetIds = new Set<string>();
  presets.forEach((preset, p) => {
    const at = `presets[${p}]`;
    if (presetIds.has(preset.id)) issues.push(`${at}.id '${preset.id}' is declared twice`);
    presetIds.add(preset.id);
    if (preset.entries.length === 0) issues.push(`${at}.entries is empty`);
    const seen = new Set<string>();
    preset.entries.forEach((entry, e) => {
      const where = `${at}.entries[${e}]`;
      if (seen.has(entry.risk_id))
        issues.push(`${where}.risk_id '${entry.risk_id}' repeated in preset '${preset.id}'`);
      seen.add(entry.risk_id);
      const parsed = parseRiskId(entry.risk_id);
      if (!parsed) return; // reported by wildcardIssues / structure
      if (parsed.provider !== catalog.provider) {
        issues.push(
          `${where}.risk_id '${entry.risk_id}' belongs to provider '${parsed.provider}', not '${catalog.provider}'`,
        );
        return;
      }
      const risk = byId.get(baseRiskId(entry.risk_id));
      if (!risk) {
        issues.push(
          `${where}.risk_id '${entry.risk_id}' is not a risk of the '${catalog.provider}' catalog`,
        );
        return;
      }
      if (parsed.env !== null) {
        if (!isEnvScopedEntry(risk)) {
          issues.push(
            `${where}.risk_id '${entry.risk_id}' qualifies an env on a risk that is not env-scoped`,
          );
        } else if (!isAcceptableInEnv(risk, parsed.env)) {
          issues.push(
            `${where}.risk_id '${entry.risk_id}' uses env '${parsed.env}' outside acceptable_in_envs [${(risk.acceptable_in_envs ?? []).join(', ')}]`,
          );
        }
      }
      if (risk.deprecated)
        issues.push(
          `${where}.risk_id '${entry.risk_id}' is deprecated and must not be offered in a preset`,
        );
      if (fallbackIds.has(risk.id))
        issues.push(
          `${where}.risk_id '${entry.risk_id}' is the fallback — a preset must not pre-accept uncategorized writes (preset '${preset.id}')`,
        );
    });
  });
  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural validation of the parsed document
// ─────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function isRecord(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const RISK_KEYS = new Set([
  'id',
  'label',
  'reason',
  'matches',
  'vector',
  'vector_overrides',
  'acceptable_in_envs',
  'caps',
  'infra_limits',
  'fallback',
  'deprecated',
  'replaced_by',
]);
const CATALOG_KEYS = new Set(['provider', 'risks', 'presets', 'catalog_version', 'catalog_date']);
const PRESET_KEYS = new Set(['id', 'label', 'description', 'entries']);
const ENTRY_KEYS = new Set(['risk_id', 'quota', 'rate_limit', 'gate']);
const RATE_LIMIT_KEYS = new Set(['max', 'window_seconds']);
const CAP_KEYS = new Set([
  'temporal_window_days',
  'items_per_call_max',
  'bytes_per_call_max',
  'calls_per_minute_max',
  'calls_per_session_max',
]);
const PRESET_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

interface StructuralResult {
  readonly catalog?: PluginCatalog;
  readonly issues: string[];
}

/** Check the shape of a parsed document and build a typed catalog from it. */
export function structuralIssues(doc: unknown): StructuralResult {
  const issues: string[] = [];
  if (!isRecord(doc))
    return { issues: ['document: expected a mapping with `provider`, `risks` and `presets`'] };
  unknownKeys(doc, CATALOG_KEYS, '', issues);

  const provider = doc.provider;
  if (typeof provider !== 'string' || !isProviderId(provider)) {
    issues.push(`provider: expected a lowercase slug such as 'github' or 'cloudflare-dns'`);
  }
  if (doc.catalog_version !== undefined && !isPositiveInt(doc.catalog_version)) {
    issues.push('catalog_version: expected a positive integer');
  }
  const catalogDate = normalizeDate(doc.catalog_date);
  if (doc.catalog_date !== undefined && catalogDate === undefined) {
    issues.push('catalog_date: expected an ISO date (YYYY-MM-DD)');
  }

  const risks: RiskEntry[] = [];
  if (!Array.isArray(doc.risks) || doc.risks.length === 0) {
    issues.push('risks: expected a non-empty list');
  } else {
    doc.risks.forEach((raw: unknown, i: number) => {
      const risk = riskFrom(
        raw,
        `risks[${i}]`,
        typeof provider === 'string' ? provider : null,
        issues,
      );
      if (risk) risks.push(risk);
    });
  }

  const presets: Preset[] = [];
  if (doc.presets !== undefined) {
    if (!Array.isArray(doc.presets)) {
      issues.push('presets: expected a list');
    } else {
      doc.presets.forEach((raw: unknown, i: number) => {
        const preset = presetFrom(raw, `presets[${i}]`, issues);
        if (preset) presets.push(preset);
      });
    }
  }

  if (issues.length > 0 || typeof provider !== 'string') return { issues };
  const catalog: PluginCatalog = {
    provider,
    risks,
    presets,
    ...(doc.catalog_version !== undefined
      ? { catalog_version: doc.catalog_version as number }
      : {}),
    ...(catalogDate !== undefined ? { catalog_date: catalogDate } : {}),
  };
  return { catalog, issues };
}

function unknownKeys(rec: Rec, allowed: ReadonlySet<string>, at: string, issues: string[]): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) issues.push(`${at ? `${at}.` : ''}${key}: unknown key`);
  }
}

function isPositiveInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x > 0;
}

function normalizeDate(x: unknown): string | undefined {
  if (x === undefined) return undefined;
  if (x instanceof Date && !Number.isNaN(x.getTime())) return x.toISOString().slice(0, 10);
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  return undefined;
}

function requireString(rec: Rec, key: string, at: string, issues: string[]): string | undefined {
  const v = rec[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    issues.push(`${at}.${key}: expected a non-empty string`);
    return undefined;
  }
  return v;
}

function vectorFrom(
  raw: unknown,
  at: string,
  issues: string[],
  partial: boolean,
): RiskVector | Partial<RiskVector> | undefined {
  if (!isRecord(raw)) {
    issues.push(`${at}: expected a mapping of the six risk axes`);
    return undefined;
  }
  const out: Partial<Record<keyof RiskVector, RiskVector[keyof RiskVector]>> = {};
  for (const axis of Object.keys(RISK_VECTOR_AXES) as (keyof RiskVector)[]) {
    const allowed: readonly string[] = RISK_VECTOR_AXES[axis];
    const v = raw[axis];
    if (v === undefined) {
      if (!partial) issues.push(`${at}.${axis}: missing (one of ${allowed.join(' | ')})`);
      continue;
    }
    if (typeof v !== 'string' || !allowed.includes(v)) {
      issues.push(`${at}.${axis}: expected one of ${allowed.join(' | ')}`);
      continue;
    }
    out[axis] = v as RiskVector[keyof RiskVector];
  }
  for (const key of Object.keys(raw)) {
    if (!(key in RISK_VECTOR_AXES)) issues.push(`${at}.${key}: unknown axis`);
  }
  return out as RiskVector;
}

function capsFrom(raw: unknown, at: string, issues: string[]): Rec | undefined {
  if (!isRecord(raw)) {
    issues.push(`${at}: expected a mapping`);
    return undefined;
  }
  unknownKeys(raw, CAP_KEYS, at, issues);
  for (const [k, v] of Object.entries(raw)) {
    if (CAP_KEYS.has(k) && !isPositiveInt(v))
      issues.push(`${at}.${k}: expected a positive integer`);
  }
  return raw;
}

function riskFrom(
  raw: unknown,
  at: string,
  provider: string | null,
  issues: string[],
): RiskEntry | undefined {
  if (!isRecord(raw)) {
    issues.push(`${at}: expected a mapping`);
    return undefined;
  }
  const before = issues.length;
  unknownKeys(raw, RISK_KEYS, at, issues);
  const id = requireString(raw, 'id', at, issues);
  if (id !== undefined) {
    if (!isRiskId(id))
      issues.push(
        `${at}.id '${id}' does not match '<provider>.<name>' or '<provider>[<env>].<name>'`,
      );
    else if (provider && parseRiskId(id)!.provider !== provider) {
      issues.push(
        `${at}.id '${id}' belongs to provider '${parseRiskId(id)!.provider}', not '${provider}'`,
      );
    }
  }
  const label = requireString(raw, 'label', at, issues);
  const reason = requireString(raw, 'reason', at, issues);

  let matches: string | string[] | undefined;
  if (typeof raw.matches === 'string' && raw.matches.length > 0) matches = raw.matches;
  else if (
    Array.isArray(raw.matches) &&
    raw.matches.length > 0 &&
    raw.matches.every((m) => typeof m === 'string' && m.length > 0)
  ) {
    matches = raw.matches as string[];
  } else issues.push(`${at}.matches: expected a slice pattern or a non-empty list of patterns`);

  const vector = vectorFrom(raw.vector, `${at}.vector`, issues, false) as RiskVector | undefined;

  let vectorOverrides: Record<string, Partial<RiskVector>> | undefined;
  if (raw.vector_overrides !== undefined) {
    if (!isRecord(raw.vector_overrides))
      issues.push(`${at}.vector_overrides: expected a mapping env → partial vector`);
    else {
      vectorOverrides = {};
      for (const [env, v] of Object.entries(raw.vector_overrides)) {
        if (!ENV_LABEL_PATTERN.test(env))
          issues.push(`${at}.vector_overrides.${env}: invalid env label`);
        const partial = vectorFrom(v, `${at}.vector_overrides.${env}`, issues, true);
        if (partial) vectorOverrides[env] = partial;
      }
    }
  }

  let acceptableInEnvs: string[] | undefined;
  if (raw.acceptable_in_envs !== undefined) {
    if (!Array.isArray(raw.acceptable_in_envs) || raw.acceptable_in_envs.length === 0) {
      issues.push(`${at}.acceptable_in_envs: expected a non-empty list of env labels`);
    } else {
      acceptableInEnvs = [];
      raw.acceptable_in_envs.forEach((env: unknown, j: number) => {
        if (typeof env !== 'string' || !ENV_LABEL_PATTERN.test(env))
          issues.push(`${at}.acceptable_in_envs[${j}]: invalid env label`);
        else acceptableInEnvs!.push(env);
      });
    }
  }

  const caps = raw.caps !== undefined ? capsFrom(raw.caps, `${at}.caps`, issues) : undefined;
  const infra =
    raw.infra_limits !== undefined
      ? capsFrom(raw.infra_limits, `${at}.infra_limits`, issues)
      : undefined;

  if (raw.fallback !== undefined && typeof raw.fallback !== 'boolean')
    issues.push(`${at}.fallback: expected a boolean`);
  if (raw.deprecated !== undefined && typeof raw.deprecated !== 'boolean')
    issues.push(`${at}.deprecated: expected a boolean`);
  if (
    raw.replaced_by !== undefined &&
    (typeof raw.replaced_by !== 'string' || !isRiskId(raw.replaced_by))
  ) {
    issues.push(`${at}.replaced_by: expected a RiskId`);
  }

  if (issues.length > before || !id || !label || !reason || !matches || !vector) return undefined;
  return {
    id,
    label,
    reason,
    matches,
    vector,
    ...(vectorOverrides ? { vector_overrides: vectorOverrides } : {}),
    ...(acceptableInEnvs ? { acceptable_in_envs: acceptableInEnvs } : {}),
    ...(caps ? { caps } : {}),
    ...(infra ? { infra_limits: infra } : {}),
    ...(raw.fallback !== undefined ? { fallback: raw.fallback as boolean } : {}),
    ...(raw.deprecated !== undefined ? { deprecated: raw.deprecated as boolean } : {}),
    ...(raw.replaced_by !== undefined ? { replaced_by: raw.replaced_by as string } : {}),
  };
}

function presetFrom(raw: unknown, at: string, issues: string[]): Preset | undefined {
  if (!isRecord(raw)) {
    issues.push(`${at}: expected a mapping`);
    return undefined;
  }
  const before = issues.length;
  unknownKeys(raw, PRESET_KEYS, at, issues);
  const id = requireString(raw, 'id', at, issues);
  if (id !== undefined && !PRESET_ID_PATTERN.test(id))
    issues.push(`${at}.id '${id}' must be a lowercase slug`);
  const label = requireString(raw, 'label', at, issues);
  const description = requireString(raw, 'description', at, issues);
  const entries: Preset['entries'][number][] = [];
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    issues.push(`${at}.entries: expected a non-empty list`);
  } else {
    raw.entries.forEach((e: unknown, j: number) => {
      const where = `${at}.entries[${j}]`;
      if (!isRecord(e)) {
        issues.push(`${where}: expected a mapping`);
        return;
      }
      unknownKeys(e, ENTRY_KEYS, where, issues);
      const riskId = requireString(e, 'risk_id', where, issues);
      if (!isPositiveInt(e.quota))
        issues.push(`${where}.quota: expected a positive integer (no infinite budget, spec §3.2)`);
      let rate: { max: number; window_seconds: number } | undefined;
      if (!isRecord(e.rate_limit))
        issues.push(`${where}.rate_limit: expected { max, window_seconds }`);
      else {
        unknownKeys(e.rate_limit, RATE_LIMIT_KEYS, `${where}.rate_limit`, issues);
        if (!isPositiveInt(e.rate_limit.max))
          issues.push(`${where}.rate_limit.max: expected a positive integer`);
        if (!isPositiveInt(e.rate_limit.window_seconds))
          issues.push(`${where}.rate_limit.window_seconds: expected a positive integer`);
        if (isPositiveInt(e.rate_limit.max) && isPositiveInt(e.rate_limit.window_seconds)) {
          rate = { max: e.rate_limit.max, window_seconds: e.rate_limit.window_seconds };
        }
      }
      const gate = e.gate ?? 'auto';
      if (typeof gate !== 'string' || !(GATES as readonly string[]).includes(gate)) {
        issues.push(`${where}.gate: expected one of ${GATES.join(' | ')}`);
      }
      if (
        riskId &&
        isPositiveInt(e.quota) &&
        rate &&
        typeof gate === 'string' &&
        (GATES as readonly string[]).includes(gate)
      ) {
        entries.push({
          risk_id: riskId,
          quota: e.quota,
          rate_limit: rate,
          gate: gate as Preset['entries'][number]['gate'],
        });
      }
    });
  }
  if (issues.length > before || !id || !label || !description) return undefined;
  return { id, label, description, entries };
}
