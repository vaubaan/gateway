/**
 * `/connections/<id>/share` — the Share dialog of one connection (spec §4.2
 * "Connections", §7.3): a target, a one-line summary, and the checklist of
 * the catalog's risks, each explained. Owner only: anyone else reads "not found". With
 * `?share=<id>` the dialog opens on the restriction that target already
 * holds; submitting replaces it.
 *
 * With `?confirm=<id>` the dialog comes back from a post that would bring
 * orphaned missions back (spec §2.3): it lists them, and the share is made by
 * the confirmation, which posts the same share with the missions it listed.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import styles from '@/components/connections/connections.module.css';
import { NoticeBanner } from '@/components/connections/parts';
import { Banner, Button, Card, CardBody, Stack, Help } from '@/components/ui';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/connections/session';
import { connectionPath, CONNECTIONS_PATH } from '@/server/connections';
import {
  isShareError,
  SHARE_CONFIRM_PARAM,
  SHARE_ERROR_MESSAGES,
  SHARE_FIELDS,
  ShareError,
  type PendingShare,
  type ShareContext,
  type ShareForecast,
} from '@/server/shares';

import { ShareForm, type ShareFormInitial } from './share-form';
import shareStyles from './share.module.css';

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
  // A share posted from this session that waits for its confirmation, read again now:
  // the list is the one of this instant, not the one of the post.
  const stored = await root.shares.pending.read(
    principal.sessionId,
    firstParam(query[SHARE_CONFIRM_PARAM]),
  );
  const pending = stored?.connectionId === connection.id ? stored : null;
  let forecast: ShareForecast | null = null;
  if (pending) {
    try {
      forecast = await root.shares.service.forecast(actor, connection.id, pending.input);
    } catch (err) {
      // What was asked is refused now (the target left, the connection was revoked):
      // the dialog opens as usual and the post says why.
      if (!(err instanceof ShareError)) throw err;
    }
  }
  const action = `${base}/shares`;

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

      {pending && forecast && forecast.restores.length > 0 && !context.unshareable && (
        <RestoreConfirmation
          action={action}
          cancelHref={base}
          pending={pending}
          forecast={forecast}
        />
      )}

      {context.unshareable ? (
        <Banner tone="warning" title="This connection cannot be shared">
          {SHARE_ERROR_MESSAGES[context.unshareable]}
        </Banner>
      ) : (
        <Card>
          <CardBody>
            <ShareForm
              action={action}
              cancelHref={base}
              risks={context.risks}
              groups={context.groups.map((group) => ({ id: group.id, name: group.name }))}
              labelling={context.labelling}
              provider={{ id: connection.provider, label: context.providerLabel }}
              initial={
                pending ? initialOfPending(pending, forecast, context) : initialOf(editing, context)
              }
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

/** The dialog as it was posted: the owner may change it instead of confirming. */
function initialOfPending(
  pending: PendingShare,
  forecast: ShareForecast | null,
  context: ShareContext,
): ShareFormInitial {
  const { target, riskIds } = pending.input;
  const firstGroup = context.groups[0]?.id ?? '';
  const held =
    forecast !== null && context.shares.some((view) => view.targetLabel === forecast.targetLabel);
  return {
    targetKind: target.kind,
    email: target.kind === 'user' ? target.email : '',
    groupId: target.kind === 'group' ? target.groupId : firstGroup,
    selected: forecast?.restriction ?? riskIds,
    editing: held,
  };
}

/**
 * What the share would bring back, and the one button that makes it. The form posts
 * the share exactly as it was asked, plus one `restore` value per mission listed here:
 * the server makes the share only when every mission it would restore is among them.
 */
function RestoreConfirmation({
  action,
  cancelHref,
  pending,
  forecast,
}: {
  action: string;
  cancelHref: string;
  pending: PendingShare;
  forecast: ShareForecast;
}) {
  const { target } = pending.input;
  const count = forecast.restores.length;
  const one = count === 1;
  return (
    <Banner
      tone="warning"
      title={`This share brings ${count} orphaned ${one ? 'mission' : 'missions'} back`}
    >
      <p>
        {one ? 'This mission was' : 'These missions were'} issued on this connection under an
        authority that was withdrawn since, and {one ? 'refuses' : 'refuse'} every call today. Once{' '}
        {forecast.targetLabel} holds this share, {one ? 'it serves' : 'they serve'} calls again at
        once, with the token {one ? 'its agent already holds' : 'their agents already hold'} and{' '}
        {one ? 'its' : 'their'} counters as they were.
      </p>
      <ul className={shareStyles.restores} data-testid="share-restores">
        {forecast.restores.map((mission) => (
          <li key={mission.id}>
            <strong>{mission.name}</strong>
            <span className={styles.muted}> — issued by {mission.creatorLabel}</span>
          </li>
        ))}
      </ul>
      <form method="post" action={action} className={shareStyles.confirm}>
        <input type="hidden" name={SHARE_FIELDS.targetKind} value={target.kind} />
        {target.kind === 'user' ? (
          <input type="hidden" name={SHARE_FIELDS.email} value={target.email} />
        ) : (
          <input type="hidden" name={SHARE_FIELDS.group} value={target.groupId} />
        )}
        {forecast.restriction.map((riskId) => (
          <input key={riskId} type="hidden" name={SHARE_FIELDS.risk} value={riskId} />
        ))}
        {forecast.restores.map((mission) => (
          <input key={mission.id} type="hidden" name={SHARE_FIELDS.restore} value={mission.id} />
        ))}
        <Button type="submit">
          Share and bring {one ? 'this mission' : `these ${count} missions`} back
        </Button>
        <a href={cancelHref}>Cancel</a>
      </form>
      <p className={styles.muted}>
        To share without bringing {one ? 'it' : 'them'} back, change the risks below so that{' '}
        {one ? 'it is' : 'they are'} not covered.
      </p>
    </Banner>
  );
}
