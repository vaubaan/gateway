/**
 * `/missions/new` — "New mission" on one screen (spec §4.2, §7.4).
 * `?from=<mission id>` starts from a copy of one of the reader's missions,
 * checked again against what they may allow today. `?platform=<account id>`
 * starts from the platform management mission on the reader's Vaubaan account
 * (`platformMissionDraft`): a prefill they see and may change, never issued by
 * itself. `?account=<account id>` starts from the starter mission of that account
 * (`starterMissionDraft`, spec §7.4): what a person lands on after connecting their
 * first account. The header, the form and
 * what follows the creation (the key, shown once) are `MissionForm`.
 */
import { AutoRefresh } from '@/components/accounts/AutoRefresh';
import { NeedsUser } from '@/components/auth/NeedsUser';
import { NoticeBanner } from '@/components/accounts/parts';
import { takeNotice } from '@/lib/accounts/session';
import { currentUser } from '@/lib/auth/session';
import { serviceIconOf } from '@vaubaan/plugin-sdk';

import type { ServiceMarkIcon } from '@/components/ui';
import { riskPlanesOf, type RiskPlanes } from '@/lib/services/planes';

import { PLATFORM_SERVICE, platformMissionDraft, starterMissionDraft } from './form-state';
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
  const platform = typeof params.platform === 'string' ? params.platform : null;
  const starter = typeof params.account === 'string' ? params.account : null;
  const notice = await takeNotice(session.root, session.principal.sessionId, params);

  const context = await service.issuanceContext(session.user);
  // The picker shows what is stored at once; the stale accounts refresh themselves.
  const stale = await session.root.accounts.refresher.staleIds(context.map((c) => c.id));
  // "Start from a mission…" offers what the reader created: a mission shared with them is not theirs to copy.
  const mine = (await service.list(session.user)).filter((m) => m.role === 'creator');

  // The services whose data model has several planes: the editor can be sliced by one.
  const planes: Record<string, RiskPlanes> = {};
  // Per service: its mark, on the cards and in "+ Add an account".
  const icons: Record<string, ServiceMarkIcon | null> = {};
  for (const { service } of context) {
    const plugin = session.root.registry.get(service)?.plugin;
    const riskPlanes = plugin ? riskPlanesOf(plugin.dataModel, plugin.catalog) : null;
    if (riskPlanes) planes[service] = riskPlanes;
    icons[service] = plugin ? serviceIconOf(plugin) : null;
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
        origin: 'copy',
      };
    }
  } else if (platform) {
    const account = context.find((c) => c.id === platform && c.service === PLATFORM_SERVICE);
    if (account) {
      const draft = platformMissionDraft(account);
      const preview = await service.preview(session.user, draft);
      initial = {
        name: draft.name,
        period: draft.period,
        resolved: preview.resolved,
        issues: preview.issues,
        sourceName: account.display_name,
        origin: 'platform',
      };
    }
  } else if (starter) {
    const account = context.find((c) => c.id === starter);
    if (account) {
      const draft = starterMissionDraft(account);
      const preview = await service.preview(session.user, draft);
      initial = {
        name: draft.name,
        period: draft.period,
        resolved: preview.resolved,
        issues: preview.issues,
        sourceName: `${account.service_label} · ${account.display_name}`,
        origin: 'starter',
      };
    }
  }

  return (
    <>
      <AutoRefresh accountIds={stale} quiet />
      {/* "Connected": what the connection that led here has to say (spec §7.2). */}
      <NoticeBanner notice={notice} />
      <MissionForm
        // A copy of another mission is another form: its state starts again.
        key={from ?? (platform ? `platform:${platform}` : starter ? `account:${starter}` : 'new')}
        context={context}
        missions={mine.map((m) => ({ id: m.mission.id, name: m.mission.name }))}
        initial={initial}
        planes={planes}
        icons={icons}
      />
    </>
  );
}
