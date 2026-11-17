/**
 * `/admin/plugins` — Administration › Plugins (spec §4.2 "plugins", §7.11; ADR
 * plugins-bundled-or-pinned-by-the-operator): every plugin the instance knows
 * (`GatewayRoot.plugins`, bundled or pinned, registered or left out by `plugins.enabled`),
 * how many accounts each serves, its community validation, and what the versions feed
 * last reported (`GatewayRoot.updates`), and the installed versions (`GatewayRoot.pluginInstall`,
 * ADR plugins-activated-by-an-administrator-on-trial) with the forms that install, activate,
 * refuse, go back and restart. "Check now" re-reads the feed (`server/updates/handlers.ts`).
 *
 * Each fact is read from the module that owns it; the view (`plugins-view.tsx`) decides
 * nothing but how to say it.
 */
import { requireOperator } from '@/lib/auth/session';
import { serviceCards } from '@/lib/services/reference';

import { flashOf, type InstallView } from './install-view';
import { PluginsPage, type PluginLine } from './plugins-view';

export const dynamic = 'force-dynamic';

const WITH_ACTIVATION = new Set(['pending', 'previous', 'failed']);

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function AdminPluginsPage({ searchParams }: Props) {
  const { root } = await requireOperator();
  const params = await searchParams;
  const versions = (await root.pluginInstall.service.list()).filter((v) => v.state !== 'removed');
  const activations: Record<
    string,
    NonNullable<Awaited<ReturnType<typeof root.pluginInstall.service.activationView>>>
  > = {};
  for (const version of versions.filter((v) => WITH_ACTIVATION.has(v.state))) {
    const activation = await root.pluginInstall.service.activationView(version.digest);
    if (activation !== null) activations[version.digest] = activation;
  }
  const install: InstallView = {
    canInstall: root.pluginInstall.dir !== null,
    versions,
    activations,
    flash: flashOf(params),
  };
  const { entries } = root.plugins;
  const icons = new Map(serviceCards(root.registry).map((card) => [card.id, card.icon]));
  const [counts, validations] = await Promise.all([
    root.limits.counts.accounts(),
    Promise.all(
      entries.map((entry) =>
        entry.enabled ? root.telemetry.stats.statusFor(entry.id) : Promise.resolve(null),
      ),
    ),
  ]);
  const lines: PluginLine[] = entries.map((entry, index) => ({
    entry,
    icon: icons.get(entry.id) ?? null,
    accounts: counts.byService[entry.id] ?? 0,
    validation: validations[index] ?? null,
  }));

  return (
    <PluginsPage
      view={{
        lines,
        check: root.config.updates.check,
        feedUrl: root.config.updates.feedUrl.href,
        report: root.updates.current(),
        failure: root.updates.lastFailure(),
        install,
      }}
    />
  );
}
