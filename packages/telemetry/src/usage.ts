/**
 * The reports of the `usage-stats` level (spec §9): one decision report per
 * call the gateway decided, and one instance profile per UTC day.
 *
 * FROZEN SHAPES, like the plugin-health report (`report.ts`). Every value is a
 * word of a closed vocabulary, a shape bounded by a plugin's own declaration,
 * or a bucket. No string comes from an argument, a result, an error, a
 * provider, a person or a value the company configured — which is why a risk
 * travels without its environment qualifier (the label is the company's) and
 * a count travels as a bucket. Adding a key is a spec change (§9).
 *
 * The constructors return a fresh frozen object, or `null` for anything that
 * does not fit; the caller drops the report.
 */
import { REFUSAL_CODES, type RefusalCode } from '@vaubaan/shared/refusal';
import { parseRiskId } from '@vaubaan/shared/risk-id';

import { isGatewayVersion, REPORT_FIELD_PATTERNS } from './report.ts';

// ---------------------------------------------------------------------------
// Decision report
// ---------------------------------------------------------------------------

export const DECISION_REPORT_KEYS = [
  'plugin',
  'tool',
  'gateway_version',
  'decision',
  'risks',
  'gate',
] as const;

/**
 * `allowed`, or the refusal code the execution door answered. A token that
 * is not a mission token (`wrong-credential-kind`) names no plugin and is
 * not a decision about a call.
 */
export const DECISION_OUTCOMES = [
  'allowed',
  ...REFUSAL_CODES.filter((code) => code !== 'wrong-credential-kind'),
] as const satisfies readonly ('allowed' | RefusalCode)[];
export type DecisionOutcome = 'allowed' | Exclude<RefusalCode, 'wrong-credential-kind'>;

/** Whether an "ask me first" gate applied to the call. */
export const DECISION_GATES = ['approval', 'none'] as const;
export type DecisionGate = (typeof DECISION_GATES)[number];

/** More risks than this in one call is not a call any catalog describes. */
export const MAX_RISKS_PER_DECISION = 32;
const MAX_RISK_ID_LENGTH = 100;

export interface DecisionReport {
  readonly plugin: string;
  /** `null` when the agent named a tool the plugin does not declare. */
  readonly tool: string | null;
  readonly gateway_version: string;
  readonly decision: DecisionOutcome;
  /** Account-scoped RiskIds, sorted, without duplicates. */
  readonly risks: readonly string[];
  readonly gate: DecisionGate;
}

export interface DecisionReportInput {
  readonly plugin: string;
  readonly tool: string | null;
  readonly gateway_version: string;
  readonly decision: string;
  readonly risks: readonly string[];
  readonly gate: string;
}

/** True for an account-scoped RiskId of `plugin` (no environment qualifier). */
export function isReportableRiskId(plugin: string, value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_RISK_ID_LENGTH) return false;
  const parsed = parseRiskId(value);
  return parsed !== null && parsed.env === null && parsed.provider === plugin;
}

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function createDecisionReport(input: DecisionReportInput): DecisionReport | null {
  if (typeof input.plugin !== 'string' || !REPORT_FIELD_PATTERNS.plugin.test(input.plugin)) {
    return null;
  }
  const tool = input.tool;
  if (tool !== null && (typeof tool !== 'string' || !REPORT_FIELD_PATTERNS.tool.test(tool))) {
    return null;
  }
  if (!isGatewayVersion(input.gateway_version)) return null;
  if (!isOneOf<DecisionOutcome>(DECISION_OUTCOMES, input.decision)) return null;
  if (!isOneOf(DECISION_GATES, input.gate)) return null;
  if (!Array.isArray(input.risks) || input.risks.length > MAX_RISKS_PER_DECISION) return null;
  if (!input.risks.every((risk) => isReportableRiskId(input.plugin, risk))) return null;
  const risks = Object.freeze([...new Set(input.risks)].sort());
  return Object.freeze({
    plugin: input.plugin,
    tool,
    gateway_version: input.gateway_version,
    decision: input.decision,
    risks,
    gate: input.gate,
  });
}

// ---------------------------------------------------------------------------
// Instance profile
// ---------------------------------------------------------------------------

export const INSTANCE_PROFILE_KEYS = [
  'day_id',
  'gateway_version',
  'deployment',
  'runtime',
  'arch',
  'sign_in_kinds',
  'users',
  'active_missions',
  'calls',
  'plugins',
] as const;

export const PROFILE_PLUGIN_KEYS = ['plugin', 'plugin_version', 'accounts'] as const;

export const DEPLOYMENT_KINDS = ['docker', 'railway', 'fly', 'other'] as const;
export type DeploymentKind = (typeof DEPLOYMENT_KINDS)[number];

export const ARCHES = ['x64', 'arm64', 'other'] as const;
export type Arch = (typeof ARCHES)[number];

export const SIGN_IN_KINDS = ['oidc', 'github'] as const;
export type SignInKind = (typeof SIGN_IN_KINDS)[number];

/** Counts never travel exact. */
export const COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21-100', '101-1000', '>1000'] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

const COUNT_BUCKET_UPPER: readonly (readonly [number, CountBucket])[] = [
  [0, '0'],
  [1, '1'],
  [5, '2-5'],
  [20, '6-20'],
  [100, '21-100'],
  [1000, '101-1000'],
];

/** The bucket of a count; a negative or non-integer count is `0`. */
export function countBucket(count: number): CountBucket {
  if (!Number.isInteger(count) || count <= 0) return '0';
  for (const [upper, bucket] of COUNT_BUCKET_UPPER) if (count <= upper) return bucket;
  return '>1000';
}

/** The runtime's major version only: `node-22`. */
export const RUNTIME_PATTERN = /^node-[0-9]{1,3}$/;
/** 128 random bits, hex. Drawn again each UTC day, held in memory only. */
export const DAY_ID_PATTERN = /^[0-9a-f]{32}$/;
/** As many plugins as an instance can ship; more is not an instance. */
export const MAX_PROFILE_PLUGINS = 64;

export interface ProfilePlugin {
  readonly plugin: string;
  readonly plugin_version: string;
  readonly accounts: CountBucket;
}

export interface InstanceProfile {
  readonly day_id: string;
  readonly gateway_version: string;
  readonly deployment: DeploymentKind;
  readonly runtime: string;
  readonly arch: Arch;
  /** Sorted, without duplicates. */
  readonly sign_in_kinds: readonly SignInKind[];
  readonly users: CountBucket;
  readonly active_missions: CountBucket;
  /** Calls the execution door decided during the UTC day before the profile. */
  readonly calls: CountBucket;
  /** Sorted by plugin id, one entry per plugin. */
  readonly plugins: readonly ProfilePlugin[];
}

export interface InstanceProfileInput {
  readonly day_id: string;
  readonly gateway_version: string;
  readonly deployment: string;
  readonly runtime: string;
  readonly arch: string;
  readonly sign_in_kinds: readonly string[];
  readonly users: string;
  readonly active_missions: string;
  readonly calls: string;
  readonly plugins: readonly {
    readonly plugin: string;
    readonly plugin_version: string;
    readonly accounts: string;
  }[];
}

function createProfilePlugin(input: InstanceProfileInput['plugins'][number]): ProfilePlugin | null {
  if (typeof input !== 'object' || input === null) return null;
  if (typeof input.plugin !== 'string' || !REPORT_FIELD_PATTERNS.plugin.test(input.plugin)) {
    return null;
  }
  if (
    typeof input.plugin_version !== 'string' ||
    !REPORT_FIELD_PATTERNS.version.test(input.plugin_version)
  ) {
    return null;
  }
  if (!isOneOf(COUNT_BUCKETS, input.accounts)) return null;
  return Object.freeze({
    plugin: input.plugin,
    plugin_version: input.plugin_version,
    accounts: input.accounts,
  });
}

export function createInstanceProfile(input: InstanceProfileInput): InstanceProfile | null {
  if (typeof input.day_id !== 'string' || !DAY_ID_PATTERN.test(input.day_id)) return null;
  if (!isGatewayVersion(input.gateway_version)) return null;
  if (!isOneOf(DEPLOYMENT_KINDS, input.deployment)) return null;
  if (typeof input.runtime !== 'string' || !RUNTIME_PATTERN.test(input.runtime)) return null;
  if (!isOneOf(ARCHES, input.arch)) return null;
  if (!Array.isArray(input.sign_in_kinds)) return null;
  if (!input.sign_in_kinds.every((kind) => isOneOf(SIGN_IN_KINDS, kind))) return null;
  if (!isOneOf(COUNT_BUCKETS, input.users)) return null;
  if (!isOneOf(COUNT_BUCKETS, input.active_missions)) return null;
  if (!isOneOf(COUNT_BUCKETS, input.calls)) return null;
  if (!Array.isArray(input.plugins) || input.plugins.length > MAX_PROFILE_PLUGINS) return null;
  const plugins: ProfilePlugin[] = [];
  for (const entry of input.plugins as InstanceProfileInput['plugins']) {
    const plugin = createProfilePlugin(entry);
    if (plugin === null) return null;
    plugins.push(plugin);
  }
  if (new Set(plugins.map((p) => p.plugin)).size !== plugins.length) return null;
  plugins.sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
  return Object.freeze({
    day_id: input.day_id,
    gateway_version: input.gateway_version,
    deployment: input.deployment,
    runtime: input.runtime,
    arch: input.arch,
    sign_in_kinds: Object.freeze([...new Set(input.sign_in_kinds as readonly SignInKind[])].sort()),
    users: input.users,
    active_missions: input.active_missions,
    calls: input.calls,
    plugins: Object.freeze(plugins),
  });
}
