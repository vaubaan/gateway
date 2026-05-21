import { type PubKeyEntry } from './types.js';

export interface DefaultRecipientsInput {
  readonly orgMembers: ReadonlyArray<PubKeyEntry>;
  readonly runner?: PubKeyEntry;
  readonly isOrgAdminResource: boolean;
}

/**
 * Pure computation of the default recipient list for a Resource Access
 * bundle. Spec §4.4:
 *
 *     default_recipients = {org members} ∪ ({runner} if !org-admin else ∅)
 *
 * No I/O, no sodium. Callers feed the public keys they already hold;
 * this function only enforces the org-admin / runner gate.
 */
export function defaultRecipients(input: DefaultRecipientsInput): ReadonlyArray<PubKeyEntry> {
  const { orgMembers, runner, isOrgAdminResource } = input;
  if (runner && !isOrgAdminResource) {
    return [...orgMembers, runner];
  }
  return [...orgMembers];
}
