/**
 * `/reference` — the services this gateway can reach (spec §4.2 "Services"),
 * one quiet line each: what it is, how an account of it is connected, and how
 * large its catalog is. The list is the plugin registry's; nothing is
 * enumerated here. Each line names the plugin's version and, when the operator
 * pinned it rather than the image bundling it, says so (`GatewayRoot.plugins`). Any
 * signed-in visitor reads it: it documents the gateway, it shows no account and
 * no mission.
 */
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import { Hint, Mono, Row, Rows, Section, ServiceMark } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { REFERENCE_WORDS } from '@/lib/vocabulary';
import { servicePath } from '@/lib/services/links';
import { serviceCards } from '@/lib/services/reference';

import { catalogSize, pinnedPlugins, PinnedTag, ReferenceFrame } from './frame';
import styles from './reference.module.css';

export const dynamic = 'force-dynamic';

export default async function ReferencePage() {
  const { root } = await requirePrincipal();
  const cards = serviceCards(root.registry);
  const pinned = pinnedPlugins(root.plugins);
  // Community validation status per plugin (spec §9); `null` when telemetry is off.
  const validation = new Map(
    await Promise.all(
      cards.map(async (card) => [card.id, await root.telemetry.stats.statusFor(card.id)] as const),
    ),
  );

  return (
    <ReferenceFrame cards={cards}>
      <Section title={REFERENCE_WORDS.services} count={cards.length} first>
        <Rows testId="services">
          {cards.map((card) => (
            <Row
              key={card.id}
              testId={`service-${card.id}`}
              lead={<ServiceMark name={card.name} icon={card.icon} />}
              title={
                <>
                  {card.name}
                  <span className={styles.rowTag}>
                    <PinnedTag entry={pinned.get(card.id)} />
                  </span>
                  <span className={styles.rowTag}>
                    <ValidationBadge status={validation.get(card.id) ?? null} />
                  </span>
                </>
              }
              href={servicePath(card.id)}
              description={
                <>
                  {card.description ?? 'This service ships no description.'} ·{' '}
                  <span data-testid="service-version">
                    plugin <Mono>{card.version}</Mono>
                  </span>
                </>
              }
              end={catalogSize(card)}
            />
          ))}
        </Rows>
        <Hint>
          A mission never holds the credential of a service: it holds a list of permissions, each
          with its limits and whether it runs freely or asks first.
        </Hint>
      </Section>
    </ReferenceFrame>
  );
}
