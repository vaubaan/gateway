import Link from 'next/link';

import { Banner } from '@/components/ui';

/**
 * What every page that needs an identified user renders for the bootstrap
 * operator (`currentUser()` answered `null`): missions, connections and
 * requests always have an identified human behind them (spec §0 "Group"), so
 * the bootstrap token configures the instance and owns nothing.
 */
export function NeedsUser() {
  return (
    <Banner tone="warning" title="Sign in through the identity provider">
      Missions, connections and requests belong to an identified user: the bootstrap token
      configures the instance, it owns none of them. Finish the identity provider under{' '}
      <Link href="/admin/identity-provider">Administration</Link>, then sign in.
    </Banner>
  );
}
