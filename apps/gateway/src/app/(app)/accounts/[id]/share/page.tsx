/**
 * `/accounts/<id>/share` — "Give access" (the protocol's share: spec §4.2
 * "Accounts", §7.3), as a dialog over the page of the account. Owner only:
 * anyone else reads "not found". With `?share=<id>` the dialog opens on the
 * access that person or team already holds; submitting replaces it.
 *
 * With `?confirm=<id>` the dialog comes back from a post that would bring
 * stopped missions back (spec §2.3): it lists them, and the access is given
 * by the confirmation, which posts the same access with the missions it
 * listed.
 */
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { Callout } from '@/components/ui';
import {
  currentActor,
  firstParam,
  takeNotice,
  type PageSearchParams,
} from '@/lib/accounts/session';
import { holderWords } from '@/lib/vocabulary';
import { accountPath, isConnectError } from '@/server/accounts';
import { providerPath } from '@/lib/providers/links';
import { providerReference } from '@/lib/providers/reference';
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

import { AccountView, loadAccount, type AccountData } from '../account-view';
import {
  GiveAccessDialog,
  type AccessMacroAction,
  type GiveAccessInitial,
} from './give-access-dialog';

export const dynamic = 'force-dynamic';

function initialOf(
  editing: ShareContext['shares'][number] | null,
  context: ShareContext,
): GiveAccessInitial {
  const firstGroup = context.groups[0]?.id ?? '';
  if (!editing) {
    return {
      targetKind: 'user',
      email: '',
      groupId: firstGroup,
      selected: [],
      editing: false,
      holder: null,
    };
  }
  const { target, restriction } = editing.share;
  return {
    targetKind: target.kind,
    email: target.kind === 'user' ? editing.targetLabel : '',
    groupId: target.kind === 'group' ? target.id : firstGroup,
    selected: restriction,
    editing: true,
    holder: holderWords(editing.targetLabel),
  };
}

/** The dialog as it was posted: the owner may change it instead of confirming. */
function initialOfPending(
  pending: PendingShare,
  forecast: ShareForecast | null,
  context: ShareContext,
): GiveAccessInitial {
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
    holder: forecast ? holderWords(forecast.targetLabel) : null,
  };
}

export default async function GiveAccessPage({
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
    if (isConnectError(err, 'not-found') || isShareError(err, 'not-found')) notFound();
    throw err;
  }
  const query = await searchParams;
  const notice = await takeNotice(root, principal.sessionId, query);
  const { context } = data;
  const { account } = context;
  const base = accountPath(account.id);
  const editingId = firstParam(query.share);
  const editing = context.shares.find((view) => view.share.id === editingId) ?? null;
  // An access posted from this session that waits for its confirmation, read again now:
  // the list is the one of this instant, not the one of the post.
  const stored = await root.shares.pending.read(
    principal.sessionId,
    firstParam(query[SHARE_CONFIRM_PARAM]),
  );
  const pending = stored?.accountId === account.id ? stored : null;
  let forecast: ShareForecast | null = null;
  if (pending) {
    try {
      forecast = await root.shares.service.forecast(actor, account.id, pending.input);
    } catch (err) {
      // What was asked is refused now (the person left, the account was disconnected):
      // the dialog opens as usual and the post says why.
      if (!(err instanceof ShareError) && !(err instanceof Error && err.name === 'ShareError')) {
        throw err;
      }
    }
  }
  // A macro-action names unqualified ids: it ticks every explicit id of them, retired ones aside.
  const macroActions: AccessMacroAction[] = (
    providerReference(root.registry, account.provider)?.macro_actions ?? []
  ).map((action) => ({
    id: action.id,
    label: action.label,
    description: action.description,
    riskIds: context.risks
      .filter((risk) => action.risk_ids.includes(risk.base_id) && !risk.deprecated)
      .map((risk) => risk.risk_id),
  }));

  return (
    <AccountView
      data={data}
      actor={actor}
      notice={notice}
      unfolded={{ access: null, resource: null }}
      note={
        context.unshareable ? (
          <Callout tone="bad" title="Nobody can be given access to this account">
            {SHARE_ERROR_MESSAGES[context.unshareable]}
          </Callout>
        ) : undefined
      }
      overlay={
        context.unshareable ? undefined : (
          <GiveAccessDialog
            action={`${base}/shares`}
            closeHref={base}
            account={account.displayName}
            service={{
              id: account.provider,
              label: context.providerLabel,
              referenceHref: providerPath(account.provider),
            }}
            fields={SHARE_FIELDS}
            risks={context.risks}
            teams={context.groups.map((group) => ({ id: group.id, name: group.name }))}
            macroActions={macroActions}
            labelling={context.labelling}
            initial={
              pending ? initialOfPending(pending, forecast, context) : initialOf(editing, context)
            }
            restore={
              pending && forecast && forecast.restores.length > 0
                ? {
                    holder: holderWords(forecast.targetLabel),
                    missions: forecast.restores.map((mission) => ({
                      id: mission.id,
                      name: mission.name,
                      creator: mission.creatorLabel,
                    })),
                  }
                : null
            }
          />
        )
      }
    />
  );
}
