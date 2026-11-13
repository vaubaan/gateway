/**
 * One risk of a YAML catalog, read field by field : id, words, patterns,
 * the five-axis vector and its per-environment overrides, the environments,
 * the limits, the fallback and deprecation flags. Every reader returns the
 * typed value, or `undefined` after reporting at its path
 * (`risks[3].vector.blast`).
 *
 * Spec : docs/spec/gateway-risk-model.md §4 (schema, versioning).
 */

import {
  ENV_LABEL_PATTERN,
  RISK_VECTOR_AXES,
  isRiskId,
  parseRiskId,
  type RiskEntry,
  type RiskId,
  type RiskVector,
  type ScopeCaps,
} from '@vaubaan/shared';

import {
  child,
  isNonEmptyStringList,
  isPositiveInt,
  notAMapping,
  requireString,
  scoped,
  unknownKeys,
  type ParseContext,
  type Rec,
} from './catalog-parse.ts';
import { isList, isRecord } from './guards.ts';

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
/** The cap keys `caps` and `infra_limits` accept — every key of `ScopeCaps`, in declaration order. */
const SCOPE_CAP_KEYS = [
  'temporal_window_days',
  'items_per_call_max',
  'bytes_per_call_max',
  'calls_per_minute_max',
  'calls_per_session_max',
] as const satisfies readonly (keyof ScopeCaps)[];
const CAP_KEYS: ReadonlySet<string> = new Set(SCOPE_CAP_KEYS);

type Axis = keyof RiskVector;
/** The five axes, in declaration order. `Object.keys` widens to `string[]` ; the keys of a constant object are its keys. */
const AXES = Object.keys(RISK_VECTOR_AXES) as readonly Axis[];

// ── Risk vector ──────────────────────────────────────────────────────────────

/** The sixth axis of SDK 0.8 and earlier: refused like any unknown key, with a hint. */
const RETIRED_AXIS = 'persistence';

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
    ctx.issues.push(`${ctx.at}: expected a mapping of the five risk axes`);
    return undefined;
  }
  const out: MutableVector = {};
  for (const axis of AXES) readAxis(raw, axis, out, ctx, required);
  for (const key of Object.keys(raw)) {
    if (key in RISK_VECTOR_AXES) continue;
    ctx.issues.push(
      key === RETIRED_AXIS
        ? `${ctx.at}.${key}: unknown axis (retired on 2026-11-13, spec gateway-risk-model §4.2: remove the line)`
        : `${ctx.at}.${key}: unknown axis`,
    );
  }
  return out;
}

/** True iff every one of the five axes is set : the partial vector is a `RiskVector`. */
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
  if (!isList(envs) || envs.length === 0) {
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
export function riskFrom(
  raw: unknown,
  ctx: ParseContext,
  provider: string | null,
): RiskEntry | undefined {
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
