/**
 * What the management door puts on the wire: snake_case projections of the
 * mission service's answers, written for an agent that composes a policy from
 * them (spec §4.1 bis "Read"). Pure: values in, values out.
 *
 * **The exact restriction** of a connection is the `authority` list of its
 * issuance context — the full catalog for an owner, the union of the shares
 * otherwise — together with whether its env-qualified ids can be touched at
 * all with the resources the connection has.
 *
 * A mission's state is the mission service's: `orphaned` is derived there
 * from the creator's current authority at every read (spec §2.3), with the
 * reason in `MissionOverview.orphan`. Nothing here reads a stored status.
 *
 * **No mission rule is restated here.** What a macro-action yields at a trust level
 * on a connection is `expandMacroAction`, what the built-in `everything-i-hold`
 * writes out is `everythingIHold`, whether an env-qualified id can be reached is
 * `isResolvable`, whether an orphaned mission can serve again is
 * `explainOrphan` — the functions the interface and the preview use, so the
 * agent's tools and the web pages cannot answer differently.
 */
import {
  policyLineKey,
  type Budget,
  type Gate,
  type MissionPolicyEntry,
  type RiskId,
} from '@vaubaan/shared';

import {
  TRUST_LEVEL_BUDGET_FACTOR,
  TRUST_LEVEL_GATES,
  defaultResources,
  everythingIHold,
  expandMacroAction,
  explainOrphan,
  isResolvable,
  macroActionOfRisk,
  tierOf,
  TRUST_LEVELS,
  type DraftPeriod,
  type IssuanceConnection,
  type MissionDetail,
  type MissionIssuer,
  type MissionOverview,
  type MissionPreview,
  type Tier,
  takesFutureResources,
  type TrustLevel,
} from '../missions';
import type { ProviderCatalog } from './ports';

// ─────────────────────────────────────────────────────────────────────────────
// Connections
// ─────────────────────────────────────────────────────────────────────────────

export interface ResourceView {
  readonly ref: string;
  readonly display_name: string;
  /**
   * Its environment label: its own (the owner's or the plugin's), else the
   * connection's `default_env`; `null` when it has neither.
   */
  readonly env: string | null;
  /** Hidden by the owner: left out of `{ scope: 'all' }`, still selectable by ref. */
  readonly hidden: boolean;
}

export interface EnvUsabilityView {
  /** The provider reads the environment from the call itself: no label is needed. */
  readonly derives_env: boolean;
  /**
   * The label the connection's owner gave every resource without one of its own;
   * `null` when none. Already counted in `labelled_envs` and the resources' `env`.
   */
  readonly default_env: string | null;
  /** Environments at least one resource of the connection is labelled with. */
  readonly labelled_envs: readonly string[];
  /** Resources with no label: an env-qualified risk is refused on them at call time. */
  readonly unlabelled_resources: readonly string[];
  /** Env-qualified ids of the authority a mission can actually reach here. */
  readonly usable_risk_ids: readonly RiskId[];
  /** Env-qualified ids of the authority whose environment no resource carries: a draft naming one is refused. */
  readonly unusable_risk_ids: readonly RiskId[];
}

/** What one macro-action at one trust level writes on this connection, with the resources known now. */
export interface TrustLevelYieldView {
  /** Lines that run freely. */
  readonly auto: number;
  /** Lines that ask the creator first. */
  readonly approval: number;
  /** Risks the trust level does not accept (tier 4 at Careful). */
  readonly left_out: number;
}

export interface MacroActionSummaryView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /**
   * What `trust levels: { [id]: trust level }` writes here at each trust level, over the resources
   * known now (the draft's default `all`). A narrower selection yields fewer
   * lines; `preview_policy` says which.
   */
  readonly at_trust_level: Readonly<Record<TrustLevel, TrustLevelYieldView>>;
  /** Risks of the macro-action outside the user's authority here, or that no resource can reach. */
  readonly unavailable: readonly RiskId[];
}

/** The gateway's own `everything-i-hold` on this connection, over the resources known now. */
export interface EverythingSummaryView {
  readonly label: string;
  readonly description: string;
  /** How many explicit lines it writes. */
  readonly risks: number;
}

export interface ConnectionView {
  readonly connection_id: string;
  readonly provider: string;
  readonly provider_label: string;
  readonly display_name: string;
  /** `active`, or `expired`: missions on it fail until an owner reconnects it. */
  readonly status: string;
  readonly authority: {
    /** `owner`: the user's own connection or their group's. `share`: what they were shared. */
    readonly basis: 'owner' | 'share';
    /** The exact restriction: every RiskId a mission of this user may accept here. Nothing else passes. */
    readonly risk_ids: readonly RiskId[];
    /** True when `risk_ids` is the provider's whole catalog. */
    readonly whole_catalog: boolean;
  };
  readonly resources: readonly ResourceView[];
  readonly env_qualified_risks: EnvUsabilityView;
  /** What the user may tick here, catalog order, "Anything else" last. */
  readonly macro_actions: readonly MacroActionSummaryView[];
  readonly everything_i_hold: EverythingSummaryView;
}

/** The resources a new mission can select: the ones discovery still returns. */
/** What a mission may select: still returned by discovery, and not one of the instance's own. */
function selectable(connection: IssuanceConnection): IssuanceConnection['resources'] {
  return connection.resources.filter((r) => !r.stale && !r.self);
}

function macroActionSummary(
  connection: IssuanceConnection,
  action: IssuanceConnection['macro_actions'][number],
): MacroActionSummaryView {
  const resources = defaultResources(connection);
  const at = (trustLevel: TrustLevel): TrustLevelYieldView => {
    const { lines, left_out } = expandMacroAction(connection, action, trustLevel, resources);
    const approval = lines.filter((line) => line.gate === 'approval').length;
    return { auto: lines.length - approval, approval, left_out: left_out.length };
  };
  const { unavailable } = expandMacroAction(connection, action, 'careful', resources);
  return {
    id: action.id,
    label: action.label,
    description: action.description,
    at_trust_level: {
      careful: at('careful'),
      trusting: at('trusting'),
      autonomous: at('autonomous'),
    },
    unavailable: unavailable.map((risk) => risk.risk_id),
  };
}

/**
 * The built-in `everything-i-hold` on this connection, written out over every
 * resource known now (`defaultResources`, the draft's default `all`): inside
 * the authority by construction.
 */
function everythingOf(connection: IssuanceConnection) {
  return everythingIHold(connection, defaultResources(connection));
}

function envUsability(connection: IssuanceConnection): EnvUsabilityView {
  const resources = selectable(connection);
  const labelled = [...new Set(resources.flatMap((r) => (r.env === null ? [] : [r.env])))];
  const held = new Set(connection.authority);
  const envQualified = connection.risks.filter((r) => r.env !== null && held.has(r.risk_id));
  const reachable = (risk: (typeof envQualified)[number]): boolean =>
    isResolvable(risk, connection, resources);
  return {
    derives_env: connection.derives_env,
    default_env: connection.default_env,
    labelled_envs: labelled,
    unlabelled_resources: resources.filter((r) => r.env === null).map((r) => r.ref),
    usable_risk_ids: envQualified.filter(reachable).map((r) => r.risk_id),
    unusable_risk_ids: envQualified.filter((r) => !reachable(r)).map((r) => r.risk_id),
  };
}

export function connectionView(connection: IssuanceConnection): ConnectionView {
  return {
    connection_id: connection.id,
    provider: connection.provider,
    provider_label: connection.provider_label,
    display_name: connection.display_name,
    status: connection.status,
    authority: {
      basis: connection.basis,
      risk_ids: connection.authority,
      whole_catalog: connection.authority.length === connection.risks.length,
    },
    resources: selectable(connection).map((r) => ({
      ref: r.ref,
      display_name: r.display_name,
      env: r.env,
      hidden: r.hidden,
    })),
    env_qualified_risks: envUsability(connection),
    macro_actions: connection.macro_actions.map((action) => macroActionSummary(connection, action)),
    everything_i_hold: (() => {
      const everything = everythingOf(connection);
      return {
        label: everything.label,
        description: everything.description,
        risks: everything.entries.length,
      };
    })(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

export interface CatalogRiskView {
  readonly risk_id: RiskId;
  /** The environment the id is qualified with; `null` for an account-scoped risk. */
  readonly env: string | null;
  readonly label: string;
  readonly reason: string;
  readonly level: string;
  /** 1 mild to 4 irreversible, read from the vector: what a trust level maps to a gate. */
  readonly tier: Tier;
  /** The macro-action the risk belongs to; `anything-else` for the fallback, `null` when deprecated. */
  readonly macro_action: string | null;
  /** The catalog's catch-all for writes it does not name; only in "Anything else". */
  readonly fallback: boolean;
  readonly deprecated: boolean;
  /** Hard ceiling of the rate limit, per minute, when the catalog sets one. */
  readonly rate_ceiling_per_minute: number | null;
  /** Present when a connection was named: is this id inside the user's authority on it? */
  readonly in_my_authority?: boolean;
}

export interface CatalogView {
  readonly provider: string;
  readonly provider_label: string;
  readonly derives_env: boolean;
  /** The connection the `in_my_authority` flags are about; `null` when none was named. */
  readonly connection_id: string | null;
  readonly risks: readonly CatalogRiskView[];
  /** The macro-actions, each risk with its base budget (unqualified ids: one line per environment reached). */
  readonly macro_actions: readonly CatalogMacroActionView[];
  /** Per trust level: the gate of each tier (`null`: not accepted) and the factor on the base budget. */
  readonly trust_levels: Readonly<Record<TrustLevel, TrustLevelRuleView>>;
  /** With a connection: the built-in `everything-i-hold` written out for it, entry by entry. */
  readonly everything_i_hold?: {
    readonly label: string;
    readonly description: string;
    readonly entries: readonly MissionPolicyEntry[];
  };
}

export interface CatalogMacroActionView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly entries: readonly ({ readonly risk_id: RiskId } & Budget)[];
}

export interface TrustLevelRuleView {
  readonly gates: Readonly<Record<`${Tier}`, Gate | null>>;
  readonly budget_factor: number;
}

function trustLevelRules(): Record<TrustLevel, TrustLevelRuleView> {
  const rule = (trustLevel: TrustLevel): TrustLevelRuleView => ({
    gates: {
      '1': TRUST_LEVEL_GATES[trustLevel][1],
      '2': TRUST_LEVEL_GATES[trustLevel][2],
      '3': TRUST_LEVEL_GATES[trustLevel][3],
      '4': TRUST_LEVEL_GATES[trustLevel][4],
    },
    budget_factor: TRUST_LEVEL_BUDGET_FACTOR[trustLevel],
  });
  return Object.fromEntries(
    TRUST_LEVELS.map((trustLevel) => [trustLevel, rule(trustLevel)]),
  ) as Record<TrustLevel, TrustLevelRuleView>;
}

export function catalogView(
  catalog: ProviderCatalog,
  connection: IssuanceConnection | null,
): CatalogView {
  const held = connection ? new Set(connection.authority) : null;
  return {
    provider: catalog.provider,
    provider_label: catalog.provider_label,
    derives_env: catalog.derives_env,
    connection_id: connection?.id ?? null,
    risks: catalog.risks.map((risk) => ({
      risk_id: risk.risk_id,
      env: risk.env,
      label: risk.label,
      reason: risk.reason,
      level: risk.level,
      tier: tierOf(risk.vector),
      macro_action: macroActionOfRisk(catalog, risk)?.id ?? null,
      fallback: risk.fallback,
      deprecated: risk.deprecated,
      rate_ceiling_per_minute: risk.rate_ceiling_per_minute,
      ...(held ? { in_my_authority: held.has(risk.risk_id) } : {}),
    })),
    macro_actions: catalog.macro_actions.map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description,
      entries: action.entries.map((entry) => ({
        risk_id: entry.risk_id,
        quota: entry.quota,
        rate_limit: entry.rate_limit,
      })),
    })),
    trust_levels: trustLevelRules(),
    ...(connection
      ? (() => {
          const everything = everythingOf(connection);
          return {
            everything_i_hold: {
              label: everything.label,
              description: everything.description,
              entries: everything.entries,
            },
          };
        })()
      : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Missions
// ─────────────────────────────────────────────────────────────────────────────

export type MissionStateName = MissionOverview['state']['kind'];

/** Why a mission is orphaned right now, and whether the authority can come back. */
export interface OrphanView {
  /** `creator-removed`, `connection-missing`, `connection-revoked` or `authority-lost`. */
  readonly cause: NonNullable<MissionOverview['orphan']>['cause'];
  /** The connection the cause was met on; `null` when the user themselves is gone. */
  readonly connection_id: string | null;
  /** The accepted risks the user's current authority no longer covers. */
  readonly uncovered: readonly RiskId[];
  /**
   * True when the mission serves calls again as soon as the authority returns
   * (the share is made again, the user is back in the owner group), with its
   * session and counters intact. A revoked or deleted connection never comes back.
   */
  readonly can_come_back: boolean;
}

function orphanView(orphan: NonNullable<MissionOverview['orphan']>): OrphanView {
  return {
    cause: orphan.cause,
    connection_id: orphan.connection_id,
    uncovered: orphan.uncovered,
    // The mission module's answer (`explainOrphan`), not a second list of causes.
    can_come_back: explainOrphan(orphan, []).reversible,
  };
}

export interface LostConnectionView {
  readonly connection_id: string;
  readonly cause: MissionOverview['lost'][number]['cause'];
  readonly final: boolean;
}

export interface MissionPolicyView {
  readonly risk_id: RiskId;
  /** The resource set of its connection the line belongs to (risk model §4.7). */
  readonly resource_set_id: string;
  readonly quota: number;
  readonly rate_limit: { readonly max: number; readonly window_seconds: number };
  readonly gate: Gate;
  /** Actions left this period; `null` when the mission serves no call. */
  readonly remaining: number | null;
}

export interface IssuedViaView {
  /** The OAuth client that issued the mission on the user's behalf. */
  readonly client_id: string;
  readonly client_name: string;
  /** True when it is the client making this very call. */
  readonly this_client: boolean;
  /**
   * True when the delegation making this very call issued it: the only missions
   * `rotate_mission_token` accepts. A client that was authorized again holds a new
   * delegation, so `this_client` may be true while this is false.
   */
  readonly this_delegation: boolean;
}

/** Who is reading: the client and the delegation of the call (`ManagementActor`). */
export interface MissionViewer {
  readonly clientId: string;
  readonly delegationId: string;
}

export interface MissionView {
  readonly mission_id: string;
  readonly name: string;
  /**
   * What the user is to this mission: `creator` — they issued it, they alone
   * change it and answer its requests — or `member` — its creator shared it
   * with them: they read it and use it as it is, with their own token.
   */
  readonly role: 'creator' | 'member';
  /** Email of the mission's creator; `null` when unknown. The user's own for `creator`. */
  readonly creator_email: string | null;
  readonly state: MissionStateName;
  /** Set while the mission is orphaned: every call is refused until the authority returns. */
  readonly orphan: OrphanView | null;
  /**
   * The connections that no longer serve this mission, while it may serve through its
   * others: `cause` `connection-revoked` (removed by its owner) or `connection-missing`
   * never come back (`final: true`); `access-withdrawn` (the user's access to it was
   * withdrawn) serves again if the access returns. Calls through them are refused
   * `connection-revoked`. Nothing is added in their place: to reach the account that
   * replaced one, issue a new mission. Empty when every connection serves.
   */
  readonly lost_connections: readonly LostConnectionView[];
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly period: DraftPeriod;
  /** The current period of the session; `end` is `null` for a one-off mission. */
  readonly session: { readonly period_start: string; readonly period_end: string | null } | null;
  /** `null` when the user issued it themselves in the interface. */
  readonly issued_via: IssuedViaView | null;
  /**
   * Masked prefix of the user's own active token of this mission; `null` when
   * they have none (a member who has not generated theirs). The secret is
   * never shown again.
   */
  readonly token_prefix: string | null;
  readonly connection_ids: readonly string[];
  /**
   * Per connection, its resource sets: each an explicit list of one environment,
   * `future` when the resources that later appear in that environment join it.
   */
  readonly resource_selections: readonly ResourceSelectionView[];
  readonly policy: readonly MissionPolicyView[];
  /** Accepted risks whose quota is spent for the period: calls on them are refused with a claim URL. */
  readonly exhausted: readonly RiskId[];
}

function issuedViaView(issuer: MissionIssuer | null, viewer: MissionViewer): IssuedViaView | null {
  if (!issuer) return null;
  return {
    client_id: issuer.client_id,
    client_name: issuer.client_name,
    this_client: issuer.client_id === viewer.clientId,
    this_delegation: issuer.delegation_id === viewer.delegationId,
  };
}

export interface ResourceSelectionView {
  readonly connection_id: string;
  /** A set of the connection takes future resources. */
  readonly future: boolean;
  /**
   * The resource sets of the connection, in order (risk model §4.7): each with its
   * environment and `future`; a policy line names its set by `resource_set_id`.
   */
  readonly resource_sets: readonly {
    readonly resource_set_id: string;
    readonly position: number;
    readonly future: boolean;
    readonly env: string | null;
  }[];
}

export function missionView(
  overview: MissionOverview,
  viewer: MissionViewer,
  maskToken: (prefix: string) => string,
): MissionView {
  const { mission, state } = overview;
  const serving = state.kind === 'active' ? state : null;
  return {
    mission_id: mission.id,
    name: mission.name,
    role: overview.role,
    creator_email: overview.creator.email,
    state: state.kind,
    orphan: overview.orphan ? orphanView(overview.orphan) : null,
    lost_connections: overview.lost.map((part) => ({
      connection_id: part.connection_id,
      cause: part.cause,
      final: part.final,
    })),
    created_at: mission.createdAt,
    expires_at: mission.expiresAt,
    period:
      mission.periodSeconds === null
        ? { kind: 'one-off' }
        : { kind: 'recurring', length_seconds: mission.periodSeconds },
    session: serving
      ? { period_start: serving.period.start, period_end: serving.period.end }
      : null,
    issued_via: issuedViaView(overview.issued_via, viewer),
    token_prefix: overview.token ? maskToken(overview.token.prefix) : null,
    connection_ids: mission.connections.map((c) => c.connectionId),
    resource_selections: mission.connections.map((c) => ({
      connection_id: c.connectionId,
      future: takesFutureResources(c),
      resource_sets: c.resourceSets.map((set) => ({
        resource_set_id: set.id,
        position: set.position,
        future: set.future,
        env: set.env,
      })),
    })),
    policy: mission.policy.map((entry) => ({
      risk_id: entry.riskId,
      resource_set_id: entry.resourceSetId,
      quota: entry.quota,
      rate_limit: { max: entry.rateLimit, window_seconds: entry.rateWindowSeconds },
      gate: entry.gate,
      remaining: serving
        ? (serving.remaining[policyLineKey(entry.resourceSetId, entry.riskId)] ?? null)
        : null,
    })),
    // A risk spent in one of its sets is listed once.
    exhausted: serving
      ? [
          ...new Set(
            mission.policy
              .filter((e) => serving.exhausted.includes(policyLineKey(e.resourceSetId, e.riskId)))
              .map((e) => e.riskId),
          ),
        ]
      : [],
  };
}

export interface MissionDetailView extends MissionView {
  readonly connections: readonly {
    readonly connection_id: string;
    readonly provider: string;
    readonly display_name: string;
    readonly status: string;
    /** A set takes the resources that later appear in its environment. */
    readonly future: boolean;
    /** When discovery last ran on the connection; `null` when never. */
    readonly last_checked_at: string | null;
    /** The resources the mission reaches now: its lists, less what discovery no longer finds. */
    readonly resources: readonly { readonly ref: string; readonly env: string | null }[];
    /** Present when the connection has several resource sets (risk model §4.7). */
    readonly resource_sets?: readonly {
      readonly resource_set_id: string;
      readonly position: number;
      readonly future: boolean;
      readonly env: string | null;
      readonly resources: readonly { readonly ref: string; readonly env: string | null }[];
    }[];
  }[];
  /** Risk labels, and until when a gated risk was opened by the creator for the period. */
  readonly policy_details: readonly {
    readonly risk_id: RiskId;
    readonly resource_set_id: string;
    readonly label: string;
    readonly gate_open_until: string | null;
  }[];
}

export function missionDetailView(
  detail: MissionDetail,
  viewer: MissionViewer,
  maskToken: (prefix: string) => string,
): MissionDetailView {
  return {
    ...missionView(detail, viewer, maskToken),
    connections: detail.connections.map((c) => ({
      connection_id: c.id,
      provider: c.provider,
      display_name: c.display_name,
      status: c.status,
      future: c.future,
      last_checked_at: c.last_checked_at,
      resources: c.resources.map((r) => ({ ref: r.ref, env: r.env })),
      ...(c.resource_sets.length > 1
        ? {
            resource_sets: c.resource_sets.map((set) => ({
              resource_set_id: set.id,
              position: set.position,
              future: set.future,
              env: set.env,
              resources: set.resources.map((r) => ({ ref: r.ref, env: r.env })),
            })),
          }
        : {}),
    })),
    policy_details: detail.policy.map((entry) => ({
      risk_id: entry.risk_id,
      resource_set_id: entry.resource_set_id ?? '',
      label: entry.label,
      gate_open_until: entry.gate_open_until,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

/** The uncovered list of spec §3.1: accepted risks outside the user's authority, per connection. */
export interface UncoveredView {
  readonly connection_id: string;
  readonly provider: string;
  readonly risk_ids: readonly RiskId[];
}

export function uncoveredOfPreview(preview: MissionPreview): UncoveredView[] {
  return preview.connections
    .filter((c) => c.exceeds.length > 0)
    .map((c) => ({ connection_id: c.connection_id, provider: c.provider, risk_ids: c.exceeds }));
}

export interface PreviewView {
  /** True when `issue_mission` would accept this draft unchanged. */
  readonly ok: boolean;
  /** Why the draft cannot be issued as written; empty when `ok`. */
  readonly issues: MissionPreview['issues'];
  /** What to know about a draft that passes; never blocks. */
  readonly notices: MissionPreview['notices'];
  /** Accepted risks outside the user's authority. Remove them: the agent cannot obtain them. */
  readonly uncovered: readonly UncoveredView[];
  readonly name: string;
  /** What the mission could call, exactly as it would be persisted. */
  readonly policy: MissionPreview['policy'];
  readonly connections: readonly {
    readonly connection_id: string;
    readonly provider: string;
    readonly display_name: string;
    /** A set takes the resources that later appear in its environment. */
    readonly future: boolean;
    readonly resources: readonly { readonly ref: string; readonly env: string | null }[];
    /** The built-in everything-i-hold wrote this connection's lines. */
    readonly everything_i_hold: boolean;
    readonly passes: MissionPreview['policy'];
    readonly exceeds: readonly RiskId[];
    readonly unknown: readonly RiskId[];
    readonly unresolvable: MissionPreview['connections'][number]['unresolvable'];
    readonly missing_budget: readonly RiskId[];
    readonly left_out: MissionPreview['connections'][number]['left_out'];
    /** The trust levels kept with the mission: the ones naming a macro-action of the connection. */
    readonly trust_levels: MissionPreview['connections'][number]['trust_levels'];
    /**
     * Present when the draft gives the connection several resource sets (risk model
     * §4.7): what each set yields, in order. The connection's own fields are then the
     * sets' together.
     */
    readonly resource_sets?: readonly PreviewSetView[];
  }[];
  readonly period: DraftPeriod;
  readonly expires_at: string | null;
  /** Three lines: what the mission can do, cannot do, in what quantity. */
  readonly summary: MissionPreview['summary'];
}

/** What one resource set of a draft connection yields, as the door answers it. */
export interface PreviewSetView {
  readonly index: number;
  readonly future: boolean;
  readonly env: string | null;
  readonly resources: readonly { readonly ref: string; readonly env: string | null }[];
  readonly everything_i_hold: boolean;
  readonly passes: MissionPreview['policy'];
  readonly exceeds: readonly RiskId[];
  readonly left_out: MissionPreview['connections'][number]['left_out'];
  readonly trust_levels: MissionPreview['connections'][number]['trust_levels'];
}

export function previewView(preview: MissionPreview): PreviewView {
  return {
    ok: preview.ok,
    issues: preview.issues,
    notices: preview.notices,
    uncovered: uncoveredOfPreview(preview),
    name: preview.name,
    policy: preview.policy,
    connections: preview.connections.map((c) => ({
      connection_id: c.connection_id,
      provider: c.provider,
      display_name: c.display_name,
      future: c.future,
      resources: c.resources.map((r) => ({ ref: r.ref, env: r.env })),
      everything_i_hold: c.everything_i_hold,
      passes: c.passes,
      exceeds: c.exceeds,
      unknown: c.unknown,
      unresolvable: c.unresolvable,
      missing_budget: c.missing_budget,
      left_out: c.left_out,
      trust_levels: c.trust_levels,
      ...(c.resource_sets.length > 1
        ? {
            resource_sets: c.resource_sets.map((set) => ({
              index: set.index,
              future: set.future,
              env: set.env,
              resources: set.resources.map((r) => ({ ref: r.ref, env: r.env })),
              everything_i_hold: set.everything_i_hold,
              passes: set.passes,
              exceeds: set.exceeds,
              left_out: set.left_out,
              trust_levels: set.trust_levels,
            })),
          }
        : {}),
    })),
    period: preview.period,
    expires_at: preview.expires_at,
    summary: preview.summary,
  };
}
