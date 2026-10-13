/**
 * `/waiting/<id>` — one request, as the creator of its mission reads and
 * answers it: an approval (spec §3.5) or a limit that was reached (spec §3.4).
 * The list of what else is open stays beside it.
 *
 * Reached from the inbox, from the home, or from the forwarded URL `/r/<id>`
 * once its gate has let the creator through. A request that is not open any
 * more shows what became of it. Anyone else reads one sentence and nothing
 * about the request.
 */
import { NeedsUser } from '@/components/auth/NeedsUser';
import { ButtonLink, Callout } from '@/components/ui';
import { currentUser } from '@/lib/auth/session';
import { PAGES, ROUTES } from '@/lib/vocabulary';
import { ADDRESSED_TO_CREATOR } from '@/server/requests';

import { levelsOf, loadInbox, WaitingFrame, WaitingHeader } from '../frame';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ decided?: string; problem?: string }>;
}

export default async function RequestPage({ params, searchParams }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { root, user } = session;
  const { id } = await params;
  const result = await root.requests.service.view(user, id);
  if (result.outcome !== 'ok') {
    // Not the creator, or no such request: one answer, and nothing about the request.
    return (
      <>
        <WaitingHeader open={0} />
        <Callout
          tone="warn"
          title="Not yours to answer"
          testId="request-forbidden"
          action={
            <ButtonLink href={ROUTES.waiting} size="sm">
              {PAGES.waiting.title}
            </ButtonLink>
          }
        >
          {ADDRESSED_TO_CREATOR}
        </Callout>
      </>
    );
  }
  const { decided, problem } = await searchParams;
  return (
    <WaitingFrame
      inbox={await loadInbox(root, user)}
      viewerId={user.id}
      view={result.view}
      levels={levelsOf(root, result.view)}
      decided={Boolean(decided)}
      problem={problem ?? null}
    />
  );
}
