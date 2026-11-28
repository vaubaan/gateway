/**
 * The audit entry of an act on an account as a whole (created, reconnected, revoked,
 * transferred, reassigned): one shape for every use case that writes one, the account's
 * service, name, status and owner after the act.
 */
import { toIso } from '../store/clock';
import type { AccountRecord } from '../store/types';
import type { AccountServiceDeps } from './account-views';

export type AccountAct =
  | 'account-created'
  | 'account-reconnected'
  | 'account-revoked'
  | 'account-transferred'
  | 'account-reassigned';

export async function auditAccountAct(
  deps: Pick<AccountServiceDeps, 'audit' | 'clock'>,
  actorId: string,
  act: AccountAct,
  account: AccountRecord,
  before: unknown,
  extra: Readonly<Record<string, string>> = {},
): Promise<void> {
  await deps.audit.write({
    kind: 'admin',
    ts: toIso(deps.clock.now()),
    user_id: actorId,
    act,
    object: { type: 'account', id: account.id },
    before,
    after: {
      service: account.service,
      display_name: account.displayName,
      status: account.status,
      owner: account.owner,
      ...extra,
    },
  });
}
