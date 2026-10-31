/**
 * `/missions/new` — "New mission" on one screen (spec §4.2, §7.4).
 * `?from=<mission id>` starts from a copy of one of the reader's missions,
 * checked again against what they may allow today. The header, the form and
 * what follows the creation (the key, shown once) are `MissionForm`.
 */
import { NeedsUser } from '@/components/auth/NeedsUser';
import { currentUser } from '@/lib/auth/session';
import { riskPlanesOf, type RiskPlanes } from '@/lib/providers/planes';

import { MissionForm, type InitialDraft } from './mission-form';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NewMissionPage({ searchParams }: Props) {
  const session = await currentUser();
  if (!session) return <NeedsUser />;
  const { service } = session.root.missions;
  const params = await searchParams;
  const from = typeof params.from === 'string' ? params.from : null;

  const context = await service.issuanceContext(session.user);
  // "Start from a mission…" offers what the reader created: a mission shared with them is not theirs to copy.
  const mine = (await service.list(session.user)).filter((m) => m.role === 'creator');

  // The services whose data model has several planes: the editor can be sliced by one.
  const planes: Record<string, RiskPlanes> = {};
  for (const { provider } of context) {
    const plugin = session.root.registry.get(provider)?.plugin;
    const riskPlanes = plugin ? riskPlanesOf(plugin.dataModel, plugin.catalog) : null;
    if (riskPlanes) planes[provider] = riskPlanes;
  }

  let initial: InitialDraft | null = null;
  if (from) {
    const source = mine.find((m) => m.mission.id === from);
    const draft = source ? await service.draftFrom(session.user, from) : null;
    if (source && draft) {
      const preview = await service.preview(session.user, draft);
      initial = {
        name: draft.name,
        period: draft.period,
        resolved: preview.resolved,
        issues: preview.issues,
        sourceName: source.mission.name,
      };
    }
  }

  return (
    <MissionForm
      // A copy of another mission is another form: its state starts again.
      key={from ?? 'new'}
      context={context}
      missions={mine.map((m) => ({ id: m.mission.id, name: m.mission.name }))}
      initial={initial}
      planes={planes}
    />
  );
}
