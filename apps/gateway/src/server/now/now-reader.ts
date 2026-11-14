/**
 * The read model of the home, "Now" (spec §4.2): what waits for the person,
 * what is running, what just happened — and, for someone who created nothing
 * yet, what they already have to start with.
 *
 * Read-only. It composes reads that already decide who sees what, and adds no
 * rule of its own:
 *
 *   - missions      `MissionService.list` — the ones the person created, and the
 *                   ones shared with them as a member;
 *   - what waits    `RequestService.waiting` — the creator's open requests;
 *   - accounts      `ConnectionService.listFor` and `ShareService.received`;
 *   - counts        the audit's per-holder activity of each of those missions
 *                   (a member reads the session of a mission shared with them,
 *                   spec §0 "Mission member").
 *
 * Cost: a handful of indexed reads per mission the person can read. The home
 * of one person lists their missions, not the instance's; nothing here scans
 * a table.
 */
import type { PluginRegistry } from '@vaubaan/plugin-sdk';
import type { Iso8601, MissionTokenKind, RiskId } from '@vaubaan/shared';

import type { Actor, ConnectionService } from '../connections';
import type { MissionOverview, MissionRole, MissionService, TrustRaiseOffer } from '../missions';
import { riskExplainer } from '../../lib/providers/reference';
import { issuerName } from '../../lib/vocabulary';
import type { RequestService, WaitingItem } from '../requests';
import { effectiveState } from '../requests/state';
import type { ShareService } from '../shares';
import type { Store } from '../store';
import type { Clock } from '../store/clock';
import { toIso } from '../store/clock';
import { byLastActivity, nearestLimit, type LimitLine } from './derive';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How many missions that are not running the home names; the rest are on Missions. */
export const STOPPED_SHOWN = 3;

export interface NowDeps {
  readonly store: Pick<
    Store,
    'missions' | 'users' | 'sessions' | 'audit' | 'requests' | 'connections'
  >;
  readonly registry: PluginRegistry;
  readonly missions: Pick<MissionService, 'list' | 'trustRaisesFor'>;
  readonly requests: Pick<RequestService, 'waiting'>;
  readonly connections: Pick<ConnectionService, 'listFor'>;
  readonly shares: Pick<ShareService, 'received'>;
  readonly clock: Clock;
}

/** Who holds a key of a mission: a person, or a machine key by its name. */
export interface NowHolder {
  readonly kind: MissionTokenKind;
  /** A person's display name, else their email; a machine key's name. */
  readonly label: string;
  /** The reader's own key. */
  readonly you: boolean;
}

export interface RunningMission {
  readonly id: string;
  readonly name: string;
  readonly role: MissionRole;
  /** Who created it, for a mission shared with the reader; `null` on their own. */
  readonly creator: string | null;
  /** The services of its accounts, by display name, each once. */
  readonly services: readonly string[];
  /** The keys that work now, the reader's first. */
  readonly holders: readonly NowHolder[];
  /** The connected app that created it for the reader; `null` otherwise. */
  readonly issued_via: string | null;
  /** The permission closest to its limit in the current period; `null` for an empty policy. */
  readonly nearest: LimitLine | null;
  /** How many permissions are at their limit now. */
  readonly limits_reached: number;
  /** Open requests on it, waiting for its creator. */
  readonly open_requests: number;
  /** The last thing recorded on it — a call, an answer, a change; `null` before the first call. */
  readonly last_activity_at: Iso8601 | null;
  readonly created_at: Iso8601;
  /** Calls in the last 24 hours, allowed and refused. */
  readonly calls_last_day: number;
}

export interface StoppedMission {
  readonly id: string;
  readonly name: string;
  readonly role: MissionRole;
  readonly state: 'expired' | 'revoked' | 'orphaned';
  /** When it expired or was stopped; `null` when the mission does not say. */
  readonly since: Iso8601 | null;
}

/** An account someone gave the reader access to: enough to start a mission on. */
export interface SharedAccount {
  readonly connection_id: string;
  readonly name: string;
  readonly service: string;
  readonly owner: string;
  /** How many permissions the reader may allow on it. */
  readonly permissions: number;
}

/** A mission shared with the reader, and whether they hold a key of it yet. */
export interface SharedMission {
  readonly id: string;
  readonly name: string;
  readonly creator: string;
  readonly services: readonly string[];
  readonly has_key: boolean;
  readonly running: boolean;
}

export interface NowView {
  readonly at: Iso8601;
  readonly waiting: readonly WaitingItem[];
  /** Active missions the reader can read, the most recently active first. */
  readonly running: readonly RunningMission[];
  /** Missions that do not run any more, the most recently created first, at most `STOPPED_SHOWN`. */
  readonly stopped: readonly StoppedMission[];
  readonly totals: {
    /** Every mission the reader can read, running or not. */
    readonly missions: number;
    readonly stopped: number;
    readonly calls_last_day: number;
    readonly refused_last_hour: number;
    /** Accounts the reader owns, alone or through a team, that are not disconnected. */
    readonly accounts: number;
    /** Among them, the ones whose credential must be renewed. */
    readonly accounts_to_reconnect: number;
  };
  /** The reader created no mission yet: the home explains the model and the steps. */
  readonly first_run: boolean;
  readonly shared_accounts: readonly SharedAccount[];
  readonly shared_missions: readonly SharedMission[];
  /**
   * Trust-raise proposals of the running missions the reader created (risk model §4.7),
   * per mission. A separate offer from a budget widening, which waits as a claim.
   */
  readonly trust_raises: readonly NowTrustRaises[];
}

/** The trust-raise proposals of one mission the reader created. */
export interface NowTrustRaises {
  readonly mission_id: string;
  readonly mission_name: string;
  readonly offers: readonly TrustRaiseOffer[];
}

/** The name a page prints for a person: what the identity provider said, else the email. */
function nameOf(user: { readonly displayName: string | null; readonly email: string }): string {
  return user.displayName ?? user.email;
}

export async function readNow(deps: NowDeps, actor: Actor): Promise<NowView> {
  const now = deps.clock.now();
  const { store } = deps;
  const explain = riskExplainer(deps.registry);
  const labelOf = (riskId: RiskId): string => explain(riskId)?.label ?? riskId;

  const names = new Map<string, string>();
  async function personLabel(userId: string): Promise<string> {
    let label = names.get(userId);
    if (label === undefined) {
      const user = await store.users.getById(userId);
      label = user ? nameOf(user) : userId;
      names.set(userId, label);
    }
    return label;
  }

  const serviceNames = new Map<string, string | null>();
  async function servicesOf(overview: MissionOverview): Promise<string[]> {
    const services: string[] = [];
    for (const { connectionId } of overview.mission.connections) {
      let service = serviceNames.get(connectionId);
      if (service === undefined) {
        const connection = await store.connections.getById(connectionId);
        service = connection
          ? (deps.registry.get(connection.provider)?.plugin.displayName ?? connection.provider)
          : null;
        serviceNames.set(connectionId, service);
      }
      if (service !== null && !services.includes(service)) services.push(service);
    }
    return services;
  }

  async function holdersOf(missionId: string): Promise<NowHolder[]> {
    const holders: NowHolder[] = [];
    for (const token of await store.missions.listTokens(missionId)) {
      if (token.status !== 'active') continue;
      holders.push(
        token.holder.kind === 'member'
          ? {
              kind: 'member',
              label: await personLabel(token.holder.userId),
              you: token.holder.userId === actor.user.id,
            }
          : { kind: 'named', label: token.holder.name, you: false },
      );
    }
    return holders.sort((a, b) => Number(b.you) - Number(a.you));
  }

  const waiting = await deps.requests.waiting(actor.user);
  const waitingOn = new Map<string, number>();
  for (const item of waiting) {
    const id = item.request.mission.id;
    waitingOn.set(id, (waitingOn.get(id) ?? 0) + 1);
  }

  /** A member does not read the requests; they may know that the mission waits. */
  async function openRequestsOf(overview: MissionOverview): Promise<number> {
    if (overview.role === 'creator') return waitingOn.get(overview.mission.id) ?? 0;
    const requests = await store.requests.listForMission(overview.mission.id);
    return requests.filter((request) => effectiveState(request, now) === 'open').length;
  }

  const dayAgo = toIso(new Date(now.getTime() - DAY_MS));
  const hourAgo = toIso(new Date(now.getTime() - HOUR_MS));

  const overviews = await deps.missions.list(actor.user);
  const running: RunningMission[] = [];
  const stopped: StoppedMission[] = [];
  const sharedMissions: SharedMission[] = [];
  let callsLastDay = 0;
  let refusedLastHour = 0;

  for (const overview of overviews) {
    const { mission, state, role } = overview;
    const services = await servicesOf(overview);
    if (role === 'member') {
      sharedMissions.push({
        id: mission.id,
        name: mission.name,
        creator: await personLabel(mission.creatorUserId),
        services,
        has_key: overview.token !== null,
        running: state.kind === 'active',
      });
    }

    const day = await store.audit.tokenHolderActivity(mission.id, { since: dayAgo, until: null });
    const calls = day.reduce((sum, holder) => sum + holder.allowed + holder.refused, 0);
    callsLastDay += calls;
    if (day.some((holder) => holder.refused > 0)) {
      const hour = await store.audit.tokenHolderActivity(mission.id, {
        since: hourAgo,
        until: null,
      });
      refusedLastHour += hour.reduce((sum, holder) => sum + holder.refused, 0);
    }

    if (state.kind !== 'active') {
      stopped.push({
        id: mission.id,
        name: mission.name,
        role,
        state: state.kind,
        since: state.kind === 'expired' ? state.expires_at : mission.closedAt,
      });
      continue;
    }

    const session = await store.sessions.getByMission(mission.id);
    const [last] = session ? await store.sessions.listRecentEvents(session.id, { limit: 1 }) : [];
    running.push({
      id: mission.id,
      name: mission.name,
      role,
      creator: role === 'member' ? await personLabel(mission.creatorUserId) : null,
      services,
      holders: await holdersOf(mission.id),
      issued_via: overview.issued_via ? issuerName(overview.issued_via) : null,
      nearest: nearestLimit(mission.policy, state.remaining, labelOf),
      limits_reached: state.exhausted.length,
      open_requests: await openRequestsOf(overview),
      last_activity_at: last?.ts ?? null,
      created_at: mission.createdAt,
      calls_last_day: calls,
    });
  }

  const owned = (await deps.connections.listFor(actor)).filter(
    (view) => view.connection.status !== 'revoked',
  );
  const received = await deps.shares.received(actor);
  const sharedPermissions = new Map<string, Set<RiskId>>();
  const sharedAccounts = new Map<string, Omit<SharedAccount, 'permissions'>>();
  for (const share of received) {
    if (share.connection.status === 'revoked') continue;
    // Several shares of one account add up: the reader holds the union.
    const permissions = sharedPermissions.get(share.connection.id) ?? new Set<RiskId>();
    for (const risk of share.risks) permissions.add(risk.risk_id);
    sharedPermissions.set(share.connection.id, permissions);
    sharedAccounts.set(share.connection.id, {
      connection_id: share.connection.id,
      name: share.connection.displayName,
      service: share.providerLabel,
      owner: share.ownerLabel,
    });
  }

  return {
    at: toIso(now),
    waiting,
    running: running.sort(byLastActivity),
    stopped: stopped.slice(0, STOPPED_SHOWN),
    totals: {
      missions: overviews.length,
      stopped: stopped.length,
      calls_last_day: callsLastDay,
      refused_last_hour: refusedLastHour,
      accounts: owned.length,
      accounts_to_reconnect: owned.filter((view) => view.connection.status === 'expired').length,
    },
    first_run: !overviews.some((overview) => overview.role === 'creator'),
    shared_accounts: [...sharedAccounts.values()].map((account) => ({
      ...account,
      permissions: sharedPermissions.get(account.connection_id)?.size ?? 0,
    })),
    shared_missions: sharedMissions,
    trust_raises: await deps.missions.trustRaisesFor(actor.user),
  };
}
