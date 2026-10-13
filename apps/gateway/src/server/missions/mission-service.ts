/**
 * `MissionService` — preview, issue, duplicate, rotate, revoke (spec §3.1,
 * §3.2, §7.4, §7.8; pivot ADR D4).
 *
 * Reads connections and resources through the store repositories only, asks
 * the `AuthorityService` what the creator may accept, and leaves the decision
 * to the pure `previewDraft`. A mission is persisted as an explicit
 * enumeration: explicit resource ids (even for "all"), explicit policy
 * entries (never a preset reference), one token whose secret is returned
 * once.
 *
 * One rule for what a mission reaches on a connection, shared with the
 * execution door (`execution/mission-context.ts`): exactly the resource ids
 * stored at issuance that discovery still returns. Scope `all` with an empty
 * list means "none known at issuance", never "everything discovered later";
 * the detail page and the bootstrap kit read it the same way.
 *
 * Store records are translated by `budget/mapping.ts` and
 * `connections/mapping.ts` only; no record is written into an audit payload.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import { parseRiskId, type MissionPolicyEntry, type SessionEventDetails } from '@vaubaan/shared';

import type { AuthorityService, AuthoritySubject } from '../authority';
import {
  budgetMissionOf,
  isStale,
  missionUsageReader,
  policyEntryOf,
  policyEntryRecordOf,
  statedPeriodOf,
  type MissionState,
  type SessionService,
} from '../budget';
import { connectionSummaryOf } from '../connections/mapping';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { toIso, type Clock } from '../store/clock';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  MissionConnection as MissionConnectionRecord,
  MissionRecord,
  MissionTokenRecord,
} from '../store/types';
import { buildBootstrapKit, type BootstrapKit, type KitPolicyLine } from './bootstrap-kit';
import { enumerateCatalog } from './catalog-view';
import type {
  CatalogRisk,
  DraftConnection,
  DraftPeriod,
  IssuanceConnection,
  IssuanceResource,
  MissionDraft,
  MissionPreview,
  ResolvedDraftConnection,
  SeverityLevel,
} from './model';
import { previewDraft } from './preview';
import { bearerMatches, mintMissionToken, prefixOfBearer, type TokenMinter } from './token';

const MAX_MINT_ATTEMPTS = 5;
const COPY_SUFFIX = ' (copy)';

export interface MissionServiceDeps {
  readonly store: Pick<Store, 'missions' | 'connections' | 'sessions' | 'auditWriter'>;
  readonly registry: PluginRegistry;
  readonly authority: AuthorityService;
  /** `InstanceConfig.publicUrl` — the instance URL of the bootstrap kit. */
  readonly publicUrl: URL;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Tests inject a deterministic minter; production hashes with argon2id. */
  readonly mint?: TokenMinter;
  /**
   * The budget's "load counters, derive state" read (`SessionService.stateOf`).
   * Defaults to the same read over `store.sessions`, for a module wired before
   * the `SessionService` exists.
   */
  readonly budget?: Pick<SessionService, 'stateOf'>;
}

/** Set when the act comes through the management door (P2.4). */
export interface IssueOptions {
  readonly delegation?: { readonly id: string; readonly clientId: string };
}

export interface RevealedToken {
  /** The Bearer. This is the only time it exists outside the caller's hands. */
  readonly secret: string;
  readonly prefix: string;
}

export type IssueResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      readonly token: RevealedToken;
      readonly kit: BootstrapKit;
      readonly preview: MissionPreview;
    }
  | { readonly ok: false; readonly reason: 'refused'; readonly preview: MissionPreview }
  | { readonly ok: false; readonly reason: 'not-found' };

export type RotateResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      readonly token: RevealedToken;
      readonly kit: BootstrapKit;
    }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'inactive'; readonly state: MissionState['kind'] };

export type RevokeResult =
  | { readonly ok: true; readonly mission: MissionRecord; readonly tokensRevoked: number }
  | { readonly ok: false; readonly reason: 'not-found' };

/** The public part of a verified token: what the execution door needs, never the hash. */
export type VerifiedToken = Pick<MissionTokenRecord, 'id' | 'prefix'>;

/**
 * A presented Bearer, resolved. `retired` still names the mission: the
 * execution door answers `mission-inactive` for a revoked mission and a plain
 * authentication failure for a token replaced by rotation.
 */
export type TokenVerification =
  | {
      readonly outcome: 'verified';
      readonly mission: MissionRecord;
      readonly token: VerifiedToken;
    }
  | {
      readonly outcome: 'retired';
      readonly reason: 'rotated' | 'revoked';
      readonly mission: MissionRecord;
      readonly token: VerifiedToken;
    }
  | { readonly outcome: 'unknown' };

export interface MissionOverview {
  readonly mission: MissionRecord;
  readonly state: MissionState;
  /** The active token's public part; `null` once revoked. */
  readonly token: { readonly prefix: string; readonly createdAt: string } | null;
}

export interface MissionDetailConnection {
  readonly id: string;
  readonly provider: string;
  readonly provider_label: string;
  readonly display_name: string;
  readonly status: string;
  readonly resources: readonly IssuanceResource[];
}

export interface MissionDetailRisk extends MissionPolicyEntry {
  readonly label: string;
  readonly level: SeverityLevel | null;
  /** Remaining actions this period; `null` when the mission is not active. */
  readonly remaining: number | null;
}

export interface MissionDetail extends MissionOverview {
  readonly connections: readonly MissionDetailConnection[];
  readonly policy: readonly MissionDetailRisk[];
  readonly period: DraftPeriod;
  /** The kit with the masked prefix; `null` when no token is active. */
  readonly kit: BootstrapKit | null;
}

function toIssuanceResource(r: ConnectionResourceRecord): IssuanceResource {
  return {
    id: r.id,
    ref: r.ref,
    display_name: r.displayName,
    env: r.env,
    hidden: r.hidden,
    stale: isStale(r),
  };
}

/**
 * What a mission stores per connection. Every selection is an explicit list
 * of ids; a connection on which nothing resolved (no resource known, or every
 * resource hidden) stores scope `all` with an empty list, because the store
 * requires a non-empty list for `selected`. Readers treat that row as "none".
 */
function selectionRecordOf(resolved: ResolvedDraftConnection): MissionConnectionRecord {
  const resourceIds = resolved.resources.resource_ids;
  return {
    connectionId: resolved.connection_id,
    resourceScope: resourceIds.length > 0 ? 'selected' : 'all',
    resourceIds,
  };
}

/**
 * The `after` payload of the immutable `mission-issued` audit entry: snake_case
 * domain shapes only, built field by field so a rename in the store's types
 * never changes what the audit keeps.
 */
export interface MissionIssuedAudit {
  readonly [key: string]: unknown;
  readonly name: string;
  readonly connections: readonly {
    readonly connection_id: string;
    readonly resource_ids: readonly string[];
  }[];
  readonly policy: readonly MissionPolicyEntry[];
  readonly period: DraftPeriod;
  readonly expires_at: string | null;
  readonly token_prefix: string;
}

function issuedAuditOf(mission: MissionRecord, tokenPrefix: string): MissionIssuedAudit {
  return {
    name: mission.name,
    connections: mission.connections.map((c) => ({
      connection_id: c.connectionId,
      resource_ids: [...c.resourceIds],
    })),
    policy: mission.policy.map(policyEntryOf),
    period: statedPeriodOf(mission),
    expires_at: mission.expiresAt,
    token_prefix: tokenPrefix,
  };
}

export class MissionService {
  private readonly mint: TokenMinter;
  /** Catalog rows per provider. The catalogs are immutable for the life of the registry. */
  private readonly catalogRows = new Map<string, readonly CatalogRisk[]>();

  private readonly budget: Pick<SessionService, 'stateOf'>;

  constructor(private readonly deps: MissionServiceDeps) {
    this.mint = deps.mint ?? mintMissionToken;
    this.budget = deps.budget ?? missionUsageReader(deps.store.sessions);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issuance context and preview
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The connections the user may build a mission from: every non-revoked
   * connection on which they hold a non-empty authority, with its resources,
   * its catalog as explicit ids and its plugin's presets.
   */
  async issuanceContext(user: AuthoritySubject): Promise<IssuanceConnection[]> {
    const candidates = await this.deps.authority.connectionsOf(user);
    const context: IssuanceConnection[] = [];
    for (const connection of candidates) {
      if (connection.status === 'revoked') continue;
      const built = await this.issuanceConnection(user, connection);
      if (built) context.push(built);
    }
    return context;
  }

  private async issuanceConnection(
    user: AuthoritySubject,
    connection: ConnectionRecord,
  ): Promise<IssuanceConnection | null> {
    const registered = this.deps.registry.get(connection.provider);
    if (!registered) return null;
    const authority = await this.deps.authority.authorityOf(user, connection);
    if (authority.riskIds.length === 0) return null;
    const resources = await this.deps.store.connections.listResources(connection.id);
    const { plugin } = registered;
    return {
      ...connectionSummaryOf(connection),
      provider_label: plugin.displayName,
      experimental: plugin.experimental === true,
      derives_env: typeof plugin.envOf === 'function',
      resources: resources.map(toIssuanceResource),
      risks: this.risksOf(connection.provider),
      authority: authority.riskIds,
      presets: this.deps.registry.presetsOf(connection.provider),
    };
  }

  private risksOf(provider: string): readonly CatalogRisk[] {
    const cached = this.catalogRows.get(provider);
    if (cached) return cached;
    const registered = this.deps.registry.get(provider);
    const rows = registered ? enumerateCatalog(registered.plugin.catalog) : [];
    this.catalogRows.set(provider, rows);
    return rows;
  }

  /** What passes, what exceeds the authority, what becomes callable. Writes nothing. */
  async preview(user: AuthoritySubject, draft: MissionDraft): Promise<MissionPreview> {
    const connections = await this.issuanceContext(user);
    return previewDraft({ connections, now: this.deps.clock.now() }, draft);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Issue, duplicate
  // ───────────────────────────────────────────────────────────────────────────

  async issue(
    user: AuthoritySubject,
    draft: MissionDraft,
    options: IssueOptions = {},
  ): Promise<IssueResult> {
    const context = await this.issuanceContext(user);
    const preview = previewDraft({ connections: context, now: this.deps.clock.now() }, draft);
    if (!preview.ok) return { ok: false, reason: 'refused', preview };

    const mission = await this.deps.store.missions.create({
      name: preview.name,
      creatorUserId: user.id,
      periodSeconds: draft.period.kind === 'recurring' ? draft.period.length_seconds : null,
      expiresAt: draft.expires_at === null ? null : new Date(draft.expires_at).toISOString(),
      delegationId: options.delegation?.id ?? null,
      connections: preview.resolved.map(selectionRecordOf),
      policy: preview.policy.map(policyEntryRecordOf),
    });
    const token = await this.issueToken(mission.id);

    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-issued',
      object: { type: 'mission', id: mission.id },
      before: null,
      after: issuedAuditOf(mission, token.prefix),
      delegated_client_id: options.delegation?.clientId ?? null,
    });
    this.deps.logger.info('mission issued', {
      mission_id: mission.id,
      creator_id: user.id,
      connections: mission.connections.length,
      risks: mission.policy.length,
      token_prefix: token.prefix,
    });

    return {
      ok: true,
      mission,
      token,
      kit: await this.kitFor(mission, { secret: token.secret }),
      preview,
    };
  }

  /**
   * The draft that re-issues an existing mission of the user: same
   * connections, resources still present, same explicit policy, same period;
   * no expiry carried over (a past date would refuse the copy). `null` when
   * the mission is not theirs.
   *
   * A source that stored no resource on a connection (scope `all`, empty
   * list) is drafted as `{ scope: 'all' }`: the copy is a new issuance and
   * resolves "all" against the resources known when it is issued. The source
   * itself keeps reaching none.
   */
  async draftFrom(user: AuthoritySubject, missionId: string): Promise<MissionDraft | null> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return null;
    const connections: DraftConnection[] = [];
    for (const c of mission.connections) {
      const connection = await this.deps.store.connections.getById(c.connectionId);
      if (!connection) continue;
      const provider = connection.provider;
      connections.push({
        connection_id: c.connectionId,
        resources:
          c.resourceScope === 'all'
            ? { scope: 'all' }
            : { scope: 'selected', resource_ids: await this.survivingResources(c) },
        preset: null,
        policy: mission.policy
          .map(policyEntryOf)
          .filter((entry) => parseRiskId(entry.risk_id)?.provider === provider),
      });
    }
    return {
      name: `${mission.name}${COPY_SUFFIX}`,
      connections,
      period: statedPeriodOf(mission),
      expires_at: null,
    };
  }

  private async survivingResources(c: MissionConnectionRecord): Promise<string[]> {
    const current = await this.deps.store.connections.listResources(c.connectionId);
    // A stale resource would refuse the copy: it is dropped like a vanished one.
    const known = new Set(current.filter((r) => !isStale(r)).map((r) => r.id));
    return c.resourceIds.filter((id) => known.has(id));
  }

  /**
   * "Duplicate mission": re-issues the source's draft under the creator's
   * *current* authority (a risk they no longer hold refuses the copy) and
   * returns a new mission with its own token and its own budget.
   */
  async duplicate(
    user: AuthoritySubject,
    missionId: string,
    overrides: Partial<Pick<MissionDraft, 'name' | 'period' | 'expires_at'>> = {},
    options: IssueOptions = {},
  ): Promise<IssueResult> {
    const draft = await this.draftFrom(user, missionId);
    if (!draft) return { ok: false, reason: 'not-found' };
    return this.issue(user, { ...draft, ...overrides }, options);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Token: mint, rotate, revoke, verify
  // ───────────────────────────────────────────────────────────────────────────

  /** Mints and stores a token; the previously active one, if any, becomes `rotated`. */
  private async issueToken(missionId: string): Promise<RevealedToken> {
    for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
      const minted = await this.mint();
      // The prefix is the lookup key (unique column): a collision is re-drawn, never overwritten.
      if (await this.deps.store.missions.findTokenByPrefix(minted.prefix)) continue;
      await this.deps.store.missions.issueToken({
        missionId,
        prefix: minted.prefix,
        hash: minted.hash,
        hashAlg: minted.hashAlg,
      });
      return { secret: minted.secret, prefix: minted.prefix };
    }
    throw new Error(`could not draw an unused token prefix in ${MAX_MINT_ATTEMPTS} attempts`);
  }

  /** New token, same mission, same session, same budget (spec §7.8). */
  async rotate(user: AuthoritySubject, missionId: string): Promise<RotateResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    const state = await this.stateOf(mission);
    if (state.kind !== 'active') return { ok: false, reason: 'inactive', state: state.kind };

    const previous = await this.activeToken(mission.id);
    const token = await this.issueToken(mission.id);
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-rotated',
      object: { type: 'mission', id: mission.id },
      before: previous ? { token_prefix: previous.prefix } : null,
      after: { token_prefix: token.prefix },
      delegated_client_id: null,
    });
    await this.recordEvent(mission.id, user.id, {
      kind: 'rotation',
      details: { token_prefix: token.prefix },
    });
    this.deps.logger.info('mission token rotated', {
      mission_id: mission.id,
      token_prefix: token.prefix,
    });
    return { ok: true, mission, token, kit: await this.kitFor(mission, { secret: token.secret }) };
  }

  /** The mission refuses everything from now on; its tokens are revoked. Idempotent. */
  async revoke(user: AuthoritySubject, missionId: string): Promise<RevokeResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (mission.status === 'revoked') return { ok: true, mission, tokensRevoked: 0 };

    const revoked = await this.deps.store.missions.setStatus(mission.id, 'revoked');
    const tokensRevoked = await this.deps.store.missions.revokeTokens(mission.id);
    await this.deps.store.auditWriter.write({
      kind: 'admin',
      ts: toIso(this.deps.clock.now()),
      user_id: user.id,
      act: 'mission-revoked',
      object: { type: 'mission', id: mission.id },
      before: { status: mission.status },
      after: { status: revoked.status, tokens_revoked: tokensRevoked },
      delegated_client_id: null,
    });
    await this.recordEvent(mission.id, user.id, {
      kind: 'revocation',
      details: { tokens_revoked: tokensRevoked },
    });
    this.deps.logger.info('mission revoked', { mission_id: mission.id });
    return { ok: true, mission: revoked, tokensRevoked };
  }

  /** Session events exist only once the session does (born on the first call). */
  private async recordEvent(
    missionId: string,
    actorUserId: string,
    event: Extract<SessionEventDetails, { kind: 'rotation' | 'revocation' }>,
  ): Promise<void> {
    const session = await this.deps.store.sessions.getByMission(missionId);
    if (!session) return;
    await this.deps.store.sessions.recordEvent(session.id, { ...event, actorUserId });
  }

  /**
   * Resolves a presented Bearer: prefix lookup, then the argon2id check. A
   * malformed Bearer, an unknown prefix and a wrong secret are the same
   * answer (`unknown`).
   */
  async verifyToken(bearer: string): Promise<TokenVerification> {
    const prefix = prefixOfBearer(bearer);
    if (!prefix) return { outcome: 'unknown' };
    const found = await this.deps.store.missions.findTokenByPrefix(prefix);
    if (!found) return { outcome: 'unknown' };
    if (!(await bearerMatches(found.token.hash, bearer))) return { outcome: 'unknown' };
    const { mission } = found;
    // The record (and its hash) stops here: the door gets the id and the prefix.
    const token: VerifiedToken = { id: found.token.id, prefix: found.token.prefix };
    if (found.token.status === 'active') return { outcome: 'verified', mission, token };
    return { outcome: 'retired', reason: found.token.status, mission, token };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reads for the Missions pages
  // ───────────────────────────────────────────────────────────────────────────

  async list(user: AuthoritySubject): Promise<MissionOverview[]> {
    const missions = await this.deps.store.missions.listForCreator(user.id);
    const overviews: MissionOverview[] = [];
    for (const mission of missions) overviews.push(await this.overviewOf(mission));
    // Newest first: the mission just issued is the one the creator looks for.
    return overviews.reverse();
  }

  async get(user: AuthoritySubject, missionId: string): Promise<MissionDetail | null> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return null;
    const overview = await this.overviewOf(mission);
    const connections = await this.detailConnections(mission);
    const remaining = overview.state.kind === 'active' ? overview.state.remaining : null;
    const rows = this.catalogRowsOf(connections);
    const policy: MissionDetailRisk[] = mission.policy.map(policyEntryOf).map((entry) => {
      const row = rows.get(entry.risk_id);
      return {
        ...entry,
        label: row?.label ?? entry.risk_id,
        level: row?.level ?? null,
        remaining: remaining ? (remaining[entry.risk_id] ?? null) : null,
      };
    });
    return {
      ...overview,
      connections,
      policy,
      period: statedPeriodOf(mission),
      kit: overview.token
        ? await this.kitFor(mission, { prefix: overview.token.prefix }, connections)
        : null,
    };
  }

  private async overviewOf(mission: MissionRecord): Promise<MissionOverview> {
    const token = await this.activeToken(mission.id);
    return {
      mission,
      state: await this.stateOf(mission),
      token: token ? { prefix: token.prefix, createdAt: token.createdAt } : null,
    };
  }

  private stateOf(mission: MissionRecord): Promise<MissionState> {
    return this.budget.stateOf(budgetMissionOf(mission), this.deps.clock.now());
  }

  private async activeToken(missionId: string): Promise<MissionTokenRecord | null> {
    const tokens = await this.deps.store.missions.listTokens(missionId);
    return tokens.find((t) => t.status === 'active') ?? null;
  }

  /** One answer for "does not exist" and "not yours". */
  private async ownMission(
    user: AuthoritySubject,
    missionId: string,
  ): Promise<MissionRecord | null> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission || mission.creatorUserId !== user.id) return null;
    return mission;
  }

  /**
   * The connections of a mission with the resources it reaches — the same rule
   * as `loadMissionContext`: only the ids stored at issuance, never the
   * connection's live list, and not the ones discovery no longer returns.
   */
  private async detailConnections(mission: MissionRecord): Promise<MissionDetailConnection[]> {
    const details: MissionDetailConnection[] = [];
    for (const c of mission.connections) {
      const connection = await this.deps.store.connections.getById(c.connectionId);
      if (!connection) continue;
      const selected = new Set(c.resourceIds);
      const reached =
        selected.size === 0
          ? []
          : (await this.deps.store.connections.listResources(c.connectionId)).filter(
              (r) => selected.has(r.id) && !isStale(r),
            );
      details.push({
        ...connectionSummaryOf(connection),
        provider_label:
          this.deps.registry.get(connection.provider)?.plugin.displayName ?? connection.provider,
        resources: reached.map(toIssuanceResource),
      });
    }
    return details;
  }

  private catalogRowsOf(
    connections: readonly Pick<MissionDetailConnection, 'provider'>[],
  ): Map<string, CatalogRisk> {
    return new Map(
      connections.flatMap((c) => this.risksOf(c.provider).map((r) => [r.risk_id, r] as const)),
    );
  }

  private async kitFor(
    mission: MissionRecord,
    token: { secret: string } | { prefix: string },
    known?: readonly MissionDetailConnection[],
  ): Promise<BootstrapKit> {
    const connections = known ?? (await this.detailConnections(mission));
    const rows = this.catalogRowsOf(connections);
    const policy: KitPolicyLine[] = mission.policy.map(policyEntryOf).map((entry) => ({
      ...entry,
      label: rows.get(entry.risk_id)?.label ?? entry.risk_id,
    }));
    return buildBootstrapKit({
      instanceUrl: this.deps.publicUrl.href,
      mission: {
        name: mission.name,
        period: statedPeriodOf(mission),
        expires_at: mission.expiresAt,
      },
      connections: connections.map((c) => ({
        provider_label: c.provider_label,
        display_name: c.display_name,
        resources: c.resources.map((r) => ({ ref: r.ref, env: r.env })),
      })),
      policy,
      token,
    });
  }
}
