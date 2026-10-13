/**
 * `/missions/new` — the one-page creation screen (spec §4.2, §7.4).
 * `?from=<mission id>` starts from a duplicate of one of the creator's
 * missions, re-checked against their current authority.
 */
import { currentUser } from '../current-user';
import styles from '../missions.module.css';
import { MissionForm, type InitialDraft } from './mission-form';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function NewMissionPage({ searchParams }: Props) {
  const session = await currentUser();
  if (!session) return null;
  const { service } = session.root.missions;
  const params = await searchParams;
  const from = typeof params.from === 'string' ? params.from : null;

  const context = await service.issuanceContext(session.user);
  const mine = await service.list(session.user);

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
          <p className={styles.muted}>
            Name it, pick the connections and a preset for each, read the summary, issue. The token
            is shown once.
          </p>
        </div>
      </div>
      <MissionForm
        context={context}
        missions={mine.map((m) => ({ id: m.mission.id, name: m.mission.name }))}
        initial={initial}
      />
    </>
  );
}
