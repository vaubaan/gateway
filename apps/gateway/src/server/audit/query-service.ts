/**
 * `AuditQueryService` — what the Audit page reads (spec §4.2 "Audit", §8).
 *
 * Visibility: a user sees the entries about the missions they created and
 * about the connections they or their groups own; an operator sees every
 * administrative entry too. The scope is applied in the store's query, before
 * filters and paging, so a filter can only narrow it.
 *
 * Arguments: an audit entry never holds them (`arguments_hash` only, spec §6
 * "no secret in logs"), and the views built here are explicit field lists, so
 * nothing else of a record reaches the page.
 */
import {
  BOOTSTRAP_ACTOR_ID,
  BOOTSTRAP_ACTOR_LABEL,
  type AdminAct,
  type AdminObjectType,
  type AuditDecision,
} from '@vaubaan/gateway-core';
import type { Principal, RefusalCode, RiskId } from '@vaubaan/shared';

import type { AuditCursor, AuditRecord, AuditScope, Store } from '../store';
import type { AuditFilters } from './filters';

export const AUDIT_PAGE_SIZE = 50;

export { BOOTSTRAP_ACTOR_ID };

/** Who is looking. `Principal` of `../auth` satisfies it. */
export type AuditViewer =
  | {
      readonly kind: 'user';
      readonly user: { readonly id: string };
      readonly groups: readonly { readonly id: string }[];
      readonly isOperator: boolean;
    }
  | { readonly kind: 'bootstrap' };

export interface AuditMissionRef {
  readonly id: string;
  /** `null` when the mission no longer exists. */
  readonly name: string | null;
  readonly creator_email: string | null;
}

export interface AuditConnectionRef {
  readonly id: string;
  readonly display_name: string | null;
  readonly provider: string | null;
}

export interface AuditCallView {
  readonly kind: 'call';
  readonly id: string;
  readonly ts: string;
  readonly mission: AuditMissionRef;
  readonly connection: AuditConnectionRef | null;
  readonly resource_ref: string | null;
  readonly tool: string;
  /** The only trace of the arguments: the canonical sha256 fingerprint (64 hex characters). */
  readonly arguments_hash: string;
  readonly decision: AuditDecision;
  readonly refusal_code: RefusalCode | null;
  readonly refusal_reason: string | null;
  readonly risks_touched: readonly RiskId[];
  /** Remaining quota per touched risk after the call; `null` when the budget was not consulted. */
  readonly remaining_budget: Readonly<Record<RiskId, number>> | null;
  readonly approval_id: string | null;
  readonly agent_label: string | null;
  readonly upstream_latency_ms: number | null;
  readonly upstream_error: string | null;
  readonly client_ip: string | null;
}

export interface AuditAdminView {
  readonly kind: 'admin';
  readonly id: string;
  readonly ts: string;
  /** `label` is what a page shows: the email, "Bootstrap operator", else the id. */
  readonly actor: { readonly id: string; readonly email: string | null; readonly label: string };
  readonly act: AdminAct;
  readonly object: {
    readonly type: AdminObjectType;
    readonly id: string;
    /** Mission name or connection display name, when the object still exists. */
    readonly label: string | null;
  };
  readonly before: unknown;
  readonly after: unknown;
  readonly delegated_client_id: string | null;
}

export type AuditEntryView = AuditCallView | AuditAdminView;

export interface AuditPage {
  readonly entries: readonly AuditEntryView[];
  /** Position of the next (older) page; `null` on the last one. */
  readonly next: AuditCursor | null;
}

export interface AuditFilterOptions {
  readonly missions: readonly { readonly id: string; readonly name: string }[];
  readonly connections: readonly { readonly id: string; readonly label: string }[];
}

export interface AuditQueryDeps {
  readonly store: Pick<Store, 'audit' | 'missions' | 'connections' | 'users'>;
}

/** The store scope of a viewer. Exported for the tests of the rule itself. */
export function scopeOf(viewer: AuditViewer): AuditScope {
  if (viewer.kind === 'bootstrap') {
    // The bootstrap operator configures the instance and owns nothing.
    return { missionCreatorUserId: null, connectionOwners: [], allAdmin: true };
  }
  return {
    missionCreatorUserId: viewer.user.id,
    connectionOwners: ownersOf(viewer),
    allAdmin: viewer.isOperator,
  };
}

function ownersOf(viewer: Extract<AuditViewer, { kind: 'user' }>): Principal[] {
  return [
    { kind: 'user', id: viewer.user.id },
    ...viewer.groups.map((g): Principal => ({ kind: 'group', id: g.id })),
  ];
}

const ARGUMENT_KEYS = new Set(['args', 'arguments', 'raw_arguments']);
export const ARGUMENTS_NOT_SHOWN = '[not shown]';

/**
 * Defence in depth for `before` / `after`: an administrative entry must never
 * carry call arguments (gateway-core: "never a secret"), and if a writer ever
 * put some under an obvious key they are not shown.
 */
export function withoutArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutArguments);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      key,
      ARGUMENT_KEYS.has(key.toLowerCase()) ? ARGUMENTS_NOT_SHOWN : withoutArguments(inner),
    ]),
  );
}

export class AuditQueryService {
  constructor(private readonly deps: AuditQueryDeps) {}

  /** One page, newest first. `cursor` is the `next` of the previous page. */
  async search(
    viewer: AuditViewer,
    filters: AuditFilters,
    cursor: AuditCursor | null = null,
    pageSize: number = AUDIT_PAGE_SIZE,
  ): Promise<AuditPage> {
    const userIds = filters.user === null ? undefined : await this.userIdsOf(filters.user);
    // One more than the page: its presence says there is an older page.
    const records = await this.deps.store.audit.search({
      scope: scopeOf(viewer),
      limit: pageSize + 1,
      ...(filters.missionId ? { missionId: filters.missionId } : {}),
      ...(userIds ? { userIds } : {}),
      ...(filters.connectionId ? { connectionId: filters.connectionId } : {}),
      ...(filters.tool ? { tool: filters.tool } : {}),
      ...(filters.decision ? { decision: filters.decision } : {}),
      ...(filters.agentLabel ? { agentLabel: filters.agentLabel } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.since ? { since: filters.since } : {}),
      ...(filters.until ? { until: filters.until } : {}),
      ...(cursor ? { before: cursor } : {}),
    });
    const page = records.slice(0, pageSize);
    const last = page.at(-1);
    const names = new NameCache(this.deps.store);
    const entries: AuditEntryView[] = [];
    for (const record of page) entries.push(await toView(record, names));
    return {
      entries,
      next: records.length > pageSize && last ? { ts: last.ts, id: last.id } : null,
    };
  }

  /** The missions and connections the viewer can filter on: their own. */
  async filterOptions(viewer: AuditViewer): Promise<AuditFilterOptions> {
    if (viewer.kind === 'bootstrap') return { missions: [], connections: [] };
    const missions = await this.deps.store.missions.listForCreator(viewer.user.id);
    const connections = await this.deps.store.connections.listOwnedBy(ownersOf(viewer));
    return {
      missions: missions.map((m) => ({ id: m.id, name: m.name })).reverse(),
      connections: connections.map((c) => ({
        id: c.id,
        label: `${c.provider} — ${c.displayName}`,
      })),
    };
  }

  /**
   * The user filter as typed: an email address or a user id. An unknown value
   * yields no entry, exactly like a known user with none, so the filter does
   * not reveal who has an account.
   */
  private async userIdsOf(typed: string): Promise<string[]> {
    if (typed.includes('@')) {
      return (await this.deps.store.users.findByEmail(typed)).map((u) => u.id);
    }
    return [typed];
  }
}

/** Names behind the ids of one page, looked up once each. */
class NameCache {
  private readonly missions = new Map<string, Promise<AuditMissionRef>>();
  private readonly connections = new Map<string, Promise<AuditConnectionRef>>();
  private readonly emails = new Map<string, Promise<string | null>>();

  constructor(private readonly store: AuditQueryDeps['store']) {}

  mission(id: string): Promise<AuditMissionRef> {
    return memo(this.missions, id, async () => {
      const mission = await this.store.missions.getById(id);
      if (!mission) return { id, name: null, creator_email: null };
      return { id, name: mission.name, creator_email: await this.email(mission.creatorUserId) };
    });
  }

  connection(id: string): Promise<AuditConnectionRef> {
    return memo(this.connections, id, async () => {
      const connection = await this.store.connections.getById(id);
      return {
        id,
        display_name: connection?.displayName ?? null,
        provider: connection?.provider ?? null,
      };
    });
  }

  email(userId: string): Promise<string | null> {
    return memo(this.emails, userId, async () =>
      userId === BOOTSTRAP_ACTOR_ID
        ? null
        : ((await this.store.users.getById(userId))?.email ?? null),
    );
  }
}

function memo<V>(cache: Map<string, Promise<V>>, key: string, load: () => Promise<V>): Promise<V> {
  let value = cache.get(key);
  if (!value) {
    value = load();
    cache.set(key, value);
  }
  return value;
}

async function toView(record: AuditRecord, names: NameCache): Promise<AuditEntryView> {
  if (record.kind === 'call') {
    return {
      kind: 'call',
      id: record.id,
      ts: record.ts,
      mission: await names.mission(record.mission_id),
      connection: record.connection_id ? await names.connection(record.connection_id) : null,
      resource_ref: record.resource_ref,
      tool: record.tool,
      arguments_hash: record.arguments_hash,
      decision: record.decision,
      refusal_code: record.refusal_code,
      refusal_reason: record.refusal_reason,
      risks_touched: record.risks_touched,
      remaining_budget: record.remaining_budget,
      approval_id: record.approval_id,
      agent_label: record.agent_label,
      upstream_latency_ms: record.upstream_latency_ms,
      upstream_error: record.upstream_error,
      client_ip: record.client_ip,
    };
  }
  return {
    kind: 'admin',
    id: record.id,
    ts: record.ts,
    actor: await actorView(record.user_id, names),
    act: record.act,
    object: {
      type: record.object.type,
      id: record.object.id,
      label: await objectLabel(record.object, names),
    },
    before: withoutArguments(record.before),
    after: withoutArguments(record.after),
    delegated_client_id: record.delegated_client_id,
  };
}

async function objectLabel(
  object: { readonly type: AdminObjectType; readonly id: string },
  names: NameCache,
): Promise<string | null> {
  if (object.type === 'mission') return (await names.mission(object.id)).name;
  if (object.type === 'connection') return (await names.connection(object.id)).display_name;
  return null;
}

async function actorView(userId: string, names: NameCache): Promise<AuditAdminView['actor']> {
  if (userId === BOOTSTRAP_ACTOR_ID)
    return { id: userId, email: null, label: BOOTSTRAP_ACTOR_LABEL };
  const email = await names.email(userId);
  return { id: userId, email, label: email ?? userId };
}
