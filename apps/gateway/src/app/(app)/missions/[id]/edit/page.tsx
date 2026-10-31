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
import { MISSION_ACTIONS, ROUTES } from '@/lib/vocabulary';
import { currentUser } from '@/lib/auth/session';
import { riskPlanesOf, type RiskPlanes } from '@/lib/providers/planes';

import { MissionForm } from '../../new/mission-form';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditMissionPage({ params }: Props) {
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

  const context = await service.issuanceContext(session.user);
  // The services whose data model has several planes: the editor can be sliced by one.
  const planes: Record<string, RiskPlanes> = {};
  for (const { provider } of context) {
    const plugin = session.root.registry.get(provider)?.plugin;
    const riskPlanes = plugin ? riskPlanesOf(plugin.dataModel, plugin.catalog) : null;
    if (riskPlanes) planes[provider] = riskPlanes;
  }

  return (
    <MissionForm
      key={`edit:${view.revision}`}
      context={context}
      missions={[]}
      initial={null}
      planes={planes}
      edit={{
        missionId: view.mission.id,
        revision: view.revision,
        snapshot: view.snapshot,
        used: view.used,
        openRequests: view.open_requests,
      }}
    />
  );
}
