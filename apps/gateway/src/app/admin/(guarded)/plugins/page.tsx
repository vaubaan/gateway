/**
 * `/admin/plugins` — Administration › Plugins (spec §4.2 "plugins", §7.11; ADR
 * plugins-bundled-or-pinned-by-the-operator): every plugin the instance knows
 * (`GatewayRoot.plugins`, bundled or pinned, registered or left out by `plugins.enabled`),
 * how many accounts each serves, its community validation, and what the versions feed
 * last reported (`GatewayRoot.updates`). Read-only: a plugin changes when the operator
 * changes the image or the plugins directory. The one form, "Check now", re-reads the
 * feed (`server/updates/handlers.ts`).
 *
 * Each fact is read from the module that owns it; the view (`plugins-view.tsx`) decides
 * nothing but how to say it.
 */
import { requireOperator } from '@/lib/auth/session';
import { providerCards } from '@/lib/providers/reference';

import { PluginsPage, type PluginLine } from './plugins-view';

export const dynamic = 'force-dynamic';

export default async function AdminPluginsPage() {
  const { root } = await requireOperator();
  const { entries } = root.plugins;
  const icons = new Map(providerCards(root.registry).map((card) => [card.id, card.icon]));
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
    accounts: counts.byProvider[entry.id] ?? 0,
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
      }}
    />
  );
}
