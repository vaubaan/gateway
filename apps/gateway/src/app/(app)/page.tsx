/**
 * `/` — "Now", the one home of a signed-in person: the brand of the shell and
 * the sign-in both lead here (spec §4.2).
 *
 * What is waiting for me, what is running, what just happened. Someone who
 * created no mission yet reads what the product is and the steps to the first
 * account and the first mission instead. A visitor without a session is sent
 * to the sign-in by `currentUser()`; the bootstrap token owns no mission and
 * reads where to go.
 *
 * The page reads one model (`readNow`, `server/now`) and decides nothing.
 */
import { NeedsUser } from '@/components/auth/NeedsUser';
import { currentUser } from '@/lib/auth/session';
import { nowDepsOf, readNow, readSetup, setupDepsOf } from '@/server/now';

import { FirstRun } from './_now/first-run';
import { NowView } from './_now/now-view';

export const dynamic = 'force-dynamic';

/** "Dan Kim" → "Dan": how a welcome addresses someone. */
function firstName(displayName: string | null): string | null {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : null;
}

export default async function HomePage() {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { root, user, principal } = session;
  const view = await readNow(nowDepsOf(root), { user, groups: principal.groups });

  // Something waiting is answered first, whoever the person is.
  if (view.first_run && view.waiting.length === 0) {
    const setup = principal.isOperator ? await readSetup(setupDepsOf(root)) : null;
    return <FirstRun view={view} name={firstName(user.displayName)} setup={setup} />;
  }
  return <NowView view={view} viewerId={user.id} />;
}
