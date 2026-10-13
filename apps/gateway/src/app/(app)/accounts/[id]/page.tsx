/**
 * `/accounts/<id>` — one account, for its owner (spec §0 "Connection",
 * "Resource", "Share"; §4.2; §7.2; §7.3): who has access and up to what, what
 * it reaches, the missions that use it. Anyone else reads "not found".
 *
 * `?access=<share id>` unfolds the exact permissions of one access;
 * `?resource=<id>` opens the form of one resource (name, environment label,
 * hidden). The page itself is `account-view.tsx`, shared with the "Give
 * access" dialog (`share/page.tsx`).
 */
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/connections/session';
import { isConnectError } from '@/server/connections';

import { ACCOUNT_PARAMS, AccountView, loadAccount, type AccountData } from './account-view';

export const dynamic = 'force-dynamic';

export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: PageSearchParams;
}) {
  const session = await currentActor();
  if (!session) return <NeedsUser />;
  const { root, principal, actor } = session;
  const { id } = await params;
  let data: AccountData;
  try {
    data = await loadAccount(root, actor, id);
  } catch (err) {
    if (isConnectError(err, 'not-found')) notFound();
    throw err;
  }
  const query = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, query);

  return (
    <AccountView
      data={data}
      actor={actor}
      notice={notice}
      unfolded={{
        access: firstParam(query[ACCOUNT_PARAMS.access]),
        resource: firstParam(query[ACCOUNT_PARAMS.resource]),
      }}
    />
  );
}
