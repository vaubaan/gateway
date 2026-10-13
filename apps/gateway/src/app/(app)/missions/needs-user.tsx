import Link from 'next/link';

import { Banner } from '@/components/ui';

/**
 * Shown to the bootstrap operator: a mission always has an identified human
 * behind it (spec §0 "Group"), so the bootstrap token configures the instance
 * and issues nothing.
 */
export function NeedsUser() {
  return (
    <Banner tone="warning" title="Sign in through the identity provider">
      A mission is issued by an identified user: the bootstrap token configures the instance, it
      does not issue missions. Finish the identity provider under{' '}
      <Link href="/admin/identity-provider">Administration</Link>, then sign in.
    </Banner>
  );
}
