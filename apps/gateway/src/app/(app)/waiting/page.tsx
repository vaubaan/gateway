/**
 * `/waiting` — "Waiting for you": what the missions I created ask of me (spec
 * §4.2 "Request inbox", §3.4 "the creator also finds it in their inbox without
 * anyone forwarding anything"). One list, the oldest request open beside it;
 * when nothing waits, one sentence that says so.
 */
import { NeedsUser } from '@/components/auth/NeedsUser';
import { currentUser } from '@/lib/auth/session';

import { levelsOf, loadInbox, NothingWaits, WaitingFrame } from './frame';

export const dynamic = 'force-dynamic';

export default async function WaitingPage() {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { root, user } = session;
  const inbox = await loadInbox(root, user);
  const [oldest] = inbox.items;
  if (!oldest) return <NothingWaits inbox={inbox} />;

  const result = await root.requests.service.view(user, oldest.request.id);
  // Listed a moment ago and gone since (it expired, the mission was deleted): nothing waits.
  if (result.outcome !== 'ok') return <NothingWaits inbox={{ ...inbox, items: [] }} />;
  return (
    <WaitingFrame
      inbox={inbox}
      viewerId={user.id}
      view={result.view}
      levels={levelsOf(root, result.view)}
    />
  );
}
