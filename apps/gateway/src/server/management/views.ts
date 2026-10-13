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
 */
import type { Gate, Preset, RiskId } from '@vaubaan/shared';

import type {
  DraftPeriod,
  IssuanceConnection,
  MissionDetail,
  MissionIssuer,
  MissionOverview,
  MissionPreview,
} from '../missions';
import type { ProviderCatalog } from './ports';

// ─────────────────────────────────────────────────────────────────────────────
// Connections
// ─────────────────────────────────────────────────────────────────────────────

export interface ResourceView {
  readonly ref: string;
  readonly display_name: string;
  /** The environment label the owner gave it; `null` when unlabelled. */
  readonly env: string | null;
  /** Hidden by the owner: left out of `{ scope: 'all' }`, still selectable by ref. */
  readonly hidden: boolean;
}

export interface EnvUsabilityView {
  /** The provider reads the environment from the call itself: no label is needed. */
  readonly derives_env: boolean;
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
  /** True when every entry of the preset is inside the user's authority here. */
  readonly within_authority: boolean;
  /** The preset entries the user's authority does not cover on this connection. */
  readonly outside_authority: readonly RiskId[];
}

export interface ConnectionView {
  readonly connection_id: string;
  readonly provider: string;
  readonly provider_label: string;
  readonly display_name: string;
  /** `active`, or `expired`: missions on it fail until an owner reconnects it. */
  readonly status: string;
  readonly experimental: boolean;
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

function presetSummary(preset: Preset, connection: IssuanceConnection): PresetSummaryView {
  const held = new Set(connection.authority);
  // A preset entry may name the base id of an env-scoped risk: it is covered
  // when at least one of its environment rows is held.
  const outside = preset.entries
    .map((entry) => entry.risk_id)
    .filter(
      (id) =>
        !connection.risks.some(
          (risk) => (risk.risk_id === id || risk.base_id === id) && held.has(risk.risk_id),
        ),
    );
  return {
    id: preset.id,
    label: preset.label,
    description: preset.description,
    risks: preset.entries.length,
    within_authority: outside.length === 0,
    outside_authority: outside,
  };
}

function envUsability(connection: IssuanceConnection): EnvUsabilityView {
  const resources = connection.resources.filter((r) => !r.stale);
  const labelled = [...new Set(resources.flatMap((r) => (r.env === null ? [] : [r.env])))];
  const held = new Set(connection.authority);
  const envQualified = connection.risks.filter((r) => r.env !== null && held.has(r.risk_id));
  const reachable = (env: string | null): boolean =>
    connection.derives_env || (env !== null && labelled.includes(env));
  return {
    derives_env: connection.derives_env,
    labelled_envs: labelled,
    unlabelled_resources: resources.filter((r) => r.env === null).map((r) => r.ref),
    usable_risk_ids: envQualified.filter((r) => reachable(r.env)).map((r) => r.risk_id),
    unusable_risk_ids: envQualified.filter((r) => !reachable(r.env)).map((r) => r.risk_id),
  };
}

export function connectionView(connection: IssuanceConnection): ConnectionView {
  return {
    connection_id: connection.id,
    provider: connection.provider,
    provider_label: connection.provider_label,
    display_name: connection.display_name,
    status: connection.status,
    experimental: connection.experimental,
    authority: {
      basis: connection.basis,
      risk_ids: connection.authority,
      whole_catalog: connection.authority.length === connection.risks.length,
    },
    resources: connection.resources
      .filter((r) => !r.stale)
      .map((r) => ({ ref: r.ref, display_name: r.display_name, env: r.env, hidden: r.hidden })),
    env_qualified_risks: envUsability(connection),
    presets: connection.presets.map((preset) => presetSummary(preset, connection)),
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
  readonly experimental: boolean;
  readonly derives_env: boolean;
  /** The connection the `in_my_authority` flags are about; `null` when none was named. */
  readonly connection_id: string | null;
  readonly risks: readonly CatalogRiskView[];
  readonly presets: readonly Preset[];
}

export function catalogView(
  catalog: ProviderCatalog,
  connection: IssuanceConnection | null,
): CatalogView {
  const held = connection ? new Set(connection.authority) : null;
  return {
    provider: catalog.provider,
    provider_label: catalog.provider_label,
    experimental: catalog.experimental,
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
    presets: catalog.presets,
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
    can_come_back: orphan.cause !== 'connection-revoked' && orphan.cause !== 'connection-missing',
  };
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
}

export interface MissionView {
  readonly mission_id: string;
  readonly name: string;
  readonly state: MissionStateName;
  /** Set while the mission is orphaned: every call is refused until the authority returns. */
  readonly orphan: OrphanView | null;
  readonly created_at: string;
  readonly expires_at: string | null;
  readonly period: DraftPeriod;
  /** The current period of the session; `end` is `null` for a one-off mission. */
  readonly session: { readonly period_start: string; readonly period_end: string | null } | null;
  /** `null` when the user issued it themselves in the interface. */
  readonly issued_via: IssuedViaView | null;
  /** Masked prefix of the active token; the secret is never shown again. */
  readonly token_prefix: string | null;
  readonly connection_ids: readonly string[];
  readonly policy: readonly MissionPolicyView[];
  /** Accepted risks whose quota is spent for the period: calls on them are refused with a claim URL. */
  readonly exhausted: readonly RiskId[];
}

function issuedViaView(issuer: MissionIssuer | null, clientId: string): IssuedViaView | null {
  if (!issuer) return null;
  return {
    client_id: issuer.client_id,
    client_name: issuer.client_name,
    this_client: issuer.client_id === clientId,
  };
}

export function missionView(
  overview: MissionOverview,
  clientId: string,
  maskToken: (prefix: string) => string,
): MissionView {
  const { mission, state } = overview;
  const serving = state.kind === 'active' ? state : null;
  return {
    mission_id: mission.id,
    name: mission.name,
    state: state.kind,
    orphan: overview.orphan ? orphanView(overview.orphan) : null,
    created_at: mission.createdAt,
    expires_at: mission.expiresAt,
    period:
      mission.periodSeconds === null
        ? { kind: 'one-off' }
        : { kind: 'recurring', length_seconds: mission.periodSeconds },
    session: serving
      ? { period_start: serving.period.start, period_end: serving.period.end }
      : null,
    issued_via: issuedViaView(overview.issuedVia, clientId),
    token_prefix: overview.token ? maskToken(overview.token.prefix) : null,
    connection_ids: mission.connections.map((c) => c.connectionId),
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
    /** The resources the mission reaches: the ones selected at issuance that still exist. */
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
  clientId: string,
  maskToken: (prefix: string) => string,
): MissionDetailView {
  return {
    ...missionView(detail, clientId, maskToken),
    connections: detail.connections.map((c) => ({
      connection_id: c.id,
      provider: c.provider,
      display_name: c.display_name,
      status: c.status,
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
