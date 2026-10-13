/**
 * `MissionService` — preview, issue, duplicate, rotate, revoke, and the gate
 * of a risk edited after issuance (spec §3.1, §3.2, §3.5, §7.4, §7.8; pivot
 * ADR D4).
 *
 * Reads connections and resources through the store repositories only, asks
 * the `AuthorityService` what the creator may accept, and leaves the decision
 * to the pure `previewDraft`. A mission is persisted as an explicit
 * enumeration: explicit resource ids (even for "all"), explicit policy
 * entries (never a preset reference), and the creator's own token, whose
 * secret is returned once. Members and the other tokens of a mission are the
 * `MissionTeamService`'s (`team-service.ts`); this service says who may read a
 * mission (`access`) and what a presented token is worth (`verifyToken`).
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
import type { TokenHolder } from '@vaubaan/gateway-core';
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import {
  isGate,
  parseRiskId,
  type Gate,
  type Iso8601,
  type MissionPolicyEntry,
  type RiskId,
  type SessionEventDetails,
} from '@vaubaan/shared';

import type {
  AuthorityService,
  AuthoritySubject,
  InspectedMission,
  MissionGrounds,
  OrphanCause,
} from '../authority';
import {
  budgetMissionOf,
  currentPeriod,
  GATE_EVENT_KINDS,
  isStale,
  missionUsageReader,
  openedGatesOf,
  policyEntryOf,
  policyEntryRecordOf,
  statedPeriodOf,
  type CurrentPeriod,
  type MissionState,
  type SessionService,
} from '../budget';
import { connectionSummaryOf } from '../connections/mapping';
import type { Logger } from '../logging';
import type { Store } from '../store';
import { TokenNotIssuableError } from '../store/errors';
import { isOnMission, membershipOf, type Membership } from '../store/membership';
import { toIso, type Clock } from '../store/clock';
import type {
  ConnectionRecord,
  ConnectionResourceRecord,
  MissionConnection as MissionConnectionRecord,
  MissionRecord,
  MissionTokenRecord,
  UserRecord,
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
  MissionIssuer,
  MissionPreview,
  ResolvedDraftConnection,
  SeverityLevel,
} from './model';
import { previewDraft } from './preview';
import {
  bearerMatches,
  digestOfBearer,
  isLegacyTokenHash,
  mintMissionToken,
  prefixOfBearer,
  type TokenMinter,
} from './token';
import { reissueMemberToken } from './member-token';
import { issueTokenTo, type IssuedSecret } from './token-issuer';

const COPY_SUFFIX = ' (copy)';

export interface MissionServiceDeps {
  readonly store: Pick<Store, 'missions' | 'connections' | 'sessions' | 'users' | 'auditWriter'>;
  readonly registry: PluginRegistry;
  readonly authority: AuthorityService;
  /**
   * `orphaned` is derived, never stored (spec §2.3): every mission this service
   * loads is read through `grounds.inspect`, so the pages, the gate edit, the
   * rotation and the session view all see the state of this instant.
   */
  readonly grounds: Pick<MissionGrounds, 'inspect'>;
  /** `InstanceConfig.publicUrl` — the instance URL of the bootstrap kit. */
  readonly publicUrl: URL;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Tests inject a deterministic minter; production stores the SHA-256 digest. */
  readonly mint?: TokenMinter;
  /**
   * The budget's "load counters, derive state" read (`SessionService.stateOf`).
   * Defaults to the same read over `store.sessions`, for a module wired before
   * the `SessionService` exists.
   */
  readonly budget?: Pick<SessionService, 'stateOf'>;
}

/**
 * Set when the act comes through the management door (spec §4.1 bis): the
 * delegation the agent acts under. The user stays the actor and, for an
 * issuance, the creator; the mission records the delegation (`issued_via`) and
 * the audit entry names the client (`delegated_client_id`, spec §8).
 */
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
  /** A delegated client asked for a mission its delegation did not issue. */
  | { readonly ok: false; readonly reason: 'not-issued-by-delegation' }
  | { readonly ok: false; readonly reason: 'inactive'; readonly state: MissionState['kind'] };

export type RevokeResult =
  | { readonly ok: true; readonly mission: MissionRecord; readonly tokensRevoked: number }
  | { readonly ok: false; readonly reason: 'not-found' };

/** An orphaned mission as an owner of one of its connections reads it. */
export interface OrphanedOnConnection {
  readonly id: string;
  readonly name: string;
  /** Who issued it: the only other person who can close it. */
  readonly creator_label: string;
  readonly cause: OrphanCause;
}

/**
 * A mission as an owner of one of its connections reads it on the page of that
 * connection ("Missions using this account"). An owner already reads the audit
 * entries of their connection, mission names included (spec §8); this is the same
 * disclosure as a list. Nothing of another connection of the mission is in it.
 */
export interface MissionOnConnection {
  readonly id: string;
  readonly name: string;
  /** Who issued it; `label` is the email, or "unknown user" when the row is gone. */
  readonly creator: { readonly id: string; readonly label: string };
  /** Derived now, like every reading of a mission's state. */
  readonly state: MissionState['kind'];
  /** Accepted risks whose quota is spent for the current period; `0` unless `active`. */
  readonly exhausted: number;
  readonly expires_at: Iso8601 | null;
  /** Why it reads `orphaned`; `null` otherwise. */
  readonly orphan_cause: OrphanCause | null;
  /** The resources of THIS connection the mission was issued on: explicit ids. */
  readonly resource_ids: readonly string[];
  /** Accepted risks that belong to this connection's provider. */
  readonly permissions: number;
  /** How many of them wait for the creator's approval. */
  readonly asks_first: number;
  /** Whether the reader may open the mission's own page: its creator, a current member. */
  readonly readable: boolean;
  readonly created_at: Iso8601;
}

/** Who may close a mission, and on what ground (spec §2.3). */
type Closer =
  | { readonly as: 'creator' }
  | { readonly as: 'connection-owner'; readonly connectionId: string };

export type SetGateResult =
  | {
      readonly ok: true;
      readonly mission: MissionRecord;
      readonly risk_id: RiskId;
      readonly gate: Gate;
      /** The gate before the edit; equal to `gate` when the stored gate did not move. */
      readonly previous: Gate;
      /**
       * `approval` was asked on a risk already gated whose gate the creator had
       * opened for the period: the opening is over (the stored gate did not move).
       */
      readonly opening_closed: boolean;
    }
  | { readonly ok: false; readonly reason: 'not-found' }
  | { readonly ok: false; readonly reason: 'invalid-gate' }
  | { readonly ok: false; readonly reason: 'risk-not-in-policy' }
  | {
      readonly ok: false;
      readonly reason: 'inactive';
      readonly state: 'revoked' | 'orphaned';
    };

/**
 * The public part of a verified token: what the execution door needs — the row,
 * the prefix and who it belongs to — never the hash.
 */
export interface VerifiedToken {
  readonly id: string;
  readonly prefix: string;
  readonly holder: TokenHolder;
}

/**
 * Why a token whose secret matched does not authenticate: `rotated` and
 * `revoked` are the stored status; `holder-removed` and `holder-deactivated`
 * are derived at every verification from the member's row and the user's
 * status, so a member token stops at the very next call (spec §0).
 */
export type TokenRetirement = 'rotated' | 'revoked' | 'holder-removed' | 'holder-deactivated';

/**
 * A presented Bearer, resolved. `retired` still names the mission: the
 * execution door answers `mission-inactive` for a revoked mission and an
 * authentication failure stating the reason for every other retirement.
 */
export type TokenVerification =
  | {
      readonly outcome: 'verified';
      readonly mission: MissionRecord;
      readonly token: VerifiedToken;
    }
  | {
      readonly outcome: 'retired';
      readonly reason: TokenRetirement;
      readonly mission: MissionRecord;
      readonly token: VerifiedToken;
    }
  | { readonly outcome: 'unknown' };

/**
 * Asked before the one slow verification left: the argon2id check of a token
 * stored by an earlier build. The caller owns the limiter and its key.
 */
export type LegacyHashGate = () => Promise<
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number }
>;

/** The gate refused: nothing was computed, the Bearer was not judged. */
export interface LegacyHashThrottled {
  readonly outcome: 'throttled';
  readonly retryAfterMs: number;
}

/** What a user is to a mission they can read (spec §0 "Mission member"). */
export type MissionRole = 'creator' | 'member';

/** A mission as one user may read it: derived state, and their role on it. */
export interface MissionAccess extends InspectedMission {
  readonly role: MissionRole;
}

/** Why a mission reads `orphaned` right now (handbook authority, "Orphaned missions"). */
export interface MissionOrphanReason {
  readonly cause: OrphanCause;
  /** The connection the cause was met on; `null` when the creator is gone. */
  readonly connection_id: string | null;
  /** The accepted risks the creator no longer covers. */
  readonly uncovered: readonly RiskId[];
}

export interface MissionOverview {
  /** `status` is derived: `orphaned` while the creator's authority is missing. */
  readonly mission: MissionRecord;
  /** What the reader is to this mission: its creator, or a member it is shared with. */
  readonly role: MissionRole;
  /** Who created it; `email` is `null` when the user row is gone. */
  readonly creator: { readonly id: string; readonly email: string | null };
  readonly state: MissionState;
  /** Set while the mission is orphaned; `null` as soon as the authority is back. */
  readonly orphan: MissionOrphanReason | null;
  /**
   * The public part of the reader's own active token of this mission; `null`
   * when they have none (a member who has not generated theirs, a revoked token).
   */
  readonly token: { readonly prefix: string; readonly createdAt: string } | null;
  /** The client that issued it by delegation; `null` for a mission issued in the interface. */
  readonly issuedVia: MissionIssuer | null;
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
  /**
   * End of the period the creator opened this risk's gate for (spec §3.5): until then
   * calls pass without asking, although `gate` reads `approval`. `null` otherwise.
   */
  readonly gate_open_until: Iso8601 | null;
}

/**
 * The statuses on which a mission's gates are not edited: the ones from which it does
 * not come back by itself (spec §2.3). `status` is the derived one, so the edit is
 * open again as soon as an orphaned mission's authority is back. An EXPIRED mission is
 * not in the list: its creator can extend the expiry (a claim's `extend-expiry`), and
 * the gates they set meanwhile are the ones it serves with again. `setGate` refuses on
 * it and the mission page reads it from `MissionDetail.gates_editable`.
 */
export function gateEditBlockedBy(
  mission: Pick<MissionRecord, 'status'>,
): 'revoked' | 'orphaned' | null {
  return mission.status === 'revoked' || mission.status === 'orphaned' ? mission.status : null;
}

export interface MissionDetail extends MissionOverview {
  /** Whether `setGate` would take an edit now, from this reader. A member edits nothing. */
  readonly gates_editable: boolean;
  readonly connections: readonly MissionDetailConnection[];
  readonly policy: readonly MissionDetailRisk[];
  readonly period: DraftPeriod;
  /** The kit with the masked prefix; `null` when no token is active. */
  readonly kit: BootstrapKit | null;
}

/** A user who may read the mission: `id`, and nothing else is trusted from the caller. */
type Reader = AuthoritySubject;

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
    if (authority.basis === 'none' || authority.riskIds.length === 0) return null;
    const resources = await this.deps.store.connections.listResources(connection.id);
    const { plugin } = registered;
    return {
      ...connectionSummaryOf(connection),
      provider_label: plugin.displayName,
      experimental: plugin.experimental === true,
      derives_env: typeof plugin.envOf === 'function',
      basis: authority.basis,
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
    // The creator is a member by construction: the mission is born with their own token.
    const token = await this.issueCreatorToken(mission);

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
      delegated_client_id: options.delegation?.clientId ?? null,
    });

    return {
      ok: true,
      mission,
      token: { secret: token.secret, prefix: token.prefix },
      kit: await this.kitOf(mission, { secret: token.secret }),
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

  /**
   * Mints and stores the creator's own member token; their previous active one,
   * if any, becomes `rotated`. The tokens of the other holders are untouched.
   */
  private issueCreatorToken(mission: MissionRecord): Promise<IssuedSecret> {
    return issueTokenTo(
      { missions: this.deps.store.missions, mint: this.mint },
      {
        missionId: mission.id,
        holder: { kind: 'member', userId: mission.creatorUserId },
        createdBy: mission.creatorUserId,
      },
    );
  }

  /**
   * A new token for the creator, same mission, same session, same budget
   * (spec §7.8): the creator's previous token stops working; every other
   * holder's token is untouched. A member rotates their own token through
   * `MissionTeamService.generateToken`, which the creator may use as well.
   *
   * Through a delegation (`options.delegation`, the management door) only a
   * mission that very delegation issued is rotated: the new token is handed to
   * the caller, so rotating a mission the human issued — wider, perhaps with a
   * gate they opened — would hand a delegated client an authority nobody
   * issued to it (ADR management-door-rotation-scope-and-replay-trace). The
   * human rotates any of their missions in the interface.
   */
  async rotate(
    user: AuthoritySubject,
    missionId: string,
    options: IssueOptions = {},
  ): Promise<RotateResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (options.delegation && mission.delegationId !== options.delegation.id) {
      return { ok: false, reason: 'not-issued-by-delegation' };
    }
    const state = await this.stateOf(mission);
    if (state.kind !== 'active') return { ok: false, reason: 'inactive', state: state.kind };

    let token: IssuedSecret;
    try {
      // The one implementation of "a member's own token, issued or replaced"
      // (`member-token.ts`), shared with `MissionTeamService.generateToken`.
      token = await reissueMemberToken(
        { store: this.deps.store, mint: this.mint, clock: this.deps.clock },
        {
          missionId: mission.id,
          userId: user.id,
          delegatedClientId: options.delegation?.clientId ?? null,
        },
      );
    } catch (err) {
      // Revoked while the hash was computed: the store refused the insert.
      if (!(err instanceof TokenNotIssuableError)) throw err;
      return { ok: false, reason: 'inactive', state: await this.stateAfterRefusal(mission.id) };
    }
    this.deps.logger.info('mission token rotated', {
      mission_id: mission.id,
      token_prefix: token.prefix,
      delegated_client_id: options.delegation?.clientId ?? null,
    });
    return {
      ok: true,
      mission,
      token: { secret: token.secret, prefix: token.prefix },
      kit: await this.kitOf(mission, { secret: token.secret }),
    };
  }

  /**
   * The orphaned missions that carry a connection, for someone who owns that
   * connection now (spec §2.3: "the creator, or an owner of the connection, may close
   * it"). Anyone else reads none. Derived at this instant, like every reading of
   * `orphaned`.
   */
  async orphanedOn(user: AuthoritySubject, connectionId: string): Promise<OrphanedOnConnection[]> {
    const connection = await this.deps.store.connections.getById(connectionId);
    if (!connection || !(await this.owns(user, connection))) return [];
    const orphaned: OrphanedOnConnection[] = [];
    for (const mission of await this.deps.store.missions.listForConnection(connectionId)) {
      const { orphan } = await this.deps.grounds.inspect(mission);
      if (!orphan) continue;
      const creator = await this.deps.store.users.getById(mission.creatorUserId);
      orphaned.push({
        id: mission.id,
        name: mission.name,
        creator_label: creator?.email ?? 'unknown user',
        cause: orphan.cause,
      });
    }
    return orphaned;
  }

  /**
   * Every mission that carries a connection, newest first, for someone who owns that
   * connection now. Anyone else reads none, like `orphanedOn`. Read-only: the page of
   * the connection lists them, so that its owner knows what removing an access or
   * disconnecting would stop.
   */
  async onConnection(user: AuthoritySubject, connectionId: string): Promise<MissionOnConnection[]> {
    const connection = await this.deps.store.connections.getById(connectionId);
    if (!connection || !(await this.owns(user, connection))) return [];
    const listed: MissionOnConnection[] = [];
    for (const stored of await this.deps.store.missions.listForConnection(connectionId)) {
      const { mission, orphan } = await this.deps.grounds.inspect(stored);
      const state = await this.stateOf(mission);
      const creator = await this.deps.store.users.getById(mission.creatorUserId);
      const membership = await this.membershipOf(mission, user.id);
      const accepted = mission.policy.filter(
        (entry) => parseRiskId(entry.riskId)?.provider === connection.provider,
      );
      const selection = mission.connections.find((c) => c.connectionId === connectionId);
      listed.push({
        id: mission.id,
        name: mission.name,
        creator: { id: mission.creatorUserId, label: creator?.email ?? 'unknown user' },
        state: state.kind,
        exhausted: state.kind === 'active' ? state.exhausted.length : 0,
        expires_at: mission.expiresAt,
        orphan_cause: orphan?.cause ?? null,
        resource_ids: selection?.resourceIds ?? [],
        permissions: accepted.length,
        asks_first: accepted.filter((entry) => entry.gate === 'approval').length,
        readable: membership === 'creator' || membership === 'member',
        created_at: mission.createdAt,
      });
    }
    return listed.sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    );
  }

  /**
   * The mission refuses everything from now on; every token of every holder is revoked.
   * Idempotent. An orphaned mission is revoked like any other: this is how it is
   * closed for good (the stored status goes `active` → `revoked`).
   *
   * Who may (spec §2.3): the creator, always; and, **only while the mission is
   * orphaned**, an owner of one of its connections — the authority that grounded it is
   * gone, and it would serve again, with the token its agent holds, the day a share is
   * made again. A mission that serves is its creator's alone. A delegated client acts
   * for the creator only.
   */
  async revoke(
    user: AuthoritySubject,
    missionId: string,
    options: IssueOptions = {},
  ): Promise<RevokeResult> {
    const closing = await this.closableBy(user, missionId, options);
    if (!closing) return { ok: false, reason: 'not-found' };
    const { mission, closer } = closing;
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
      after: {
        status: revoked.status,
        tokens_revoked: tokensRevoked,
        // Named only when it is not the creator: the entry says on what ground they acted.
        ...(closer.as === 'connection-owner'
          ? { closed_as: closer.as, connection_id: closer.connectionId }
          : {}),
      },
      delegated_client_id: options.delegation?.clientId ?? null,
    });
    await this.recordEvent(mission.id, user.id, {
      kind: 'revocation',
      details: { tokens_revoked: tokensRevoked },
    });
    this.deps.logger.info('mission revoked', {
      mission_id: mission.id,
      closed_as: closer.as,
      delegated_client_id: options.delegation?.clientId ?? null,
    });
    return { ok: true, mission: revoked, tokensRevoked };
  }

  /**
   * The mission as derived now, when `user` may close it, and on what ground.
   * `null` — "not found" — for everyone else, so that an owner learns nothing about
   * the missions of their connection that serve.
   */
  private async closableBy(
    user: AuthoritySubject,
    missionId: string,
    options: IssueOptions,
  ): Promise<{ mission: MissionRecord; closer: Closer } | null> {
    const stored = await this.deps.store.missions.getById(missionId);
    if (!stored) return null;
    const { mission } = await this.deps.grounds.inspect(stored);
    if (stored.creatorUserId === user.id) return { mission, closer: { as: 'creator' } };
    // A delegation acts for the creator of the missions it issued, never as an owner.
    if (options.delegation) return null;
    // Orphaned now; or already closed, which is answered the same to who could close it.
    if (mission.status !== 'orphaned' && mission.status !== 'revoked') return null;
    for (const { connectionId } of stored.connections) {
      const connection = await this.deps.store.connections.getById(connectionId);
      if (connection && (await this.owns(user, connection))) {
        return { mission, closer: { as: 'connection-owner', connectionId } };
      }
    }
    return null;
  }

  /** The one definition of "owns the connection now": the authority's (`basis: 'owner'`). */
  private async owns(user: AuthoritySubject, connection: ConnectionRecord): Promise<boolean> {
    return (await this.deps.authority.authorityOf(user, connection)).basis === 'owner';
  }

  /**
   * The creator edits the gate of one accepted risk after issuance (spec §3.5 "at
   * issuance, or later"): `auto` ⇄ `approval`. Only the gate moves — the accepted
   * risks, quotas and rate limits are the mission's as issued, and a gate is not part
   * of what a share restricts, so no authority is re-checked. The edit applies to the
   * next call, ends an opening "for the rest of the period" granted earlier on that
   * risk, and leaves the open requests where they are.
   */
  async setGate(
    user: AuthoritySubject,
    missionId: string,
    riskId: RiskId,
    gate: string,
  ): Promise<SetGateResult> {
    const mission = await this.ownMission(user, missionId);
    if (!mission) return { ok: false, reason: 'not-found' };
    if (!isGate(gate)) return { ok: false, reason: 'invalid-gate' };
    const blocked = gateEditBlockedBy(mission);
    if (blocked) return { ok: false, reason: 'inactive', state: blocked };
    // "Ask me again" on a risk that is gated but open for the period must end the
    // opening: the stored gate would not move, so the store is told what was found.
    // The opening is looked for in the period that runs NOW, whether or not the mission
    // serves at this instant: an expired mission whose expiry is then extended in the
    // same period would otherwise come back with the opening the creator just closed.
    //
    // single-process only: the read and the write are two store calls, so an opening
    // granted between them is missed. Not reachable while every store call is
    // synchronous in one process; with a second process, decide inside
    // `MissionsRepo.setGate`'s transaction (it owns the session's events).
    const openNow =
      gate === 'approval' && (await this.openGatesIn(mission, this.periodNow(mission))).has(riskId);
    const changed = await this.deps.store.missions.setGate(mission.id, riskId, gate, user.id, {
      closeOpening: openNow,
    });
    if (!changed) return { ok: false, reason: 'risk-not-in-policy' };
    const { previous, openingClosed } = changed;
    if (previous !== gate || openingClosed) {
      await this.deps.store.auditWriter.write({
        kind: 'admin',
        ts: toIso(this.deps.clock.now()),
        user_id: user.id,
        act: 'gate-changed',
        object: { type: 'mission', id: mission.id },
        before: {
          risk_id: riskId,
          gate: previous,
          ...(openingClosed ? { open_for_period: true } : {}),
        },
        after: { risk_id: riskId, gate, ...(openingClosed ? { open_for_period: false } : {}) },
        delegated_client_id: null,
      });
      this.deps.logger.info('mission gate changed', {
        mission_id: mission.id,
        risk_id: riskId,
        gate,
        opening_closed: openingClosed,
      });
    }
    return {
      ok: true,
      mission: changed.mission,
      risk_id: riskId,
      gate,
      previous,
      opening_closed: openingClosed,
    };
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
   * Resolves a presented Bearer: prefix lookup, the comparison with the stored
   * SHA-256 digest, then what the token is worth at this instant
   * (`standingOf`). A malformed Bearer, an unknown prefix and a wrong secret
   * are the same answer (`unknown`).
   *
   * A row an earlier build stored as an argon2id hash is checked with argon2id
   * — the only slow path left. `legacyGate`, when given, is asked first and may
   * refuse (`throttled`): the execution door passes its limiter there, so wrong
   * secrets replayed on such a prefix cannot make the instance spend its CPU.
   * When the Bearer matches, the stored value is replaced by the digest of that
   * same Bearer, so the token never takes the slow path again. A write that
   * fails is logged and the call goes on: the token is as valid as before, and
   * the next call tries again.
   */
  async verifyToken(bearer: string): Promise<TokenVerification>;
  async verifyToken(
    bearer: string,
    legacyGate: LegacyHashGate,
  ): Promise<TokenVerification | LegacyHashThrottled>;
  async verifyToken(
    bearer: string,
    legacyGate?: LegacyHashGate,
  ): Promise<TokenVerification | LegacyHashThrottled> {
    const prefix = prefixOfBearer(bearer);
    if (!prefix) return { outcome: 'unknown' };
    const found = await this.deps.store.missions.findTokenByPrefix(prefix);
    if (!found) return { outcome: 'unknown' };
    const legacy = isLegacyTokenHash(found.token);
    if (legacy && legacyGate) {
      const gate = await legacyGate();
      if (!gate.allowed) return { outcome: 'throttled', retryAfterMs: gate.retryAfterMs };
    }
    if (!(await bearerMatches(found.token, bearer))) return { outcome: 'unknown' };
    if (legacy) await this.moveToDigest(found.token, bearer);
    return this.standingOf(found);
  }

  /** Replaces a matched legacy hash by the SHA-256 digest of the same Bearer. Never throws. */
  private async moveToDigest(token: MissionTokenRecord, bearer: string): Promise<void> {
    try {
      const moved = await this.deps.store.missions.rehashToken(token.id, {
        fromHash: token.hash,
        ...digestOfBearer(bearer),
      });
      if (moved) {
        this.deps.logger.info('mission token moved to its sha256 digest', {
          mission_id: token.missionId,
          token_prefix: token.prefix,
        });
      }
    } catch (error) {
      this.deps.logger.warn('mission token not moved to its sha256 digest', {
        mission_id: token.missionId,
        token_prefix: token.prefix,
        error_class: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /**
   * The one place that says whether a token whose secret matched authenticates
   * (spec §0 "Mission token"), read from the store on every call:
   *
   *   - a member token must belong to someone who is, right now, an active user
   *     and a current member of the mission. Nothing is cached and nothing needs
   *     to have been written: a member removed, or a user deactivated, a
   *     millisecond ago is refused;
   *   - the row must be `active` (a holder's rotation and any revocation retire it).
   *
   * The creator is a member by construction and has no row. Their deactivation
   * is not judged here: the mission then reads `orphaned` (derived by
   * `MissionGrounds`), every holder is refused `mission-inactive`, and the
   * same tokens serve again if the creator is reactivated.
   *
   * The record (and its hash) stops here: the door gets the id, the prefix and
   * the holder.
   */
  private async standingOf(found: {
    readonly token: MissionTokenRecord;
    readonly mission: MissionRecord;
  }): Promise<TokenVerification> {
    const { mission } = found;
    const record = found.token;
    const user =
      record.holder.kind === 'member'
        ? await this.deps.store.users.getById(record.holder.userId)
        : null;
    const token: VerifiedToken = {
      id: record.id,
      prefix: record.prefix,
      holder: tokenHolderOf(record, user),
    };
    // The holder is judged first: a member who was removed is told so whatever
    // became of their token or of the mission since (they are no longer told the
    // mission's state). The membership rule is the one `access` reads.
    if (record.holder.kind === 'member') {
      const membership = await this.membershipOf(mission, record.holder.userId, user);
      if (membership === 'deactivated') {
        return { outcome: 'retired', reason: 'holder-deactivated', mission, token };
      }
      if (!isOnMission(membership)) {
        return { outcome: 'retired', reason: 'holder-removed', mission, token };
      }
    }
    if (record.status !== 'active') {
      return { outcome: 'retired', reason: record.status, mission, token };
    }
    return { outcome: 'verified', mission, token };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Reads for the Missions pages
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The missions the user can read, newest first: the ones they created
   * (`role: 'creator'`) and the ones shared with them as a member
   * (`role: 'member'`, spec §4.2 "Missions").
   */
  async list(user: Reader): Promise<MissionOverview[]> {
    const created = await this.deps.store.missions.listForCreator(user.id);
    const shared = (await this.isActiveUser(user.id))
      ? await this.deps.store.missions.listForMember(user.id)
      : [];
    const issuers = await this.issuersOf(created);
    const overviews: MissionOverview[] = [];
    for (const [role, missions] of [
      ['creator', created],
      ['member', shared],
    ] as const) {
      for (const mission of missions) {
        // The listing's SQL selects the current member rows; the rule has the last word.
        if (role === 'member' && (await this.membershipOf(mission, user.id)) !== 'member') {
          continue;
        }
        overviews.push(
          await this.overviewOf(
            { ...(await this.deps.grounds.inspect(mission)), role },
            user,
            issuers.get(mission.id) ?? null,
          ),
        );
      }
    }
    // Newest first: the mission just issued is the one the creator looks for.
    return overviews.sort((a, b) =>
      a.mission.createdAt < b.mission.createdAt
        ? 1
        : a.mission.createdAt > b.mission.createdAt
          ? -1
          : 0,
    );
  }

  /**
   * One mission, for its creator or for a current member (spec §0: a member
   * "can read it"). A member reads the same policy, resources and counters,
   * and the kit with their own token's prefix; they edit nothing
   * (`gates_editable: false`, and every mutation of this service answers
   * `not-found` to anyone but the creator).
   */
  async get(user: Reader, missionId: string): Promise<MissionDetail | null> {
    const inspected = await this.access(user, missionId);
    if (!inspected) return null;
    const { mission } = inspected;
    const issuers = await this.issuersOf([mission]);
    const overview = await this.overviewOf(inspected, user, issuers.get(mission.id) ?? null);
    const connections = await this.detailConnections(mission);
    const remaining = overview.state.kind === 'active' ? overview.state.remaining : null;
    const rows = this.catalogRowsOf(connections);
    const openUntil = await this.openGatesOf(mission, overview.state);
    const policy: MissionDetailRisk[] = mission.policy.map(policyEntryOf).map((entry) => {
      const row = rows.get(entry.risk_id);
      return {
        ...entry,
        label: row?.label ?? entry.risk_id,
        level: row?.level ?? null,
        remaining: remaining ? (remaining[entry.risk_id] ?? null) : null,
        gate_open_until: openUntil.get(entry.risk_id) ?? null,
      };
    });
    return {
      ...overview,
      gates_editable: inspected.role === 'creator' && gateEditBlockedBy(overview.mission) === null,
      connections,
      policy,
      period: statedPeriodOf(mission),
      kit: overview.token
        ? await this.kitOf(mission, { prefix: overview.token.prefix }, connections)
        : null,
    };
  }

  /**
   * The gated risks the creator opened for the current period, with the instant the
   * gate closes again — the budget's own derivation (`openedGatesOf`) over the session's
   * gate events, so this page and `decide()` cannot disagree.
   */
  private async openGatesOf(
    mission: MissionRecord,
    state: MissionState,
  ): Promise<Map<RiskId, Iso8601>> {
    // What the page shows: a mission that serves no call has no gate "open" to show.
    return state.kind === 'active' ? this.openGatesIn(mission, state.period) : new Map();
  }

  /** The period that runs at this instant, whatever the mission's state. */
  private periodNow(mission: MissionRecord): CurrentPeriod {
    return currentPeriod(budgetMissionOf(mission).period, this.deps.clock.now());
  }

  /** The gates opened for `period`, read from the session's gate events since it started. */
  private async openGatesIn(
    mission: MissionRecord,
    period: CurrentPeriod,
  ): Promise<Map<RiskId, Iso8601>> {
    const open = new Map<RiskId, Iso8601>();
    // A one-off mission has no period end: a gate is never opened "for the period" on it.
    if (period.end === null) return open;
    if (!mission.policy.some((entry) => entry.gate === 'approval')) return open;
    const session = await this.deps.store.sessions.getByMission(mission.id);
    if (!session) return open;
    const events = await this.deps.store.sessions.listEvents(session.id, {
      kinds: GATE_EVENT_KINDS,
      since: period.start,
    });
    for (const riskId of openedGatesOf(events, period)) open.set(riskId, period.end);
    return open;
  }

  private async overviewOf(
    { mission, orphan, role }: MissionAccess,
    reader: Reader,
    issuedVia: MissionIssuer | null,
  ): Promise<MissionOverview> {
    const token = await this.ownToken(mission.id, reader.id);
    const creator = await this.deps.store.users.getById(mission.creatorUserId);
    return {
      mission,
      role,
      creator: { id: mission.creatorUserId, email: creator?.email ?? null },
      state: await this.stateOf(mission),
      orphan: orphan && {
        cause: orphan.cause,
        connection_id: orphan.connectionId,
        uncovered: [...orphan.uncovered],
      },
      token: token ? { prefix: token.prefix, createdAt: token.createdAt } : null,
      issuedVia,
    };
  }

  /**
   * The clients behind the missions issued by delegation, read from the store
   * (the mission names its delegation, the delegation its client): one read,
   * and none at all when no mission of the list was delegated.
   */
  private async issuersOf(missions: readonly MissionRecord[]): Promise<Map<string, MissionIssuer>> {
    const delegated = missions.filter((m) => m.delegationId !== null).map((m) => m.id);
    const issuers = new Map<string, MissionIssuer>();
    if (delegated.length === 0) return issuers;
    for (const [missionId, issuer] of await this.deps.store.missions.issuersOf(delegated)) {
      issuers.set(missionId, {
        delegation_id: issuer.delegationId,
        client_id: issuer.clientId,
        client_name: issuer.clientName,
      });
    }
    return issuers;
  }

  /**
   * The state to report when the store refused a token insert because the mission
   * stopped serving between the check and the write: what it reads now, `revoked`
   * if it somehow reads active again (the refusal itself is the fact).
   */
  async stateAfterRefusal(missionId: string): Promise<Exclude<MissionState['kind'], 'active'>> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission) return 'revoked';
    const state = await this.stateOf((await this.deps.grounds.inspect(mission)).mission);
    return state.kind === 'active' ? 'revoked' : state.kind;
  }

  /** The mission's state at this instant (the budget's single derivation). */
  stateOf(mission: MissionRecord): Promise<MissionState> {
    return this.budget.stateOf(budgetMissionOf(mission), this.deps.clock.now());
  }

  /** The active member token this user holds on the mission, if any. */
  private async ownToken(missionId: string, userId: string): Promise<MissionTokenRecord | null> {
    const tokens = await this.deps.store.missions.listTokens(missionId);
    return (
      tokens.find(
        (t) => t.status === 'active' && t.holder.kind === 'member' && t.holder.userId === userId,
      ) ?? null
    );
  }

  private async isActiveUser(userId: string): Promise<boolean> {
    return (await this.deps.store.users.getById(userId))?.status === 'active';
  }

  /**
   * Who may READ a mission, and as what: its creator, or a current member who
   * is an active user. One answer (`null`) for "does not exist", "not yours"
   * and "no longer shared with you". Every mutation of the mission itself goes
   * through `ownMission` instead, which knows the creator only.
   */
  async access(user: Reader, missionId: string): Promise<MissionAccess | null> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission) return null;
    const membership = await this.membershipOf(mission, user.id);
    if (membership !== 'creator' && membership !== 'member') return null;
    return { ...(await this.deps.grounds.inspect(mission)), role: membership };
  }

  /**
   * What `userId` is to the mission right now (`membershipOf`, the store's one
   * statement of the rule). The creator costs no read; anyone else costs their
   * user row (unless the caller already holds it) and their member row.
   */
  private async membershipOf(
    mission: MissionRecord,
    userId: string,
    known?: UserRecord | null,
  ): Promise<Membership> {
    if (mission.creatorUserId === userId) return membershipOf(mission, userId, null, null);
    const user = known === undefined ? await this.deps.store.users.getById(userId) : known;
    const row = await this.deps.store.missions.getMember(mission.id, userId);
    return membershipOf(mission, userId, user, row);
  }

  /**
   * One answer for "does not exist" and "not yours". The mission is returned as
   * it stands now: `orphaned` when the creator's authority is missing.
   */
  private async ownMission(
    user: AuthoritySubject,
    missionId: string,
  ): Promise<MissionRecord | null> {
    return (await this.ownInspected(user, missionId))?.mission ?? null;
  }

  private async ownInspected(
    user: AuthoritySubject,
    missionId: string,
  ): Promise<InspectedMission | null> {
    const mission = await this.deps.store.missions.getById(missionId);
    if (!mission || mission.creatorUserId !== user.id) return null;
    return this.deps.grounds.inspect(mission);
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

  /**
   * The bootstrap kit of the mission around one token: its secret (shown once,
   * to the holder who just generated it) or its masked prefix. The same kit
   * for every holder but for that token: same resources, same policy, same
   * budget (spec §0 "Mission member").
   */
  async kitOf(
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

/**
 * The holder of a token as the door and the audit name it. A member is shown
 * by their email; a member whose user row is gone keeps their id.
 */
export function tokenHolderOf(
  token: Pick<MissionTokenRecord, 'holder'>,
  user: Pick<UserRecord, 'email'> | null,
): TokenHolder {
  if (token.holder.kind === 'named') return { kind: 'named', name: token.holder.name };
  return {
    kind: 'member',
    user_id: token.holder.userId,
    display: user?.email ?? token.holder.userId,
  };
}
