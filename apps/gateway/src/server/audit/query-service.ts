/**
 * `AuditQueryService` — what the Audit page reads (spec §4.2 "Audit", §8).
 *
 * Visibility (ADR audit-visibility-members-and-operators): a user sees the
 * entries about the missions they created, about the missions they are a
 * member of, and about the connections they or their groups own; an operator
 * sees every entry, calls included. The scope is applied in the store's
 * query, before filters and paging, so a filter can only narrow it.
 *
 * Arguments: an audit entry never holds them (`arguments_hash` only, spec §6
 * "no secret in logs"), and the views built here are explicit field lists, so
 * nothing else of a record reaches the page. The fingerprint itself is the
 * one trace of the arguments, and it can be guessed for low-entropy ones: it
 * is shown to whoever answers for the call — the creator of its mission, an
 * owner of its connection — and to nobody who reads the entry only as a
 * member or as an operator (`standingOn`).
 */
import {
  BOOTSTRAP_ACTOR_ID,
  BOOTSTRAP_ACTOR_LABEL,
  CONFIGURATION_ACTOR_ID,
  CONFIGURATION_ACTOR_LABEL,
  RECOVERY_ACTOR_ID,
  RECOVERY_ACTOR_LABEL,
  SCHEDULE_ACTOR_ID,
  SCHEDULE_ACTOR_LABEL,
  type AdminAct,
  type AdminObjectType,
  type AuditDecision,
} from '@vaubaan/gateway-core';
import type { MissionTokenKind, Principal, RefusalCode, RiskId } from '@vaubaan/shared';

import type { AuditCursor, AuditRecord, AuditScope, AuditSearch, Store } from '../store';
import type { ConnectionRecord, MissionRecord } from '../store/types';
import type { AuditFilters } from './filters';
import { parseHolderParam } from './session-view';

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

/** The token a call presented and who it belongs to (spec §8). */
export interface AuditTokenRef {
  readonly kind: MissionTokenKind;
  /** The member's user id, or the token's name: what the entry stores. */
  readonly key: string;
  /** What a page shows: the member's email (their id when the user is gone), or the name. */
  readonly label: string;
}

export interface AuditCallView {
  readonly kind: 'call';
  readonly id: string;
  readonly ts: string;
  readonly mission: AuditMissionRef;
  /** `null` on an entry written before tokens had a holder. */
  readonly token: AuditTokenRef | null;
  readonly connection: AuditConnectionRef | null;
  readonly resource_ref: string | null;
  readonly tool: string;
  /**
   * The only trace of the arguments: the canonical sha256 fingerprint (64 hex
   * characters). `null` when this viewer is not shown it: they read the entry
   * as a member of the mission or as an operator (spec §4.2 "never arguments").
   */
  readonly arguments_hash: string | null;
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
    /**
     * The name of the object when it still exists (`objectLabel`): a mission or
     * group name, a connection's display name, a client's declared name, "the
     * connection → who it is shared with" for a share, "the limit of <mission>"
     * or "a call of <mission>" for a request. `null` for an object that is gone, and for `instance-config`,
     * whose id is its name.
     */
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
  readonly store: Pick<
    Store,
    | 'audit'
    | 'missions'
    | 'connections'
    | 'users'
    | 'shares'
    | 'groups'
    | 'delegations'
    | 'requests'
  >;
}

/** The store scope of a viewer. Exported for the tests of the rule itself. */
export function scopeOf(viewer: AuditViewer): AuditScope {
  if (viewer.kind === 'bootstrap') {
    // The bootstrap operator configures the instance and owns nothing. It reads the
    // administrative entries and no call: it is a shared token, not a person, and it
    // exists before the first user does — there is no call for it to read.
    return {
      missionCreatorUserId: null,
      missionMemberUserId: null,
      connectionOwners: [],
      allAdmin: true,
      allCalls: false,
    };
  }
  return {
    missionCreatorUserId: viewer.user.id,
    missionMemberUserId: viewer.user.id,
    connectionOwners: ownersOf(viewer),
    allAdmin: viewer.isOperator,
    allCalls: viewer.isOperator,
  };
}

/**
 * What a viewer is to the mission and the connection of an entry they were
 * given: `responsible` when they created the mission or own the connection —
 * they answer for the call —, `reader` otherwise (a member of the mission, an
 * operator). A reader is shown everything but the argument fingerprint.
 */
export type AuditStanding = 'responsible' | 'reader';

export function standingOn(
  viewer: AuditViewer,
  mission: { readonly creatorUserId: string } | null,
  connection: { readonly owner: Principal } | null,
): AuditStanding {
  if (viewer.kind !== 'user') return 'reader';
  if (mission !== null && mission.creatorUserId === viewer.user.id) return 'responsible';
  if (connection !== null) {
    const { owner } = connection;
    const owns = ownersOf(viewer).some((p) => p.kind === owner.kind && p.id === owner.id);
    if (owns) return 'responsible';
  }
  return 'reader';
}

function ownersOf(viewer: Extract<AuditViewer, { kind: 'user' }>): Principal[] {
  return [
    { kind: 'user', id: viewer.user.id },
    ...viewer.groups.map((g): Principal => ({ kind: 'group', id: g.id })),
  ];
}

const ARGUMENT_KEYS = new Set(['args', 'arguments', 'raw_arguments']);
/** Keys under which an entry carries the fingerprint of a call's arguments. */
const FINGERPRINT_KEYS = new Set(['fingerprint', 'arguments_hash', 'arguments_fingerprint']);
export const ARGUMENTS_NOT_SHOWN = '[not shown]';

/**
 * Defence in depth for `before` / `after`: an administrative entry must never
 * carry call arguments (gateway-core: "never a secret"), and if a writer ever
 * put some under an obvious key they are not shown. For a `reader`, the
 * fingerprint of the arguments (the entries of an approval request carry it)
 * is not shown either.
 */
export function withoutArguments(value: unknown, standing: AuditStanding = 'responsible'): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutArguments(item, standing));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      const name = key.toLowerCase();
      const hidden =
        ARGUMENT_KEYS.has(name) || (standing === 'reader' && FINGERPRINT_KEYS.has(name));
      return [key, hidden ? ARGUMENTS_NOT_SHOWN : withoutArguments(inner, standing)];
    }),
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
    const tokenHolders =
      filters.tokenHolder === null ? undefined : await this.holdersOf(filters.tokenHolder);
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
      ...(tokenHolders ? { tokenHolders } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.since ? { since: filters.since } : {}),
      ...(filters.until ? { until: filters.until } : {}),
      ...(cursor ? { before: cursor } : {}),
    });
    const page = records.slice(0, pageSize);
    const last = page.at(-1);
    const names = new NameCache(this.deps.store);
    const entries: AuditEntryView[] = [];
    for (const record of page) entries.push(await toView(record, names, viewer));
    return {
      entries,
      next: records.length > pageSize && last ? { ts: last.ts, id: last.id } : null,
    };
  }

  /**
   * The missions and connections the viewer can filter on: the missions they
   * created or are a member of, the connections they own. An operator reads
   * every entry but is offered their own here: the list is a convenience, and
   * any mission id can be typed in the address.
   */
  async filterOptions(viewer: AuditViewer): Promise<AuditFilterOptions> {
    if (viewer.kind === 'bootstrap') return { missions: [], connections: [] };
    const created = await this.deps.store.missions.listForCreator(viewer.user.id);
    const shared = await this.deps.store.missions.listForMember(viewer.user.id);
    const missions = [...created, ...shared];
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
   * The names behind the ids a change holds in its `before` and `after`, for the
   * page that prints the change in words: an account by its name, a resource by
   * its display name, a person by their email, a team by its name. Keyed by id;
   * an id whose object is gone is absent (the page then prints the id).
   *
   * Read-only, and it reveals nothing the entry does not: it takes an entry this
   * service returned to the reader — the ids are already in what they read — and
   * names them. Called for the one line a person opened, not for a page of lines.
   */
  async changeNames(entry: AuditAdminView): Promise<Readonly<Record<string, string>>> {
    const names = new NameCache(this.deps.store);
    const found: Record<string, string> = {};
    const put = (id: unknown, name: string | null | undefined): void => {
      if (typeof id === 'string' && name) found[id] = name;
    };
    const visit = async (value: unknown): Promise<void> => {
      if (Array.isArray(value)) {
        for (const item of value) await visit(item);
        return;
      }
      if (typeof value !== 'object' || value === null) return;
      const record = value as Readonly<Record<string, unknown>>;
      // `{ kind: 'user' | 'group', id }`: an owner, or whom an access was given to.
      if (typeof record.id === 'string' && (record.kind === 'user' || record.kind === 'group')) {
        put(
          record.id,
          record.kind === 'user' ? await names.email(record.id) : await names.group(record.id),
        );
      }
      for (const [key, inner] of Object.entries(record)) {
        if (key === 'connection_id' && typeof inner === 'string') {
          put(inner, (await names.connection(inner)).display_name);
        } else if (key === 'resource_id' && typeof inner === 'string') {
          put(inner, await names.resource(inner));
        } else if (key === 'resource_ids' && Array.isArray(inner)) {
          for (const id of inner) {
            if (typeof id === 'string') put(id, await names.resource(id));
          }
        } else if ((key === 'user_id' || key === 'member_user_id') && typeof inner === 'string') {
          put(inner, await names.email(inner));
        } else {
          await visit(inner);
        }
      }
    };
    await visit(entry.before);
    await visit(entry.after);
    return found;
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

  /**
   * The holder filter as typed. The exact form (`member:<user id>`,
   * `named:<name>`) is taken as it is. Otherwise an email names a member — a
   * token name never contains `@` (`parseTokenName`) — and anything else the
   * name of a named token. An unknown email yields no entry, like a known
   * member with no call.
   */
  private async holdersOf(typed: string): Promise<NonNullable<AuditSearch['tokenHolders']>> {
    const exact = parseHolderParam(typed);
    if (exact) return { kind: exact.kind, holders: [exact.key] };
    if (typed.includes('@')) return { kind: 'member', holders: await this.userIdsOf(typed) };
    return { kind: 'named', holders: [typed] };
  }
}

/** Names behind the ids of one page, looked up once each. */
class NameCache {
  private readonly missions = new Map<string, Promise<AuditMissionRef>>();
  private readonly connections = new Map<string, Promise<AuditConnectionRef>>();
  private readonly missionRecords = new Map<string, Promise<MissionRecord | null>>();
  private readonly connectionRecords = new Map<string, Promise<ConnectionRecord | null>>();
  private readonly emails = new Map<string, Promise<string | null>>();
  private readonly labels = new Map<string, Promise<string | null>>();

  constructor(private readonly store: AuditQueryDeps['store']) {}

  /** The mission row, or `null` when it no longer exists. */
  missionRecord(id: string): Promise<MissionRecord | null> {
    return memo(this.missionRecords, id, () => this.store.missions.getById(id));
  }

  /** The connection row, or `null` when it no longer exists. */
  connectionRecord(id: string): Promise<ConnectionRecord | null> {
    return memo(this.connectionRecords, id, () => this.store.connections.getById(id));
  }

  mission(id: string): Promise<AuditMissionRef> {
    return memo(this.missions, id, async () => {
      const mission = await this.missionRecord(id);
      if (!mission) return { id, name: null, creator_email: null };
      return { id, name: mission.name, creator_email: await this.email(mission.creatorUserId) };
    });
  }

  connection(id: string): Promise<AuditConnectionRef> {
    return memo(this.connections, id, async () => {
      const connection = await this.connectionRecord(id);
      return {
        id,
        display_name: connection?.displayName ?? null,
        provider: connection?.provider ?? null,
      };
    });
  }

  /** The mission a request belongs to, or `null` when the request is gone. */
  missionOfRequest(id: string): Promise<string | null> {
    return memo(
      this.labels,
      `request-mission:${id}`,
      async () => (await this.store.requests.getById(id))?.missionId ?? null,
    );
  }

  email(userId: string): Promise<string | null> {
    return memo(this.emails, userId, async () =>
      userId === BOOTSTRAP_ACTOR_ID
        ? null
        : ((await this.store.users.getById(userId))?.email ?? null),
    );
  }

  group(id: string): Promise<string | null> {
    return memo(
      this.labels,
      `group:${id}`,
      async () => (await this.store.groups.getById(id))?.name ?? null,
    );
  }

  /** A resource of an account, as its owner named it; else its ref. */
  resource(id: string): Promise<string | null> {
    return memo(this.labels, `resource:${id}`, async () => {
      const resource = await this.store.connections.getResource(id);
      return resource ? resource.displayName || resource.ref : null;
    });
  }

  /** The declared name of an OAuth client, by its row id (`oauth_clients.id`). */
  client(id: string): Promise<string | null> {
    return memo(
      this.labels,
      `oauth-client:${id}`,
      async () => (await this.store.delegations.getClient(id))?.name ?? null,
    );
  }

  /** "<connection> → <the user's email or the group's name>". */
  share(id: string): Promise<string | null> {
    return memo(this.labels, `share:${id}`, async () => {
      const share = await this.store.shares.getById(id);
      if (!share) return null;
      const connection = (await this.connection(share.connectionId)).display_name;
      const target =
        share.target.kind === 'user'
          ? await this.email(share.target.id)
          : await this.group(share.target.id);
      return `${connection ?? share.connectionId} → ${target ?? share.target.id}`;
    });
  }

  /**
   * What a person answered, in the words of the pages: "the limit of
   * <mission>" (a claim: a limit that was reached), "a call of <mission>" (an
   * approval request: a call that asked first). The protocol's kinds stay in
   * the record itself (`object.type`, the act).
   */
  request(id: string): Promise<string | null> {
    return memo(this.labels, `request:${id}`, async () => {
      const request = await this.store.requests.getById(id);
      if (!request) return null;
      const what =
        request.kind === 'permission'
          ? 'permissions for'
          : request.kind === 'approval'
            ? 'a call of'
            : 'the limit of';
      const mission = (await this.mission(request.missionId)).name;
      return `${what} ${mission ?? request.missionId}`;
    });
  }

  /** The name of the client the delegation was given to. */
  delegation(id: string): Promise<string | null> {
    return memo(this.labels, `delegation:${id}`, async () => {
      const delegation = await this.store.delegations.getById(id);
      return delegation ? this.client(delegation.clientId) : null;
    });
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

/**
 * What the viewer is to an entry: decided from the mission and the connection
 * as they are now, like the scope that gave them the entry.
 */
async function standingOf(
  record: AuditRecord,
  names: NameCache,
  viewer: AuditViewer,
): Promise<AuditStanding> {
  if (record.kind === 'call') {
    return standingOn(
      viewer,
      await names.missionRecord(record.mission_id),
      record.connection_id ? await names.connectionRecord(record.connection_id) : null,
    );
  }
  const { type, id } = record.object;
  const missionId =
    type === 'mission' ? id : type === 'request' ? await names.missionOfRequest(id) : null;
  return standingOn(
    viewer,
    missionId === null ? null : await names.missionRecord(missionId),
    type === 'connection' ? await names.connectionRecord(id) : null,
  );
}

async function toView(
  record: AuditRecord,
  names: NameCache,
  viewer: AuditViewer,
): Promise<AuditEntryView> {
  const standing = await standingOf(record, names, viewer);
  if (record.kind === 'call') {
    return {
      kind: 'call',
      id: record.id,
      ts: record.ts,
      mission: await names.mission(record.mission_id),
      token: await tokenRef(record, names),
      connection: record.connection_id ? await names.connection(record.connection_id) : null,
      resource_ref: record.resource_ref,
      tool: record.tool,
      arguments_hash: standing === 'responsible' ? record.arguments_hash : null,
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
    before: withoutArguments(record.before, standing),
    after: withoutArguments(record.after, standing),
    delegated_client_id: record.delegated_client_id,
  };
}

async function tokenRef(
  record: Extract<AuditRecord, { kind: 'call' }>,
  names: NameCache,
): Promise<AuditTokenRef | null> {
  const { token_kind: kind, token_holder: key } = record;
  if (kind === null || key === null) return null;
  if (kind === 'named') return { kind, key, label: key };
  return { kind, key, label: (await names.email(key)) ?? key };
}

async function objectLabel(
  object: { readonly type: AdminObjectType; readonly id: string },
  names: NameCache,
): Promise<string | null> {
  // One case per object type and no `default`: a new type does not compile until it
  // says what names it. The scope is the store's: a label only names an object whose
  // entry the viewer was already given.
  switch (object.type) {
    case 'mission':
      return (await names.mission(object.id)).name;
    case 'connection':
      return (await names.connection(object.id)).display_name;
    case 'share':
      return names.share(object.id);
    case 'group':
      return names.group(object.id);
    case 'oauth-client':
      return names.client(object.id);
    case 'user':
      return names.email(object.id);
    case 'request':
      return names.request(object.id);
    case 'delegation':
      return names.delegation(object.id);
    case 'instance-config':
      // The id is the name: `idp`, `telemetry`, `bootstrap`; `provider-app:<id>` in entries of earlier builds.
      return null;
  }
}

async function actorView(userId: string, names: NameCache): Promise<AuditAdminView['actor']> {
  if (userId === BOOTSTRAP_ACTOR_ID)
    return { id: userId, email: null, label: BOOTSTRAP_ACTOR_LABEL };
  if (userId === CONFIGURATION_ACTOR_ID)
    return { id: userId, email: null, label: CONFIGURATION_ACTOR_LABEL };
  if (userId === RECOVERY_ACTOR_ID) return { id: userId, email: null, label: RECOVERY_ACTOR_LABEL };
  if (userId === SCHEDULE_ACTOR_ID) return { id: userId, email: null, label: SCHEDULE_ACTOR_LABEL };
  const email = await names.email(userId);
  return { id: userId, email, label: email ?? userId };
}
