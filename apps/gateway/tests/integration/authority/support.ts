/**
 * The rig of the authority integration tests: the execution instance (real
 * composition root on the `:memory:` store, the Depot fixture plugin, Ada
 * owning the Depot connection) plus what sharing needs — a second user, an
 * operator, missions issued by anyone, and the admin entries written.
 */
import type { AdminAuditEntry } from '@vaubaan/gateway-core';
import type { MissionPolicyEntry } from '@vaubaan/shared';

import type { Actor } from '../../../src/server/connections';
import {
  DEPOT,
  executionInstance,
  line,
  type ExecutionInstance,
  type ExecutionInstanceOptions,
  type IssuedMission,
} from '../../../src/server/execution/testing';
import type { IssueResult } from '../../../src/server/missions';
import type { MissionStatus, UserRecord } from '../../../src/server/store/types';

export const OPERATOR_EMAIL = 'ops@example.com';
export const READ = `${DEPOT}.read`;
export const WRITE_STAGING = `${DEPOT}[staging].write`;
export const WRITE_PROD = `${DEPOT}[prod].write`;
export const PURGE = `${DEPOT}.purge`;
export const PROFILE = `${DEPOT}.profile`;

export interface AuthorityRig extends ExecutionInstance {
  readonly bob: UserRecord;
  readonly operator: UserRecord;
  /** The user with their *current* groups, as a page or a handler builds it. */
  actor(user: UserRecord): Promise<Actor>;
  /** The raw outcome of an issuance on the Depot connection, refused or not. */
  tryIssue(
    user: UserRecord,
    riskIds: readonly string[],
    name?: string,
    entryOf?: (riskId: string) => MissionPolicyEntry,
  ): Promise<IssueResult>;
  /** An issuance that must succeed. */
  issueFor(
    user: UserRecord,
    riskIds: readonly string[],
    name?: string,
    entryOf?: (riskId: string) => MissionPolicyEntry,
  ): Promise<IssuedMission>;
  statusOf(mission: IssuedMission): Promise<MissionStatus | undefined>;
  adminEntries(act: AdminAuditEntry['act']): Promise<AdminAuditEntry[]>;
  /** `tools/call depot__read_item` on the unlabelled space: touches `depot.read`. */
  read(mission: IssuedMission): ReturnType<ExecutionInstance['call']>;
}

export async function authorityRig(options: ExecutionInstanceOptions = {}): Promise<AuthorityRig> {
  const instance = await executionInstance({
    ...options,
    env: { VAUBAAN_ADMIN_EMAILS: OPERATOR_EMAIL, ...options.env },
  });
  const { root } = instance;
  const bob = await root.store.users.upsertFromIdp({
    subject: 'idp|bob',
    email: 'bob@example.com',
    displayName: 'Bob',
  });
  const operator = await root.store.users.upsertFromIdp({
    subject: 'idp|ops',
    email: OPERATOR_EMAIL,
    displayName: 'Ops',
  });

  const rig: AuthorityRig = {
    ...instance,
    bob,
    operator,
    async actor(user) {
      return { user, groups: await root.store.groups.groupsOf(user.id) };
    },
    tryIssue(user, riskIds, name = 'Shared mission', entryOf = (id) => line(id)) {
      const policy: MissionPolicyEntry[] = riskIds.map(entryOf);
      return root.missions.service.issue(user, {
        name,
        connections: [
          { connection_id: instance.connection.id, resources: { scope: 'all' }, policy },
        ],
        period: { kind: 'recurring', length_seconds: 86_400 },
        expires_at: null,
      });
    },
    async issueFor(user, riskIds, name, entryOf) {
      const result = await rig.tryIssue(user, riskIds, name, entryOf);
      if (!result.ok) throw new Error(`issue refused: ${JSON.stringify(result)}`);
      return { mission: result.mission, token: result.token.secret, prefix: result.token.prefix };
    },
    async statusOf(mission) {
      return (await root.store.missions.getById(mission.mission.id))?.status;
    },
    async adminEntries(act) {
      const entries = await root.store.audit.list({ kind: 'admin' });
      return entries.filter(
        (e): e is typeof e & AdminAuditEntry => e.kind === 'admin' && e.act === act,
      );
    },
    read(mission) {
      return instance.call(mission, `${DEPOT}__read_item`, { space: 'scratch' });
    },
  };
  return rig;
}
