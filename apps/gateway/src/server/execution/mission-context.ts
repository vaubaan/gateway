/**
 * Mission context — the pipeline's read-only view of an authenticated mission
 * (`@vaubaan/gateway-core` `MissionContext`), loaded from the store on every
 * request.
 *
 * Spec §3.1 "Resource selection": a mission names, per account, the
 * resources it may touch. What it reaches is `reachedResources`
 * (`store/mission-reach.ts`), the rule the mission page and the bootstrap kit
 * read too:
 *
 * - a mission reaches exactly the rows whose id its resource sets store, never the
 *   account's live list: a resource found later is reached once a set with
 *   future on took it into its list (ADR
 *   resource-set-is-one-environment-with-optional-future-resources; handbook
 *   missions);
 *
 * Either way a *stale* resource (the last discovery no longer returned it) is
 * left out of `resources`: the mission may not touch it any more, and the
 * resource stage refuses a call that cites it with `resource-not-in-mission`.
 * A *hidden* one selected on purpose stays: hiding is a listing preference of
 * the owner, not a withdrawal.
 *
 * A *self* resource (one of the instance's own hosting, `config.selfResources`,
 * SEC 2026-10-15 H1) is left out too, whatever the mission stored: a policy
 * issued before the instance knew it, or written by hand, still cannot reach
 * it. The plugin then binds no call to it, and the resource stage refuses a
 * call that cites it with `resource-not-in-mission`.
 *
 * `resources` is also what a plugin's `execute` receives (`ctx.resources`): a
 * "list" tool that filters its answer to the mission (`fly__list_apps`,
 * `cloudflare_dns__list_zones`) sees the same lists.
 *
 * An account whose part of the mission is lost (revoked, or the creator's
 * access to it withdrawn: `MissionGrounds`) stays in `accounts`, marked
 * `lost`: the pipeline refuses its calls `account-revoked` and `tools/list`
 * leaves its tools out, while the mission serves through the others.
 *
 * Nothing here is cached: the reads are local (SQLite) and a revocation, an
 * expired account or a stale resource must be seen by the next call.
 */
import type {
  AuthenticatedToken,
  AccountOwner,
  MissionAccount,
  MissionContext,
  MissionResource,
  MissionResourceSet,
} from '@vaubaan/gateway-core';

import { periodOf, policyEntryOf } from '../budget';
import { isSelfResource, type SelfResource } from '../config';
import {
  accountCredentialKind,
  accountOwnerOf,
  accountPublicFields,
  accountSummaryOf,
} from '../accounts/mapping';
import type { LostPart } from '../authority';
import type { Store } from '../store';
import { reachedResourcesBySet, takesFutureResources } from '../store/mission-reach';
import type { AccountRecord, AccountResourceRecord, MissionRecord } from '../store/types';

export type MissionContextStore = Pick<Store, 'accounts' | 'users' | 'groups' | 'sessions'>;

/** The shared `AccountResource` of a stored row — what `classify` and `execute` receive. */
export function missionResourceOf(
  account: Pick<AccountRecord, 'id' | 'service'>,
  record: AccountResourceRecord,
): MissionResource {
  return {
    id: record.id,
    account_id: account.id,
    service: account.service,
    ref: record.ref,
    env: record.env,
    displayName: record.displayName,
    discovered_at: record.discoveredAt,
    ...(record.metadata ? { metadata: record.metadata } : {}),
  };
}

/** What a refusal shows so a human can be contacted: the user's email or the group's name. */
async function ownerOf(
  store: Pick<Store, 'users' | 'groups'>,
  account: AccountRecord,
): Promise<AccountOwner> {
  const { kind, id, name } = await accountOwnerOf(store, account);
  return { kind, id, display: name ?? `a ${kind} that no longer exists` };
}

/** The pipeline's period of a stored mission; the mapping lives in `budget/mapping.ts`. */
export { periodOf };

export async function loadMissionContext(
  store: MissionContextStore,
  mission: MissionRecord,
  /** The verified token and its holder (`MissionService.verifyToken`): who is calling. */
  token: AuthenticatedToken,
  /** The instance's own resources: never part of a mission's context. */
  selfResources: readonly SelfResource[],
  /** The accounts whose part of the mission is lost (`MissionGrounds.inspect`). */
  lost: readonly LostPart[] = [],
): Promise<MissionContext> {
  const accounts: MissionAccount[] = [];
  const resources: MissionResource[] = [];
  const resourceSets: MissionResourceSet[] = [];
  const lostOn = new Map(lost.map((part) => [part.accountId, part.cause] as const));

  for (const selection of mission.accounts) {
    const account = await store.accounts.getById(selection.accountId);
    // Accounts are never deleted (revocation keeps the row); a missing one
    // simply gives the mission nothing to call.
    if (!account) continue;
    const discovered = await store.accounts.listResources(account.id);
    const loss = lostOn.get(account.id);
    accounts.push({
      ...accountSummaryOf(account),
      owner: await ownerOf(store, account),
      credential_kind: accountCredentialKind(account, null),
      // What the classifier may cite of the account (a Fly organization): never a secret.
      public_fields: accountPublicFields(account),
      // Any resource it reaches, selected or not, stale or not: the credential still reaches it.
      hosts_instance: discovered.some((r) => isSelfResource(selfResources, account.service, r.ref)),
      ...(takesFutureResources(selection) ? { takes_future_resources: true } : {}),
      // A revoked account is lost whatever the grounds said: its status is final.
      ...(loss === 'access-withdrawn'
        ? { lost: 'access-withdrawn' as const }
        : loss || account.status === 'revoked'
          ? { lost: 'account-revoked' as const }
          : {}),
    });
    const bySet = reachedResourcesBySet(selection, discovered, (r) =>
      isSelfResource(selfResources, account.service, r.ref),
    );
    for (const set of selection.resourceSets) {
      const reached = bySet.get(set.id) ?? [];
      resourceSets.push({
        id: set.id,
        account_id: account.id,
        position: set.position,
        resource_ids: reached.map((r) => r.id),
      });
    }
    const reachedIds = new Set([...bySet.values()].flat().map((r) => r.id));
    for (const record of discovered) {
      if (reachedIds.has(record.id)) resources.push(missionResourceOf(account, record));
    }
  }

  const session = await store.sessions.getByMission(mission.id);
  return {
    mission: {
      id: mission.id,
      name: mission.name,
      status: mission.status,
      creator_id: mission.creatorUserId,
      expires_at: mission.expiresAt,
      period: periodOf(mission),
    },
    token: { id: token.id, prefix: token.prefix, holder: token.holder },
    accounts,
    resources,
    resource_sets: resourceSets,
    policy: mission.policy.map(policyEntryOf),
    session: session ? { id: session.id, started_at: session.createdAt } : null,
  };
}
