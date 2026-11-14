/**
 * `/missions/<id>/edit` — "Edit mission" (spec §3.2 "Editing a mission", §4.2,
 * §7.4 bis; ADR mission-editable-after-issuance): the creation form prefilled
 * from the mission, in edit mode. The creator only — anyone else reads "not
 * found", as for every act on a mission. A revoked or orphaned mission says why
 * it is not edited.
 */
import { notFound } from 'next/navigation';

import { NeedsUser } from '@/components/auth/NeedsUser';
import { ButtonLink, Callout, PageHeader } from '@/components/ui';
import { MISSION_ACTIONS, ROUTES, TRUST_RAISE_WORDS } from '@/lib/vocabulary';
import { currentUser } from '@/lib/auth/session';
import { serviceIconOf } from '@vaubaan/plugin-sdk';

import type { ServiceMarkIcon } from '@/components/ui';
import { riskPlanesOf, type RiskPlanes } from '@/lib/providers/planes';

import { MissionForm } from '../../new/mission-form';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
  /** "Raise" of a trust-raise proposal (risk model §4.7): `raise=<set>&action=<macro-action>`. */
  searchParams: Promise<{
    raise?: string | string[];
    action?: string | string[];
    /** "Raise this limit" (mission page): `custom=<set>&action=<macro-action>`. */
    custom?: string | string[];
  }>;
}

const one = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

export default async function EditMissionPage({ params, searchParams }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { id } = await params;
  const { service } = session.root.missions;
  const view = await service.editView(session.user, id);
  if (!view) notFound();
  const missionPath = `${ROUTES.missions}/${view.mission.id}`;

  if (view.blocked) {
    return (
      <>
        <PageHeader
          crumbs={[
            { label: 'Missions', href: ROUTES.missions },
            { label: view.mission.name, href: missionPath },
            { label: MISSION_ACTIONS.editMission },
          ]}
          title={`${MISSION_ACTIONS.editMission} “${view.mission.name}”`}
        />
        <Callout
          tone="warn"
          title={`This mission is ${view.blocked}`}
          action={<ButtonLink href={missionPath}>{MISSION_ACTIONS.openMission}</ButtonLink>}
          testId="edit-blocked"
        >
          {view.blocked === 'revoked'
            ? 'A stopped mission is never edited: create a new one, or duplicate it.'
            : 'It refuses every call while your access to its accounts is missing; it can be edited again once that access is back.'}
        </Callout>
      </>
    );
  }

  const query = await searchParams;
  const raiseSet = one(query.raise);
  const raiseAction = one(query.action);
  // Only an offer the server makes now opens the edit raised; anything else opens it as usual.
  const offer =
    raiseSet && raiseAction
      ? await service.trustRaiseOffer(session.user, view.mission.id, {
          resource_set_id: raiseSet,
          macro_action_id: raiseAction,
        })
      : null;

  const context = await service.issuanceContext(session.user);
  // The services whose data model has several planes: the editor can be sliced by one.
  const planes: Record<string, RiskPlanes> = {};
  const icons: Record<string, ServiceMarkIcon | null> = {};
  for (const { provider } of context) {
    const plugin = session.root.registry.get(provider)?.plugin;
    const riskPlanes = plugin ? riskPlanesOf(plugin.dataModel, plugin.catalog) : null;
    if (riskPlanes) planes[provider] = riskPlanes;
    icons[provider] = plugin ? serviceIconOf(plugin) : null;
  }
  // "Raise this limit" on the mission page: the edit opens on that macro-action's Custom.
  const customSet = one(query.custom);
  const customAction = one(query.action);

  return (
    <MissionForm
      key={`edit:${view.revision}${offer ? `:raise:${offer.resource_set_id}:${offer.macro_action_id}` : ''}`}
      context={context}
      missions={[]}
      initial={null}
      planes={planes}
      icons={icons}
      openCustom={
        customSet && customAction && !offer
          ? { resourceSetId: customSet, actionId: customAction }
          : null
      }
      edit={{
        missionId: view.mission.id,
        revision: view.revision,
        snapshot: view.snapshot,
        ...(offer
          ? {
              raise: {
                connectionId: offer.connection_id,
                resourceSetId: offer.resource_set_id,
                macroActionId: offer.macro_action_id,
                to: offer.to,
                from: offer.from,
                label: offer.macro_action_label,
                where: TRUST_RAISE_WORDS.where(
                  offer.account_name,
                  offer.several_sets ? offer.resource_set_position : null,
                ),
              },
            }
          : {}),
      }}
    />
  );
}
