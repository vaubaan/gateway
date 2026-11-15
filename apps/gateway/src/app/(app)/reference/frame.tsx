/**
 * The frame of the Reference: the services as a local navigation — a row of
 * tabs under the path bar — then the title of the place and the content. The
 * list is the plugin registry's (`serviceCards`); nothing is enumerated here.
 */
import { Mono, PageHeader, ServiceMark, SubNav, SubNavFrame, Tag } from '@/components/ui';
import {
  DOC_PAGES,
  count,
  PAGES,
  PLUGIN_WORDS,
  REFERENCE_WORDS,
  ROUTES,
  TERMS,
} from '@/lib/vocabulary';
import { servicePath } from '@/lib/services/links';
import type { ServiceCard } from '@/lib/services/reference';
import type { PluginInventory, PluginInventoryEntry } from '@/server/plugins';

/** "15 permissions · 4 macro-actions · 26 tools" */
export function catalogSize(card: Pick<ServiceCard, 'counts'>): string {
  return [
    count(card.counts.risks, TERMS.risk),
    count(card.counts.macro_actions, TERMS.macroAction),
    `${card.counts.tools} ${card.counts.tools === 1 ? 'tool' : 'tools'}`,
  ].join(' · ');
}

/** The inventory entry of a pinned plugin, by id; a bundled plugin is absent. */
export function pinnedPlugins(
  inventory: Pick<PluginInventory, 'entries'>,
): ReadonlyMap<string, PluginInventoryEntry> {
  return new Map(
    inventory.entries
      .filter((entry) => entry.origin === 'pinned')
      .map((entry) => [entry.id, entry] as const),
  );
}

/**
 * "pinned": the operator pinned this plugin in the plugins directory (ADR
 * plugins-bundled-or-pinned-by-the-operator), with the bundled version it replaces on
 * the service's own page. Nothing for a bundled plugin: the normal case is unsaid.
 */
export function PinnedTag({
  entry,
  withReplaced = false,
}: {
  entry: PluginInventoryEntry | undefined;
  withReplaced?: boolean;
}) {
  if (!entry) return null;
  return (
    <span title={PLUGIN_WORDS.pinnedTitle} data-testid="plugin-pinned">
      <Tag>
        {PLUGIN_WORDS.pinned}
        {withReplaced && entry.replaces !== null && (
          <>
            {' '}
            · {PLUGIN_WORDS.replaces} <Mono>{entry.replaces}</Mono>
          </>
        )}
      </Tag>
    </span>
  );
}

export function ReferenceFrame({
  cards,
  children,
}: {
  cards: readonly ServiceCard[];
  children: React.ReactNode;
}) {
  return (
    <SubNavFrame
      nav={
        <SubNav
          label={REFERENCE_WORDS.services}
          groups={[
            {
              items: [{ label: 'All services', href: ROUTES.reference, exact: true }],
            },
            {
              label: REFERENCE_WORDS.services,
              items: cards.map((card) => ({
                label: card.name,
                href: servicePath(card.id),
                lead: <ServiceMark name={card.name} icon={card.icon} />,
              })),
            },
          ]}
        />
      }
    >
      <PageHeader
        doc={DOC_PAGES.reference}
        title={PAGES.reference.title}
        lede={PAGES.reference.lede}
        width="wide"
      />
      {children}
    </SubNavFrame>
  );
}
