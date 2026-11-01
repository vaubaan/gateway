/**
 * Decision core (pure functions).
 *
 * Spec: docs/spec/gateway-risk-model.md §8 (strict-fail runtime);
 * docs/spec/vaubaan-gateway.md §4.1 ("check `risks_touched ⊆ accepted_risks`").
 *
 * `evaluateCallForMission` classifies a call into slices, intersects them with
 * the provider catalog, and produces an allow/deny verdict. Unchanged by the
 * v5 pivot: v5 adds the budget *after* this decision, it does not change
 * which risks are acceptable. The pipeline (`pipeline.ts`) orchestrates
 * around it; keeping this module pure keeps it trivially unit-testable.
 *
 * Environments are resolved through the policy engine's `EnvResolver`
 * (ADR plugin-contract-and-credential-spec D3, fallback-risk-only-when-
 * uncategorized D4): by default `envResolverFor(resources, adapter.envOf)`
 * — the plugin's own derivation first (Vercel's `env[prod]` segment), the
 * owner's label on the matching resource next, unqualified last — so a
 * mission that accepted `supabase[staging].bulk-row-write` matches an
 * executed `supabase.bulk-row-write` on the staging resource, and one that
 * accepted `vercel[prod].env-var-write` matches a prod env-var write on a
 * project the owner labelled otherwise. A host may still pass another
 * resolver.
 */

import type { RefusalCode, Resource, RiskDecision, RiskId, Slice } from '@vaubaan/shared';
import type { ClassifyConnection, ClassifyOutcome, ProviderPlugin } from '@vaubaan/plugin-sdk';

import {
  envResolverFor,
  evaluateCall,
  type EnvResolver,
  type IndexedRiskCatalog,
  type UNQUALIFIED,
} from '@vaubaan/policy-engine';

export type { ClassifyOutcome } from '@vaubaan/plugin-sdk';

/** What the decision core reads from the mission: the accepted set. */
export interface AcceptedRisksSnapshot {
  readonly id: string;
  readonly accepted_risks: readonly RiskId[];
}

/** Verdict returned by `evaluateCallForMission`. */
/** What the verdict of a call judged against resource sets adds (risk model §4.7). */
interface ResourceSetsJudged {
  /** The candidate sets the call was judged against, in position order. Absent: no set. */
  resource_set_ids?: readonly string[];
  /** The risks every candidate set accepts: what the call was judged against, for the
   *  audit's accepted snapshot. Absent: the mission's whole accepted list. */
  accepted_risks?: readonly RiskId[];
}

export type CallVerdict =
  | ({
      kind: 'allow';
      risks_touched: readonly RiskId[];
      executed_slices: readonly Slice[];
    } & ResourceSetsJudged)
  | ({
      kind: 'deny';
      /** The structured refusal code carried by the engine's decision. */
      code: Extract<RefusalCode, 'risk-not-accepted'>;
      missing_risks: readonly RiskId[];
      /** Every risk the call touched, accepted (covered) or not (missing),
       *  for the audit entry. */
      risks_touched: readonly RiskId[];
      executed_slices: readonly Slice[];
      hint: string;
      /** The missing risks per candidate set, when the call was judged against several. */
      missing_by_set?: readonly { resource_set_id: string; missing_risks: readonly RiskId[] }[];
    } & ResourceSetsJudged)
  | { kind: 'classify-denied'; reason: string }
  | { kind: 'no-catalog'; provider: string };

/**
 * The classification half of the plugin contract: `classify(tool, args,
 * resources)` plus the optional `envOf` derivation. A `ProviderPlugin`
 * satisfies it as-is; tests pass a stub.
 */
export type Classifier = Pick<ProviderPlugin, 'classify' | 'envOf'>;

/**
 * Pure: classify a call into slices, intersect with the provider catalog,
 * decide allow/deny. The caller does the resource, budget, upstream and
 * audit work around it and emits the JSON-RPC response.
 *
 * `executed_slices` and `risks_touched` are always present on the verdict
 * (for the audit entry) — even on `deny` outcomes — so the caller can record
 * them regardless of decision.
 */
export function evaluateCallForMission(input: {
  tool: string;
  args: Readonly<Record<string, unknown>>;
  /** The mission's resources on the connection the call targets. Handed to
   *  the classifier and, unless `envResolver` is given, composed with the
   *  adapter's `envOf` to qualify the touched risks by environment. */
  resources: readonly Resource[];
  /** The public form fields of that connection, handed to the classifier
   *  (`ClassifyConnection`); absent outside a host. */
  connection?: ClassifyConnection;
  mission: AcceptedRisksSnapshot;
  adapter: Classifier;
  catalog: IndexedRiskCatalog | undefined;
  /** Defaults to `envResolverFor(resources, adapter.envOf)`. A resolver
   *  replaces the default; `'unqualified'` asks for the engine's mode
   *  without env qualification (catalog tooling and tests, never a host). */
  envResolver?: EnvResolver | typeof UNQUALIFIED;
}): CallVerdict {
  const { tool, args, resources, mission, adapter, catalog } = input;

  if (!catalog) {
    return { kind: 'no-catalog', provider: 'unknown' };
  }

  const classified: ClassifyOutcome = adapter.classify(tool, args, resources, input.connection);
  if ('denied' in classified) {
    return { kind: 'classify-denied', reason: classified.denied };
  }

  const decision: RiskDecision = evaluateCall({
    executed_slices: classified.slices,
    accepted_risks: new Set(mission.accepted_risks),
    catalog,
    envResolver: input.envResolver ?? envResolverFor(resources, adapter.envOf?.bind(adapter)),
  });

  if (decision.outcome === 'allowed') {
    return {
      kind: 'allow',
      risks_touched: decision.risks_touched,
      executed_slices: classified.slices,
    };
  }
  return {
    kind: 'deny',
    code: decision.code,
    missing_risks: decision.missing_risks,
    risks_touched: [...decision.covered_risks, ...decision.missing_risks],
    executed_slices: classified.slices,
    hint: decision.hint,
  };
}

/** One resource set of the connection a call targets, with what it accepts. */
export interface ResourceSetToJudge {
  readonly id: string;
  /** Its place among the sets of the connection, from 1. */
  readonly position: number;
  /** The refs of the mission resources it holds. */
  readonly refs: readonly string[];
  /** The risks its lines accept. */
  readonly accepted_risks: readonly RiskId[];
}

/**
 * The candidate sets of a call (risk model §4.7): for each slice, the sets of every
 * identifier or list value of the slice equal to a mission resource's ref — the rule
 * `resourceEnvResolver` reads environments by — and, for a slice that names none, every
 * set of the connection. A slice citing refs of several sets brings each of them in: an
 * org slug equal to an app's ref (`fly.org[acme].app[acme-db]`) or a list
 * (`board[b1,b2]`) can only widen the candidates, never narrow them to one set. What
 * cannot be placed in one set never gets one set's rights alone. Position order.
 */
export function candidateResourceSets<S extends Pick<ResourceSetToJudge, 'id' | 'refs'>>(
  slices: readonly Slice[],
  sets: readonly S[],
): S[] {
  const setOfRef = new Map<string, S>();
  for (const set of sets) for (const ref of set.refs) setOfRef.set(ref, set);
  const chosen = new Set<S>();
  for (const slice of slices) {
    const named = namedSets(slice, setOfRef);
    if (named.length === 0) return [...sets];
    for (const set of named) chosen.add(set);
  }
  return sets.filter((set) => chosen.has(set));
}

/** The sets of every identifier or list value of the slice that is a mission resource's ref. */
function namedSets<S>(slice: Slice, setOfRef: ReadonlyMap<string, S>): S[] {
  const named: S[] = [];
  for (const segment of slice.path) {
    const values =
      segment.kind === 'ident' ? [segment.value] : segment.kind === 'list' ? segment.values : [];
    for (const value of values) {
      const set = setOfRef.get(value);
      if (set !== undefined) named.push(set);
    }
  }
  return named;
}

/** "resource set 2", or "resource sets 1 and 2". */
export function resourceSetsLabel(sets: readonly Pick<ResourceSetToJudge, 'position'>[]): string {
  const positions = sets.map((set) => String(set.position));
  if (positions.length === 1) return `resource set ${positions[0]}`;
  const last = positions.pop();
  return `resource sets ${positions.join(', ')} and ${last}`;
}

/**
 * Pure, like `evaluateCallForMission`, for a connection whose mission part holds
 * resource sets (risk model §4.7): the call is classified once, its candidate sets
 * found from the slices, and the risk step (`evaluateCall`, unchanged) runs once per
 * candidate set against that set's accepted risks. Every touched risk must be accepted
 * in every candidate set; the missing ones are the union. Environment resolution reads
 * the resources of the whole connection: the set chooses only the policy. When the
 * connection has several sets, a refusal's hint names the sets it was judged against.
 */
export function evaluateCallForResourceSets(input: {
  tool: string;
  args: Readonly<Record<string, unknown>>;
  /** Every mission resource of the connection, all sets together. */
  resources: readonly Resource[];
  connection?: ClassifyConnection;
  /** The sets of the connection, in position order; never empty. */
  sets: readonly ResourceSetToJudge[];
  adapter: Classifier;
  catalog: IndexedRiskCatalog | undefined;
  envResolver?: EnvResolver | typeof UNQUALIFIED;
}): CallVerdict {
  const { tool, args, resources, sets, adapter, catalog } = input;
  if (!catalog) return { kind: 'no-catalog', provider: 'unknown' };
  const classified: ClassifyOutcome = adapter.classify(tool, args, resources, input.connection);
  if ('denied' in classified) return { kind: 'classify-denied', reason: classified.denied };

  const slices = classified.slices;
  const candidates = candidateResourceSets(slices, sets);
  const envResolver = input.envResolver ?? envResolverFor(resources, adapter.envOf?.bind(adapter));
  const decisions = candidates.map((set) => ({
    set,
    decision: evaluateCall({
      executed_slices: slices,
      accepted_risks: new Set(set.accepted_risks),
      catalog,
      envResolver,
    }),
  }));
  const resource_set_ids = candidates.map((set) => set.id);
  const accepted_risks = intersection(candidates.map((set) => set.accepted_risks));

  const refused = decisions.flatMap(({ set, decision }) =>
    decision.outcome === 'denied' ? [{ set, decision }] : [],
  );
  const [first] = decisions;
  if (refused.length === 0 && first && first.decision.outcome === 'allowed') {
    return {
      kind: 'allow',
      risks_touched: first.decision.risks_touched,
      executed_slices: slices,
      resource_set_ids,
      accepted_risks,
    };
  }
  const [firstRefusal] = refused;
  if (!firstRefusal || firstRefusal.decision.outcome !== 'denied') {
    // No candidate set: a connection without sets accepts nothing.
    return {
      kind: 'deny',
      code: 'risk-not-accepted',
      missing_risks: [],
      risks_touched: [],
      executed_slices: slices,
      hint: 'this mission holds no resource set on this connection: it accepts nothing there.',
      resource_set_ids,
      accepted_risks,
    };
  }
  const missing: RiskId[] = [];
  const touched: RiskId[] = [];
  for (const { decision } of refused) {
    if (decision.outcome !== 'denied') continue;
    for (const r of decision.missing_risks) if (!missing.includes(r)) missing.push(r);
  }
  for (const { decision } of decisions) {
    const all =
      decision.outcome === 'allowed'
        ? decision.risks_touched
        : [...decision.covered_risks, ...decision.missing_risks];
    for (const r of all) if (!touched.includes(r)) touched.push(r);
  }
  const several = sets.length > 1;
  const hintOf = (decision: (typeof refused)[number]['decision']): string =>
    decision.outcome === 'denied' ? decision.hint : '';
  const hint = !several
    ? firstRefusal.decision.hint
    : candidates.length === 1
      ? `In ${resourceSetsLabel(candidates)} of this account, ${hintOf(firstRefusal.decision)}`
      : `This call cannot be placed in one resource set of this account, so it is judged against ${resourceSetsLabel(
          candidates,
        )}: every risk it touches must be accepted in each. ${refused
          .map(({ set, decision }) => `In ${resourceSetsLabel([set])}: ${hintOf(decision)}`)
          .join(' ')}`;
  return {
    kind: 'deny',
    code: firstRefusal.decision.code,
    missing_risks: missing,
    risks_touched: touched,
    executed_slices: slices,
    hint,
    resource_set_ids,
    accepted_risks,
    ...(several
      ? {
          missing_by_set: refused.map(({ set, decision }) => ({
            resource_set_id: set.id,
            missing_risks: decision.outcome === 'denied' ? decision.missing_risks : [],
          })),
        }
      : {}),
  };
}

/** The risks every list holds, in the order of the first. */
function intersection(lists: readonly (readonly RiskId[])[]): RiskId[] {
  const [first, ...rest] = lists;
  if (!first) return [];
  const others = rest.map((list) => new Set(list));
  return [...new Set(first)].filter((r) => others.every((other) => other.has(r)));
}
