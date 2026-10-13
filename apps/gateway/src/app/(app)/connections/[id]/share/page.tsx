/**
 * `/connections/<id>/share` — the Share dialog of one connection (spec §4.2
 * "Connections", §7.3): a target, a one-line summary, and the checklist of
 * the catalog's risks, each explained. Owner only: anyone else reads "not found". With
 * `?share=<id>` the dialog opens on the restriction that target already
 * holds; submitting replaces it.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import styles from '@/components/connections/connections.module.css';
import { NoticeBanner } from '@/components/connections/parts';
import { Banner, Card, CardBody, Stack, Help } from '@/components/ui';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/connections/session';
import { connectionPath, CONNECTIONS_PATH } from '@/server/connections';
import { isShareError, SHARE_ERROR_MESSAGES, type ShareContext } from '@/server/shares';

import { ShareForm, type ShareFormInitial } from './share-form';

export const dynamic = 'force-dynamic';

export default async function SharePage({
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
  let context: ShareContext;
  try {
    context = await root.shares.service.contextFor(actor, id);
  } catch (err) {
    if (isShareError(err, 'not-found')) notFound();
    throw err;
  }
  const query = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, query);
  const { connection } = context;
  const base = connectionPath(connection.id);
  const editingId = firstParam(query.share);
  const editing = context.shares.find((view) => view.share.id === editingId) ?? null;

  return (
    <Stack gap="var(--space-6)">
      <div>
        <p className={styles.muted}>
          <Link href={CONNECTIONS_PATH}>Connections</Link> /{' '}
          <Link href={base}>{connection.displayName}</Link> / Share
        </p>
        <h1>Share {connection.displayName}</h1>
        <Help
          id="share-dialog"
          line={`A share lets its target accept, in their own missions, some of the risks of this ${context.providerLabel} connection, and nothing beyond.`}
        >
          <p>
            Quantities, approval gates and the resources a mission touches are chosen by whoever
            issues the mission. The target cannot share further.
          </p>
        </Help>
      </div>

      <NoticeBanner notice={notice} />

      {context.unshareable ? (
        <Banner tone="warning" title="This connection cannot be shared">
          {SHARE_ERROR_MESSAGES[context.unshareable]}
        </Banner>
      ) : (
        <Card>
          <CardBody>
            <ShareForm
              action={`${base}/shares`}
              cancelHref={base}
              risks={context.risks}
              groups={context.groups.map((group) => ({ id: group.id, name: group.name }))}
              labelling={context.labelling}
              provider={{ id: connection.provider, label: context.providerLabel }}
              initial={initialOf(editing, context)}
            />
          </CardBody>
        </Card>
      )}
    </Stack>
  );
}

function initialOf(
  editing: ShareContext['shares'][number] | null,
  context: ShareContext,
): ShareFormInitial {
  const firstGroup = context.groups[0]?.id ?? '';
  if (!editing) {
    return { targetKind: 'user', email: '', groupId: firstGroup, selected: [], editing: false };
  }
  const { target, restriction } = editing.share;
  return {
    targetKind: target.kind,
    email: target.kind === 'user' ? editing.targetLabel : '',
    groupId: target.kind === 'group' ? target.id : firstGroup,
    selected: restriction,
    editing: true,
  };
}
