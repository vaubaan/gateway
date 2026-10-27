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
 * **No mission rule is restated here.** What a preset stands for on a
 * connection is `expandPreset`, what the built-in `everything-i-hold` writes
 * out is `everythingIHold`, whether an env-qualified id can be reached is
 * `isResolvable`, whether an orphaned mission can serve again is
 * `explainOrphan` — the functions the interface and the preview use, so the
 * agent's tools and the web pages cannot answer differently.
 */
import type { Gate, Preset, RiskId } from '@vaubaan/shared';

import {
  defaultResources,
  everythingIHold,
  expandPreset,
  explainOrphan,
  isResolvable,
  type DraftPeriod,
  type IssuanceConnection,
  type MissionDetail,
  type MissionIssuer,
  type MissionOverview,
  type MissionPreview,
  reachesLaterResources,
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

export interface PresetSummaryView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly risks: number;
  /**
   * True when every entry of the preset is inside the user's authority here.
   * About authority only: whether a resource carries the environment an entry
   * needs is `env_qualified_risks`, and `preview_policy` says what a selection
   * leaves out (`skipped_from_preset`).
   */
  readonly within_authority: boolean;
  /**
   * The preset entries the user's authority does not cover on this connection.
   * An entry naming an env-scoped risk is covered when the user holds it in at
   * least one environment (the preset is then issued for those).
   */
  readonly outside_authority: readonly RiskId[];
  /**
   * True for the gateway's own `everything-i-hold`: every risk of the authority
   * the connection's resources known now can reach, written out as explicit lines
   * at preview and issuance (`risks` counts them). False for a plugin's preset.
   */
  readonly built_in: boolean;
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
  readonly presets: readonly PresetSummaryView[];
}

/** The resources a new mission can select: the ones discovery still returns. */
/** What a mission may select: still returned by discovery, and not one of the instance's own. */
function selectable(connection: IssuanceConnection): IssuanceConnection['resources'] {
  return connection.resources.filter((r) => !r.stale && !r.self);
}

function presetSummary(preset: Preset, connection: IssuanceConnection): PresetSummaryView {
  const held = new Set(connection.authority);
  // Authority: the preset expanded over the part of the catalog the user holds,
  // whatever the labels. An entry that expands to nothing held comes back as
  // itself, and is outside. The expansion is the mission module's.
  const heldRisks = connection.risks.filter((risk) => held.has(risk.risk_id));
  const { lines } = expandPreset(preset, { risks: heldRisks, derives_env: true }, []);
  const outside = lines.map((line) => line.risk_id).filter((id) => !held.has(id));
  return {
    id: preset.id,
    label: preset.label,
    description: preset.description,
    risks: preset.entries.length,
    within_authority: outside.length === 0,
    outside_authority: outside,
    built_in: false,
  };
}

/**
 * The built-in preset on this connection, written out over every resource known
 * now (`defaultResources`, the draft's default `all`): inside the authority by
 * construction. A narrower selection yields fewer lines; `preview_policy` says
 * which.
 */
function builtInPresetOf(connection: IssuanceConnection): Preset {
  return everythingIHold(connection, defaultResources(connection));
}

function builtInSummary(connection: IssuanceConnection): PresetSummaryView {
  const preset = builtInPresetOf(connection);
  return {
    id: preset.id,
    label: preset.label,
    description: preset.description,
    risks: preset.entries.length,
    within_authority: true,
    outside_authority: [],
    built_in: true,
  };
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
    presets: [
      ...connection.presets.map((preset) => presetSummary(preset, connection)),
      builtInSummary(connection),
    ],
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
  /** The catalog's catch-all for writes it does not name; never in a preset. */
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
  /**
   * The plugin's presets as shipped; with a connection, then the built-in
   * `everything-i-hold` written out for it (`built_in: true`, `within_authority:
   * true`, `risks` its count), entry by entry.
   */
  readonly presets: readonly CatalogPresetView[];
}

export type CatalogPresetView =
  | Preset
  | (Preset & {
      readonly built_in: true;
      readonly within_authority: true;
      readonly risks: number;
    });

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
      fallback: risk.fallback,
      deprecated: risk.deprecated,
      rate_ceiling_per_minute: risk.rate_ceiling_per_minute,
      ...(held ? { in_my_authority: held.has(risk.risk_id) } : {}),
    })),
    presets: connection ? [...catalog.presets, builtInCatalogPreset(connection)] : catalog.presets,
  };
}

function builtInCatalogPreset(connection: IssuanceConnection): CatalogPresetView {
  const preset = builtInPresetOf(connection);
  return { ...preset, built_in: true, within_authority: true, risks: preset.entries.length };
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
   * Per connection, how far the mission reaches: `selected` — the resources
   * stored at issuance (a draft's `all` is stored so); `connection` — the whole
   * connection, resources discovered later included.
   */
  readonly resource_scopes: readonly ResourceScopeView[];
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

export interface ResourceScopeView {
  readonly connection_id: string;
  readonly resource_scope: 'selected' | 'connection';
}

function resourceScopeOf(
  c: MissionOverview['mission']['connections'][number],
): ResourceScopeView['resource_scope'] {
  return reachesLaterResources(c) ? 'connection' : 'selected';
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
    issued_via: issuedViaView(overview.issuedVia, viewer),
    token_prefix: overview.token ? maskToken(overview.token.prefix) : null,
    connection_ids: mission.connections.map((c) => c.connectionId),
    resource_scopes: mission.connections.map((c) => ({
      connection_id: c.connectionId,
      resource_scope: resourceScopeOf(c),
    })),
    policy: mission.policy.map((entry) => ({
      risk_id: entry.riskId,
      quota: entry.quota,
      rate_limit: { max: entry.rateLimit, window_seconds: entry.rateWindowSeconds },
      gate: entry.gate,
      remaining: serving ? (serving.remaining[entry.riskId] ?? null) : null,
    })),
    exhausted: serving ? serving.exhausted : [],
  };
}

export interface MissionDetailView extends MissionView {
  readonly connections: readonly {
    readonly connection_id: string;
    readonly provider: string;
    readonly display_name: string;
    readonly status: string;
    /** `connection`: issued whole, resources discovered later are reached too. */
    readonly resource_scope: 'selected' | 'connection';
    /**
     * The resources the mission reaches now: the ones selected at issuance that still
     * exist, or, for `connection`, every resource discovery returns that is not hidden.
     */
    readonly resources: readonly { readonly ref: string; readonly env: string | null }[];
  }[];
  /** Risk labels, and until when a gated risk was opened by the creator for the period. */
  readonly policy_details: readonly {
    readonly risk_id: RiskId;
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
      resource_scope: c.reaches_later ? 'connection' : 'selected',
      resources: c.resources.map((r) => ({ ref: r.ref, env: r.env })),
    })),
    policy_details: detail.policy.map((entry) => ({
      risk_id: entry.risk_id,
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
    /** `connection`: resources discovered later are reached too; `resources` are the ones known now. */
    readonly resource_scope: 'selected' | 'connection';
    readonly resources: readonly { readonly ref: string; readonly env: string | null }[];
    readonly preset: { readonly id: string; readonly label: string } | null;
    readonly passes: MissionPreview['policy'];
    readonly exceeds: readonly RiskId[];
    readonly unknown: readonly RiskId[];
    readonly unresolvable: MissionPreview['connections'][number]['unresolvable'];
    readonly missing_budget: readonly RiskId[];
    readonly skipped_from_preset: MissionPreview['connections'][number]['skipped_from_preset'];
  }[];
  readonly period: DraftPeriod;
  readonly expires_at: string | null;
  /** Three lines: what the mission can do, cannot do, in what quantity. */
  readonly summary: MissionPreview['summary'];
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
      resource_scope: c.reaches_later ? 'connection' : 'selected',
      resources: c.resources.map((r) => ({ ref: r.ref, env: r.env })),
      preset: c.preset,
      passes: c.passes,
      exceeds: c.exceeds,
      unknown: c.unknown,
      unresolvable: c.unresolvable,
      missing_budget: c.missing_budget,
      skipped_from_preset: c.skipped_from_preset,
    })),
    period: preview.period,
    expires_at: preview.expires_at,
    summary: preview.summary,
  };
}
