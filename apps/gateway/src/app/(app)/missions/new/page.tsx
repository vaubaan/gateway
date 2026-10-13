/**
 * `/missions/new` — the one-page creation screen (spec §4.2, §7.4).
 * `?from=<mission id>` starts from a duplicate of one of the creator's
 * missions, re-checked against their current authority.
 */
import { NeedsUser } from '@/components/auth/NeedsUser';
import { currentUser } from '@/lib/auth/session';
import { Help } from '@/components/ui';
import { PROVIDERS_PATH } from '@/server/providers/links';
import { riskPlanesOf, type RiskPlanes } from '@/server/providers/planes';

import styles from '../missions.module.css';
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
  // "Duplicate from…" offers what the user created: a mission shared with them is not theirs to copy.
  const mine = (await service.list(session.user)).filter((m) => m.role === 'creator');

  // The providers whose data model has several planes: the Custom editor can be sliced by one.
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
    <>
      <div className={styles.pageHead}>
        <div>
          <h1>New mission</h1>
          <Help
            id="mission-new"
            line="Name it, pick the connections and a preset for each, read the summary, issue."
          >
            <p>
              For each connection, <strong>Preset</strong> is a ready-made selection of risks with
              budgets, and <strong>Custom</strong> lets you accept risks one by one. Either way the
              mission stores the explicit list of risks, never the preset. The token is shown once.
              What each provider&apos;s risks and presets mean is in the{' '}
              <a href={PROVIDERS_PATH} target="_blank" rel="noreferrer" className={styles.refLink}>
                provider reference
              </a>{' '}
              (new tab).
            </p>
          </Help>
        </div>
      </div>
      <MissionForm
        context={context}
        missions={mine.map((m) => ({ id: m.mission.id, name: m.mission.name }))}
        initial={initial}
        planes={planes}
      />
    </>
  );
}
