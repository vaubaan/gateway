/**
 * The frame of the Reference: the title of the place, and the services as a
 * local navigation beside the content. The list is the plugin registry's
 * (`providerCards`); nothing is enumerated here.
 */
import { PageHeader, ServiceMark, SubNav, SubNavFrame } from '@/components/ui';
import { count, PAGES, REFERENCE_WORDS, ROUTES, TERMS } from '@/lib/vocabulary';
import { providerPath } from '@/server/providers/links';
import type { ProviderCard } from '@/server/providers/reference';

/** "15 permissions · 3 presets · 26 tools" */
export function catalogSize(card: Pick<ProviderCard, 'counts'>): string {
  return [
    count(card.counts.risks, TERMS.risk),
    count(card.counts.presets, TERMS.preset),
    `${card.counts.tools} ${card.counts.tools === 1 ? 'tool' : 'tools'}`,
  ].join(' · ');
}

export function ReferenceFrame({
  cards,
  children,
}: {
  cards: readonly ProviderCard[];
  children: React.ReactNode;
}) {
  return (
    <>
      <PageHeader title={PAGES.reference.title} lede={PAGES.reference.lede} width="wide" />
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
                  href: providerPath(card.id),
                  lead: <ServiceMark name={card.name} />,
                })),
              },
            ]}
          />
        }
      >
        {children}
      </SubNavFrame>
    </>
  );
}
