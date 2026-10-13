/**
 * `/` — the home of a signed-in person. One home: the brand of the shell and
 * the sign-in both lead here.
 *
 * Until the "Now" page of the redesign lands (what waits for you, what is
 * running), the home shows the missions list inside the shell. A visitor
 * without a session is sent to the sign-in by `currentUser()`.
 */
import { NeedsUser } from '@/components/auth/NeedsUser';
import { currentUser } from '@/lib/auth/session';

import MissionsPage from './missions/page';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  return <MissionsPage />;
}
