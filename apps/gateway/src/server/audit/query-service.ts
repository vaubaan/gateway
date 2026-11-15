/**
 * `AuditQueryService` — what the Audit page reads (spec §4.2 "Audit", §8).
 *
 * Visibility (docs/spec/vaubaan-gateway.md): a user sees the
 * entries about the missions they created, about the missions they are a
 * member of, and about the accounts they or their groups own; an operator
 * sees every entry, calls included. The scope is applied in the store's
 * query, before filters and paging, so a filter can only narrow it.
 *
 * Arguments: an audit entry never holds them (`arguments_hash` only, spec §6
 * "no secret in logs"), and the views built here are explicit field lists, so
 * nothing else of a record reaches the page. The fingerprint itself is the
 * one trace of the arguments, and it can be guessed for low-entropy ones: it
 * is shown to whoever answers for the call — the creator of its mission, an
 * owner of its account — and to nobody who reads the entry only as a
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
  DISCOVERY_ACTOR_ID,
  DISCOVERY_ACTOR_LABEL,
  type AdminAct,
  type AdminObjectType,
  type AuditDecision,
} from '@vaubaan/gateway-core';
import type { MissionTokenKind, Principal, RefusalCode, RiskId } from '@vaubaan/shared';

import type { AuditCursor, AuditRecord, AuditScope, AuditSearch, ShareKey, Store } from '../store';
import type { AccountRecord, MissionRecord } from '../store/types';
import type { AuditFilters } from './filters';
import { keysetOf, pageOf, type PagePosition } from './paging';
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

export interface AuditAccountRef {
  readonly id: string;
  readonly display_name: string | null;
  readonly service: string | null;
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
  readonly account: AuditAccountRef | null;
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
     * group name, an account's display name, a client's declared name, "the
     * account → who it is shared with" for a share, "the limit of <mission>"
     * or "a call of <mission>" for a request. `null` for an object that is gone, and for `instance-config`,
     * whose id is its name.
     */
    readonly label: string | null;
  };
  readonly before: unknown;
  readonly after: unknown;
  /**
   * The mission whose key made the act through the `vaubaan` plugin, with its name
   * while it exists; `null` for an act done in the interface.
   */
  readonly via_mission: { readonly id: string; readonly name: string | null } | null;
  /** History: the app that acted through the retired management door. */
  readonly delegated_client_id: string | null;
}

export type AuditEntryView = AuditCallView | AuditAdminView;

export interface AuditPage {
  readonly entries: readonly AuditEntryView[];
  /** Position of the older page (its `cursor`); `null` on the last one. */
  readonly older: AuditCursor | null;
  /** Position of the newer page (its `after`); `null` on the first one. */
  readonly newer: AuditCursor | null;
}

export interface AuditFilterOptions {
  readonly missions: readonly { readonly id: string; readonly name: string }[];
  readonly accounts: readonly { readonly id: string; readonly label: string }[];
}

export interface AuditQueryDeps {
  readonly store: Pick<
    Store,
    'audit' | 'missions' | 'accounts' | 'users' | 'shares' | 'groups' | 'requests'
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
      accountOwners: [],
      allAdmin: true,
      allCalls: false,
    };
  }
  return {
    missionCreatorUserId: viewer.user.id,
    missionMemberUserId: viewer.user.id,
    accountOwners: ownersOf(viewer),
    allAdmin: viewer.isOperator,
    allCalls: viewer.isOperator,
  };
}

/**
 * What a viewer is to the mission and the account of an entry they were
 * given: `responsible` when they created the mission or own the account —
 * they answer for the call —, `reader` otherwise (a member of the mission, an
 * operator). A reader is shown everything but the argument fingerprint.
 */
export type AuditStanding = 'responsible' | 'reader';

export function standingOn(
  viewer: AuditViewer,
  mission: { readonly creatorUserId: string } | null,
  account: { readonly owner: Principal } | null,
): AuditStanding {
  if (viewer.kind !== 'user') return 'reader';
  if (mission !== null && mission.creatorUserId === viewer.user.id) return 'responsible';
  if (account !== null) {
    const { owner } = account;
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

  /**
   * One page, newest first: the newest lines, or the page older or newer than a
   * position (`paging.ts`) — the `older` / `newer` of the page next to it.
   */
  async search(
    viewer: AuditViewer,
    filters: AuditFilters,
    position: PagePosition | null = null,
    pageSize: number = AUDIT_PAGE_SIZE,
  ): Promise<AuditPage> {
    const userIds = filters.user === null ? undefined : await this.userIdsOf(filters.user);
    const tokenHolders =
      filters.tokenHolder === null ? undefined : await this.holdersOf(filters.tokenHolder);
    // One more than the page: its presence says there is a further page that way.
    const records = await this.deps.store.audit.search({
      scope: scopeOf(viewer),
      limit: pageSize + 1,
      ...(filters.missionId ? { missionId: filters.missionId } : {}),
      ...(userIds ? { userIds } : {}),
      ...(filters.accountId ? { accountId: filters.accountId } : {}),
      ...(filters.tool ? { tool: filters.tool } : {}),
      ...(filters.decision ? { decision: filters.decision } : {}),
      ...(filters.agentLabel ? { agentLabel: filters.agentLabel } : {}),
      ...(tokenHolders ? { tokenHolders } : {}),
      ...(filters.kind ? { kind: filters.kind } : {}),
      ...(filters.since ? { since: filters.since } : {}),
      ...(filters.until ? { until: filters.until } : {}),
      ...keysetOf(position),
    });
    const { shown, older, newer } = pageOf(records, pageSize, position);
    const names = new NameCache(this.deps.store);
    const entries: AuditEntryView[] = [];
    for (const record of shown) entries.push(await toView(record, names, viewer));
    return { entries, older, newer };
  }

  /**
   * The missions and accounts the viewer can filter on: the missions they
   * created or are a member of, the accounts they own. An operator reads
   * every entry but is offered their own here: the list is a convenience, and
   * any mission id can be typed in the address.
   */
  async filterOptions(viewer: AuditViewer): Promise<AuditFilterOptions> {
    if (viewer.kind === 'bootstrap') return { missions: [], accounts: [] };
    const created = await this.deps.store.missions.listForCreator(viewer.user.id);
    const shared = await this.deps.store.missions.listForMember(viewer.user.id);
    const missions = [...created, ...shared];
    const accounts = await this.deps.store.accounts.listOwnedBy(ownersOf(viewer));
    return {
      missions: missions.map((m) => ({ id: m.id, name: m.name })).reverse(),
      accounts: accounts.map((c) => ({
        id: c.id,
        label: `${c.service} — ${c.displayName}`,
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
        if (key === 'account_id' && typeof inner === 'string') {
          put(inner, (await names.account(inner)).display_name);
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

  private userIdsOf(typed: string): Promise<string[]> {
    return userIdsOf(this.deps.store.users, typed);
  }

  private holdersOf(typed: string): Promise<NonNullable<AuditSearch['tokenHolders']>> {
    return holdersOf(this.deps.store.users, typed);
  }
}

type UserLookup = Pick<Store['users'], 'findByEmail'>;

/**
 * The user filter as typed: an email address or a user id. An unknown value
 * yields no entry, exactly like a known user with none, so the filter does
 * not reveal who has an account.
 */
async function userIdsOf(users: UserLookup, typed: string): Promise<string[]> {
  if (typed.includes('@')) return (await users.findByEmail(typed)).map((u) => u.id);
  return [typed];
}

/**
 * The holder filter as typed, for the Record and the Timeline alike. The exact
 * form (`member:<user id>`, `named:<name>`) is taken as it is. Otherwise an
 * email names a member — a token name never contains `@` (`parseTokenName`) —
 * and anything else the name of a named token. An unknown email yields
 * nothing, like a known member with no call.
 */
export async function holdersOf(
  users: UserLookup,
  typed: string,
): Promise<NonNullable<AuditSearch['tokenHolders']>> {
  const exact = parseHolderParam(typed);
  if (exact) return { kind: exact.kind, holders: [exact.key] };
  if (typed.includes('@')) return { kind: 'member', holders: await userIdsOf(users, typed) };
  return { kind: 'named', holders: [typed] };
}

/** Names behind the ids of one page, looked up once each. */
class NameCache {
  private readonly missions = new Map<string, Promise<AuditMissionRef>>();
  private readonly accounts = new Map<string, Promise<AuditAccountRef>>();
  private readonly missionRecords = new Map<string, Promise<MissionRecord | null>>();
  private readonly accountRecords = new Map<string, Promise<AccountRecord | null>>();
  private readonly emails = new Map<string, Promise<string | null>>();
  private readonly labels = new Map<string, Promise<string | null>>();

  constructor(private readonly store: AuditQueryDeps['store']) {}

  /** The mission row, or `null` when it no longer exists. */
  missionRecord(id: string): Promise<MissionRecord | null> {
    return memo(this.missionRecords, id, () => this.store.missions.getById(id));
  }

  /** The account row, or `null` when it no longer exists. */
  accountRecord(id: string): Promise<AccountRecord | null> {
    return memo(this.accountRecords, id, () => this.store.accounts.getById(id));
  }

  mission(id: string): Promise<AuditMissionRef> {
    return memo(this.missions, id, async () => {
      const mission = await this.missionRecord(id);
      if (!mission) return { id, name: null, creator_email: null };
      return { id, name: mission.name, creator_email: await this.email(mission.creatorUserId) };
    });
  }

  account(id: string): Promise<AuditAccountRef> {
    return memo(this.accounts, id, async () => {
      const account = await this.accountRecord(id);
      return {
        id,
        display_name: account?.displayName ?? null,
        service: account?.service ?? null,
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
      const resource = await this.store.accounts.getResource(id);
      return resource ? resource.displayName || resource.ref : null;
    });
  }

  /** "<account> → <the user's email or the group's name>". */
  share(key: ShareKey): Promise<string | null> {
    return memo(this.labels, `share:${key.accountId}:${key.shareId}`, async () => {
      const share = await this.store.shares.get(key);
      if (!share) return null;
      const account = (await this.account(share.accountId)).display_name;
      const target =
        share.target.kind === 'user'
          ? await this.email(share.target.id)
          : await this.group(share.target.id);
      return `${account ?? share.accountId} → ${target ?? share.target.id}`;
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
 * What the viewer is to an entry: decided from the mission and the account
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
      record.account_id ? await names.accountRecord(record.account_id) : null,
    );
  }
  const { type, id } = record.object;
  const missionId =
    type === 'mission' ? id : type === 'request' ? await names.missionOfRequest(id) : null;
  return standingOn(
    viewer,
    missionId === null ? null : await names.missionRecord(missionId),
    type === 'account' ? await names.accountRecord(id) : null,
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
      account: record.account_id ? await names.account(record.account_id) : null,
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
      label: await objectLabel(record, names),
    },
    before: withoutArguments(record.before, standing),
    after: withoutArguments(record.after, standing),
    via_mission: record.via_mission_id
      ? { id: record.via_mission_id, name: (await names.mission(record.via_mission_id)).name }
      : null,
    delegated_client_id: record.delegated_client_id ?? null,
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

/**
 * The account a share entry names in its `before` or `after` (every share entry
 * carries it): a share is read with its account, never by its id alone.
 */
function shareAccountOf(record: {
  readonly before: unknown;
  readonly after: unknown;
}): string | null {
  for (const side of [record.after, record.before]) {
    if (typeof side !== 'object' || side === null || !('account_id' in side)) continue;
    if (typeof side.account_id === 'string') return side.account_id;
  }
  return null;
}

async function objectLabel(
  record: {
    readonly object: { readonly type: AdminObjectType; readonly id: string };
    readonly before: unknown;
    readonly after: unknown;
  },
  names: NameCache,
): Promise<string | null> {
  const { object } = record;
  // One case per object type and no `default`: a new type does not compile until it
  // says what names it. The scope is the store's: a label only names an object whose
  // entry the viewer was already given.
  switch (object.type) {
    case 'mission':
      return (await names.mission(object.id)).name;
    case 'account':
      return (await names.account(object.id)).display_name;
    case 'share': {
      const accountId = shareAccountOf(record);
      return accountId === null ? null : names.share({ accountId, shareId: object.id });
    }
    case 'group':
      return names.group(object.id);
    case 'user':
      return names.email(object.id);
    case 'request':
      return names.request(object.id);
    // History: the clients and delegations of the retired management door are gone
    // with their tables (migration 0035); their entries show the id.
    case 'oauth-client':
    case 'delegation':
    case 'instance-config':
      // The id is the name: `idp`, `telemetry`, `bootstrap`; `provider-app:<id>` in entries of earlier builds (the OAuth clients per service, retired).
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
  if (userId === DISCOVERY_ACTOR_ID)
    return { id: userId, email: null, label: DISCOVERY_ACTOR_LABEL };
  const email = await names.email(userId);
  return { id: userId, email, label: email ?? userId };
}
