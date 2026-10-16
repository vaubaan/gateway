import Link from 'next/link';

import { Callout } from '@/components/ui';

/**
 * What every page that needs an identified person renders for whoever
 * installs the gateway with the install token (`currentUser()` answered
 * `null`): missions, accounts and what waits for someone always have an
 * identified person behind them (spec §0 "Group"), so the install token
 * configures the gateway and owns nothing.
 */
export function NeedsUser() {
  return (
    <Callout tone="warn" title="Sign in through your identity provider" testId="needs-user">
      Missions, accounts and what waits for an answer belong to a person who signed in. The install
      token configures this gateway and owns none of them: set up{' '}
      <Link href="/admin/identity-provider">Sign-in</Link> under Settings, then sign in.
    </Callout>
  );
}
