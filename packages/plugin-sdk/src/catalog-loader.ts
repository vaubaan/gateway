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
 * duplicate, missing fallback, fallback that is not the catch-all write,
 * foreign or wildcard preset entry, illegal budget, or a preset entry on
 * the fallback fails the boot with every issue listed, path-qualified
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

import {
  budgetIssues,
  fallbackEntriesOf,
  fallbackRiskPrefix,
  hasCatchAllWritePattern,
  isAcceptableInEnv,
  isEnvScopedEntry,
  isValidBudget,
  prepareCatalog,
  type IndexedRiskCatalog,
} from '@vaubaan/policy-engine';
import {
  ENV_LABEL_PATTERN,
  RISK_VECTOR_AXES,
  WILDCARD_CHARS,
  baseRiskId,
  isExplicitRiskId,
  isProviderId,
  isRiskId,
  parseRiskId,
  type Preset,
  type PresetEntry,
  type RiskCatalog,
  type RiskEntry,
  type RiskId,
  type RiskVector,
  type ScopeCaps,
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
 * provider, and matches the catch-all write `<provider>.**.W`. The pattern
 * is checked because the fallback is the one entry that is left out of the
 * touched risks whenever another entry matches : flagged on a narrow
 * pattern, a named risk would silently stop being required.
 */
export function fallbackIssues(
  catalog: RiskCatalog,
  options: { readonly requireFallback?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const fallbacks = fallbackEntriesOf(catalog);
  const prefix = fallbackRiskPrefix(catalog.provider);
  const catchAll = `${catalog.provider}.**.W`;
  if (fallbacks.length === 0) {
    if (options.requireFallback ?? true) {
      issues.push(
        `missing fallback risk: declare a '${prefix}*' entry matching '${catchAll}' with fallback: true (risk-model spec §4.3)`,
      );
    }
    return issues;
  }
  if (fallbacks.length > 1) {
    issues.push(
      `fallback: exactly one fallback entry per catalog, found ${fallbacks.length} (${fallbacks
        .map((r) => `'${r.id}'`)
        .join(', ')}) — only one entry may be flagged fallback: true or match '${catchAll}'`,
    );
  }
  for (const entry of fallbacks) {
    const i = catalog.risks.indexOf(entry);
    if (!entry.id.startsWith(prefix)) {
      issues.push(`risks[${i}].id '${entry.id}' is the fallback and must be named '${prefix}*'`);
    }
    if (!hasCatchAllWritePattern(entry)) {
      issues.push(
        `risks[${i}].matches: the fallback '${entry.id}' must match the catch-all write '${catchAll}'`,
      );
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
  return [...riskIdWildcardIssues(catalog), ...presetWildcardIssues(catalog)];
}

/** Catalog risk ids that contain a wildcard character. */
export function riskIdWildcardIssues(catalog: RiskCatalog): string[] {
  const issues: string[] = [];
  catalog.risks.forEach((risk, i) => {
    if (WILDCARD_CHARS.test(risk.id))
      issues.push(`risks[${i}].id '${risk.id}' contains a wildcard`);
  });
  return issues;
}

/** Preset entries that are a pattern or a sentinel instead of an explicit id (spec §10). */
export function presetWildcardIssues(catalog: RiskCatalog): string[] {
  const issues: string[] = [];
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
 * entry carries a legal budget (`budgetIssues` : positive integer quota and
 * rate limit, gate from the closed set — never unbounded) and references a
 * risk of this catalog ; an env-qualified entry targets an env-scoped risk
 * and an allowed env ; no duplicate risk within a preset ; never the
 * fallback — it fires only on writes the catalog has not reviewed (ADR
 * fallback-risk-only-when-uncategorized D3, tightened by P1.2-align), so a
 * preset including it would pre-accept exactly those. A mission creator may
 * still accept it by hand at issuance.
 *
 * This is the path every catalog takes, whatever it was written in : the
 * YAML loader, `definePlugin`, the registry and the test kit.
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
  const lookup: PresetLookup = {
    provider: catalog.provider,
    byId: new Map<string, RiskEntry>(catalog.risks.map((r) => [r.id, r])),
    fallbackIds: new Set(fallbackEntriesOf(catalog).map((r) => r.id)),
  };
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
      issues.push(...presetEntryIssues(entry, where, preset.id, lookup));
    });
  });
  return issues;
}

/** What a preset entry is checked against. */
interface PresetLookup {
  readonly provider: string;
  readonly byId: ReadonlyMap<string, RiskEntry>;
  readonly fallbackIds: ReadonlySet<string>;
}

/** The issues of one preset entry : its budget, then the risk it references. */
function presetEntryIssues(
  entry: PresetEntry,
  where: string,
  presetId: string,
  lookup: PresetLookup,
): string[] {
  const issues = budgetIssues(entry).map((issue) => `${where}.${issue.field}: ${issue.message}`);
  const parsed = parseRiskId(entry.risk_id);
  if (!parsed) return issues; // reported by presetWildcardIssues / structure
  if (parsed.provider !== lookup.provider) {
    issues.push(
      `${where}.risk_id '${entry.risk_id}' belongs to provider '${parsed.provider}', not '${lookup.provider}'`,
    );
    return issues;
  }
  const risk = lookup.byId.get(baseRiskId(entry.risk_id));
  if (!risk) {
    issues.push(
      `${where}.risk_id '${entry.risk_id}' is not a risk of the '${lookup.provider}' catalog`,
    );
    return issues;
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
  if (lookup.fallbackIds.has(risk.id))
    issues.push(
      `${where}.risk_id '${entry.risk_id}' is the fallback — a preset must not pre-accept uncategorized writes (preset '${presetId}')`,
    );
  return issues;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural validation of the parsed document
// ─────────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

function isRecord(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Where a parser is in the document and where it reports. Every field
 * parser takes one : it returns the typed value, or `undefined` after
 * pushing the reason at its path.
 */
interface ParseContext {
  /** Path of the node being read (`risks[3]`, `presets[0].entries[2]`) ; empty at the root. */
  readonly at: string;
  readonly issues: string[];
}

/** The context of a member of the current node — same issue list, longer path. */
function child(ctx: ParseContext, key: string): ParseContext {
  return { at: ctx.at ? `${ctx.at}.${key}` : key, issues: ctx.issues };
}

/**
 * A context that collects into its own list, so a parser can tell whether
 * the node it assembles raised anything ; `commit` hands the findings to
 * the parent and answers that question.
 */
function scoped(ctx: ParseContext): ParseContext & { commit(): boolean } {
  const own: string[] = [];
  return {
    at: ctx.at,
    issues: own,
    commit: () => {
      ctx.issues.push(...own);
      return own.length === 0;
    },
  };
}

function notAMapping(ctx: ParseContext): undefined {
  ctx.issues.push(`${ctx.at}: expected a mapping`);
  return undefined;
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
/** The cap keys `caps` and `infra_limits` accept — every key of `ScopeCaps`, in declaration order. */
const SCOPE_CAP_KEYS = [
  'temporal_window_days',
  'items_per_call_max',
  'bytes_per_call_max',
  'calls_per_minute_max',
  'calls_per_session_max',
] as const satisfies readonly (keyof ScopeCaps)[];
const CAP_KEYS: ReadonlySet<string> = new Set(SCOPE_CAP_KEYS);
const PRESET_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

type Axis = keyof RiskVector;
/** The six axes, in declaration order. `Object.keys` widens to `string[]` ; the keys of a constant object are its keys. */
const AXES = Object.keys(RISK_VECTOR_AXES) as readonly Axis[];

interface StructuralResult {
  readonly catalog?: PluginCatalog;
  readonly issues: string[];
}

/** Check the shape of a parsed document and build a typed catalog from it. */
export function structuralIssues(doc: unknown): StructuralResult {
  const issues: string[] = [];
  if (!isRecord(doc))
    return { issues: ['document: expected a mapping with `provider`, `risks` and `presets`'] };
  const root: ParseContext = { at: '', issues };
  unknownKeys(doc, CATALOG_KEYS, root);

  const provider = providerFrom(doc, root);
  const catalogVersion = catalogVersionFrom(doc, root);
  const catalogDate = catalogDateFrom(doc, root);
  // A provider that is not a slug is reported above ; as a string it still
  // names the catalog the risk ids are compared with.
  const declaredProvider = typeof doc.provider === 'string' ? doc.provider : null;
  const risks = risksFrom(doc.risks, child(root, 'risks'), declaredProvider);
  const presets = presetsFrom(doc.presets, child(root, 'presets'));

  if (issues.length > 0 || provider === undefined) return { issues };
  const catalog: PluginCatalog = {
    provider,
    risks,
    presets,
    ...(catalogVersion !== undefined ? { catalog_version: catalogVersion } : {}),
    ...(catalogDate !== undefined ? { catalog_date: catalogDate } : {}),
  };
  return { catalog, issues };
}

function providerFrom(doc: Rec, ctx: ParseContext): string | undefined {
  const provider = doc.provider;
  if (typeof provider === 'string' && isProviderId(provider)) return provider;
  ctx.issues.push(`provider: expected a lowercase slug such as 'github' or 'cloudflare-dns'`);
  return undefined;
}

function catalogVersionFrom(doc: Rec, ctx: ParseContext): number | undefined {
  const version = doc.catalog_version;
  if (version === undefined) return undefined;
  if (isPositiveInt(version)) return version;
  ctx.issues.push('catalog_version: expected a positive integer');
  return undefined;
}

function catalogDateFrom(doc: Rec, ctx: ParseContext): string | undefined {
  if (doc.catalog_date === undefined) return undefined;
  const date = normalizeDate(doc.catalog_date);
  if (date === undefined) ctx.issues.push('catalog_date: expected an ISO date (YYYY-MM-DD)');
  return date;
}

function risksFrom(raw: unknown, ctx: ParseContext, provider: string | null): RiskEntry[] {
  if (!isUnknownList(raw) || raw.length === 0) {
    ctx.issues.push(`${ctx.at}: expected a non-empty list`);
    return [];
  }
  return raw.flatMap((item, i) => {
    const risk = riskFrom(item, { at: `${ctx.at}[${i}]`, issues: ctx.issues }, provider);
    return risk ? [risk] : [];
  });
}

function presetsFrom(raw: unknown, ctx: ParseContext): Preset[] {
  if (raw === undefined) return [];
  if (!isUnknownList(raw)) {
    ctx.issues.push(`${ctx.at}: expected a list`);
    return [];
  }
  return raw.flatMap((item, i) => {
    const preset = presetFrom(item, { at: `${ctx.at}[${i}]`, issues: ctx.issues });
    return preset ? [preset] : [];
  });
}

function unknownKeys(rec: Rec, allowed: ReadonlySet<string>, ctx: ParseContext): void {
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) ctx.issues.push(`${child(ctx, key).at}: unknown key`);
  }
}

function isPositiveInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x > 0;
}

/** `Array.isArray` narrows `unknown` to `any[]` ; this guard keeps the elements `unknown`. */
function isUnknownList(x: unknown): x is readonly unknown[] {
  return Array.isArray(x);
}

function isNonEmptyStringList(x: unknown): x is string[] {
  return isUnknownList(x) && x.length > 0 && x.every((m) => typeof m === 'string' && m.length > 0);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function normalizeDate(x: unknown): string | undefined {
  if (x === undefined) return undefined;
  if (x instanceof Date && !Number.isNaN(x.getTime())) return x.toISOString().slice(0, 10);
  if (typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x)) return x;
  return undefined;
}

function requireString(rec: Rec, key: string, ctx: ParseContext): string | undefined {
  const v = rec[key];
  if (typeof v !== 'string' || v.trim().length === 0) {
    ctx.issues.push(`${ctx.at}.${key}: expected a non-empty string`);
    return undefined;
  }
  return v;
}

// ── Risk vector ──────────────────────────────────────────────────────────────

type MutableVector = { -readonly [A in Axis]?: RiskVector[A] };

function isAxisValue<A extends Axis>(axis: A, value: unknown): value is RiskVector[A] {
  const allowed: readonly string[] = RISK_VECTOR_AXES[axis];
  return typeof value === 'string' && allowed.includes(value);
}

/** Copy one axis from the document when it is present and legal ; report it otherwise. */
function readAxis<A extends Axis>(
  raw: Rec,
  axis: A,
  out: MutableVector,
  ctx: ParseContext,
  required: boolean,
): void {
  const allowed: readonly string[] = RISK_VECTOR_AXES[axis];
  const value = raw[axis];
  if (value === undefined) {
    if (required) ctx.issues.push(`${ctx.at}.${axis}: missing (one of ${allowed.join(' | ')})`);
    return;
  }
  if (!isAxisValue(axis, value)) {
    ctx.issues.push(`${ctx.at}.${axis}: expected one of ${allowed.join(' | ')}`);
    return;
  }
  out[axis] = value;
}

/**
 * The axes a mapping declares, each checked against its closed set. With
 * `required`, a missing axis is an issue (a risk's `vector`) ; without, the
 * mapping may name any subset (a `vector_overrides` entry).
 */
function partialVectorFrom(
  raw: unknown,
  ctx: ParseContext,
  required: boolean,
): Partial<RiskVector> | undefined {
  if (!isRecord(raw)) {
    ctx.issues.push(`${ctx.at}: expected a mapping of the six risk axes`);
    return undefined;
  }
  const out: MutableVector = {};
  for (const axis of AXES) readAxis(raw, axis, out, ctx, required);
  for (const key of Object.keys(raw)) {
    if (!(key in RISK_VECTOR_AXES)) ctx.issues.push(`${ctx.at}.${key}: unknown axis`);
  }
  return out;
}

/** True iff every one of the six axes is set : the partial vector is a `RiskVector`. */
export function isCompleteVector(vector: Partial<RiskVector>): vector is RiskVector {
  return AXES.every((axis) => vector[axis] !== undefined);
}

/** A risk's full vector, or `undefined` when an axis is missing or illegal (reported). */
function vectorFrom(raw: unknown, ctx: ParseContext): RiskVector | undefined {
  const vector = partialVectorFrom(raw, ctx, true);
  return vector && isCompleteVector(vector) ? vector : undefined;
}

function vectorOverridesFrom(
  raw: Rec,
  ctx: ParseContext,
): Record<string, Partial<RiskVector>> | undefined {
  if (raw.vector_overrides === undefined) return undefined;
  const at = child(ctx, 'vector_overrides');
  if (!isRecord(raw.vector_overrides)) {
    ctx.issues.push(`${at.at}: expected a mapping env → partial vector`);
    return undefined;
  }
  const overrides: Record<string, Partial<RiskVector>> = {};
  for (const [env, value] of Object.entries(raw.vector_overrides)) {
    const envCtx = child(at, env);
    if (!ENV_LABEL_PATTERN.test(env)) ctx.issues.push(`${envCtx.at}: invalid env label`);
    const partial = partialVectorFrom(value, envCtx, false);
    if (partial) overrides[env] = partial;
  }
  return overrides;
}

// ── Scope caps ───────────────────────────────────────────────────────────────

type MutableCaps = { -readonly [K in keyof ScopeCaps]?: number };

/**
 * `caps` or `infra_limits` : a mapping of the `ScopeCaps` keys to positive
 * integers. Builds a typed object from the keys it checked ; an unknown key
 * or a value that is not a positive integer is reported.
 */
function capsFrom(raw: unknown, ctx: ParseContext): ScopeCaps | undefined {
  if (!isRecord(raw)) return notAMapping(ctx);
  unknownKeys(raw, CAP_KEYS, ctx);
  const caps: MutableCaps = {};
  for (const key of SCOPE_CAP_KEYS) {
    const value = raw[key];
    if (value === undefined && !(key in raw)) continue;
    if (isPositiveInt(value)) caps[key] = value;
    else ctx.issues.push(`${ctx.at}.${key}: expected a positive integer`);
  }
  return caps;
}

// ── One risk ─────────────────────────────────────────────────────────────────

function riskIdFrom(raw: Rec, ctx: ParseContext, provider: string | null): RiskId | undefined {
  const id = requireString(raw, 'id', ctx);
  if (id === undefined) return undefined;
  const parsed = parseRiskId(id);
  if (!parsed) {
    ctx.issues.push(
      `${ctx.at}.id '${id}' does not match '<provider>.<name>' or '<provider>[<env>].<name>'`,
    );
    return undefined;
  }
  if (provider && parsed.provider !== provider) {
    ctx.issues.push(
      `${ctx.at}.id '${id}' belongs to provider '${parsed.provider}', not '${provider}'`,
    );
    return undefined;
  }
  return id;
}

function matchesFrom(raw: Rec, ctx: ParseContext): string | string[] | undefined {
  const matches = raw.matches;
  if (typeof matches === 'string' && matches.length > 0) return matches;
  if (isNonEmptyStringList(matches)) return matches;
  ctx.issues.push(`${ctx.at}.matches: expected a slice pattern or a non-empty list of patterns`);
  return undefined;
}

function acceptableEnvsFrom(raw: Rec, ctx: ParseContext): string[] | undefined {
  const envs = raw.acceptable_in_envs;
  if (envs === undefined) return undefined;
  if (!isUnknownList(envs) || envs.length === 0) {
    ctx.issues.push(`${ctx.at}.acceptable_in_envs: expected a non-empty list of env labels`);
    return undefined;
  }
  const labels: string[] = [];
  envs.forEach((env, j) => {
    if (typeof env === 'string' && ENV_LABEL_PATTERN.test(env)) labels.push(env);
    else ctx.issues.push(`${ctx.at}.acceptable_in_envs[${j}]: invalid env label`);
  });
  return labels;
}

function optionalBoolean(
  raw: Rec,
  key: 'fallback' | 'deprecated',
  ctx: ParseContext,
): boolean | undefined {
  const value = raw[key];
  if (value === undefined || typeof value === 'boolean') return value;
  ctx.issues.push(`${ctx.at}.${key}: expected a boolean`);
  return undefined;
}

function replacedByFrom(raw: Rec, ctx: ParseContext): RiskId | undefined {
  const value = raw.replaced_by;
  if (value === undefined) return undefined;
  if (typeof value === 'string' && isRiskId(value)) return value;
  ctx.issues.push(`${ctx.at}.replaced_by: expected a RiskId`);
  return undefined;
}

/** Assemble one risk from its field parsers ; `undefined` when any of them reported. */
function riskFrom(raw: unknown, ctx: ParseContext, provider: string | null): RiskEntry | undefined {
  if (!isRecord(raw)) return notAMapping(ctx);
  const own = scoped(ctx);
  unknownKeys(raw, RISK_KEYS, own);
  const id = riskIdFrom(raw, own, provider);
  const label = requireString(raw, 'label', own);
  const reason = requireString(raw, 'reason', own);
  const matches = matchesFrom(raw, own);
  const vector = vectorFrom(raw.vector, child(own, 'vector'));
  const vectorOverrides = vectorOverridesFrom(raw, own);
  const acceptableInEnvs = acceptableEnvsFrom(raw, own);
  const caps = raw.caps !== undefined ? capsFrom(raw.caps, child(own, 'caps')) : undefined;
  const infra =
    raw.infra_limits !== undefined
      ? capsFrom(raw.infra_limits, child(own, 'infra_limits'))
      : undefined;
  const fallback = optionalBoolean(raw, 'fallback', own);
  const deprecated = optionalBoolean(raw, 'deprecated', own);
  const replacedBy = replacedByFrom(raw, own);

  if (!own.commit() || !id || !label || !reason || !matches || !vector) return undefined;
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
    ...(fallback !== undefined ? { fallback } : {}),
    ...(deprecated !== undefined ? { deprecated } : {}),
    ...(replacedBy !== undefined ? { replaced_by: replacedBy } : {}),
  };
}

// ── One preset ───────────────────────────────────────────────────────────────

/**
 * One preset entry. The shape is the loader's (known keys, `gate` defaults
 * to `auto`) ; whether the budget is acceptable is `budgetIssues`, the rule
 * `presetIssues` applies to every catalog.
 */
function presetEntryFrom(raw: unknown, ctx: ParseContext): PresetEntry | undefined {
  if (!isRecord(raw)) return notAMapping(ctx);
  unknownKeys(raw, ENTRY_KEYS, ctx);
  if (isRecord(raw.rate_limit))
    unknownKeys(raw.rate_limit, RATE_LIMIT_KEYS, child(ctx, 'rate_limit'));
  const riskId = requireString(raw, 'risk_id', ctx);
  const budget = { quota: raw.quota, rate_limit: raw.rate_limit, gate: raw.gate ?? 'auto' };
  for (const issue of budgetIssues(budget)) {
    ctx.issues.push(`${ctx.at}.${issue.field}: ${issue.message}`);
  }
  if (!riskId || !isValidBudget(budget)) return undefined;
  return {
    risk_id: riskId,
    quota: budget.quota,
    rate_limit: {
      max: budget.rate_limit.max,
      window_seconds: budget.rate_limit.window_seconds,
    },
    gate: budget.gate,
  };
}

function presetEntriesFrom(raw: unknown, ctx: ParseContext): PresetEntry[] {
  if (!isUnknownList(raw) || raw.length === 0) {
    ctx.issues.push(`${ctx.at}: expected a non-empty list`);
    return [];
  }
  return raw.flatMap((item, j) => {
    const entry = presetEntryFrom(item, { at: `${ctx.at}[${j}]`, issues: ctx.issues });
    return entry ? [entry] : [];
  });
}

/** Assemble one preset ; `undefined` when its header or any of its entries reported. */
function presetFrom(raw: unknown, ctx: ParseContext): Preset | undefined {
  if (!isRecord(raw)) return notAMapping(ctx);
  const own = scoped(ctx);
  unknownKeys(raw, PRESET_KEYS, own);
  const id = requireString(raw, 'id', own);
  if (id !== undefined && !PRESET_ID_PATTERN.test(id))
    own.issues.push(`${own.at}.id '${id}' must be a lowercase slug`);
  const label = requireString(raw, 'label', own);
  const description = requireString(raw, 'description', own);
  const entries = presetEntriesFrom(raw.entries, child(own, 'entries'));
  if (!own.commit() || !id || !label || !description) return undefined;
  return { id, label, description, entries };
}
