import type { AccountRecord } from '../store/types';

/** A `host` account: the kind its connect stored (`metadata.credential_kind`). */
export function isHostAccount(account: Pick<AccountRecord, 'metadata'>): boolean {
  return account.metadata?.credential_kind === 'host';
}
