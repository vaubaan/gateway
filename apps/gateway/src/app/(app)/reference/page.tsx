/**
 * `/reference` — the services this gateway can reach (spec §4.2 "Providers"),
 * one quiet line each: what it is, how an account of it is connected, and how
 * large its catalog is. The list is the plugin registry's; nothing is
 * enumerated here. Any signed-in visitor reads it: it documents the gateway,
 * it shows no account and no mission.
 */
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import { Hint, Row, Rows, Section, ServiceMark } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { REFERENCE_WORDS } from '@/lib/vocabulary';
import { providerPath } from '@/server/providers/links';
import { providerCards } from '@/server/providers/reference';

import { catalogSize, ReferenceFrame } from './frame';
import styles from './reference.module.css';

export const dynamic = 'force-dynamic';

export default async function ReferencePage() {
  const { root } = await requirePrincipal();
  const cards = providerCards(root.registry);
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
              testId={`provider-${card.id}`}
              lead={<ServiceMark name={card.name} icon={card.icon} />}
              title={
                <>
                  {card.name}
                  <span className={styles.rowTag}>
                    <ValidationBadge status={validation.get(card.id) ?? null} />
                  </span>
                </>
              }
              href={providerPath(card.id)}
              description={card.description ?? 'This service ships no description.'}
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
