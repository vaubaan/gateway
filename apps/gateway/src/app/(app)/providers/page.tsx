/**
 * `/providers` — the provider reference, index (spec §4.2 "Providers"): the
 * plugins this instance ships, what each connects to, how it authenticates,
 * and how large its model is. The list is the plugin registry's; nothing is
 * enumerated here. Any signed-in visitor reads it: it documents the instance,
 * it shows no connection and no mission.
 */
import Link from 'next/link';

import { credentialKindLabel, ExperimentalBadge } from '@/components/connections/parts';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import { Stack } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { providerPath } from '@/server/providers/links';
import { providerCards, type ProviderCounts } from '@/server/providers/reference';

import styles from './providers.module.css';

export const dynamic = 'force-dynamic';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function countsLine(counts: ProviderCounts): string {
  return [
    plural(counts.risks, 'risk', 'risks'),
    plural(counts.presets, 'preset', 'presets'),
    plural(counts.tools, 'tool', 'tools'),
  ].join(' · ');
}

export default async function ProvidersPage() {
  const { root } = await requirePrincipal();
  const cards = providerCards(root.registry);
  // Community validation status per plugin (spec §9); `null` when telemetry is off.
  const validation = new Map(
    await Promise.all(
      cards.map(async (card) => [card.id, await root.telemetry.stats.statusFor(card.id)] as const),
    ),
  );

  return (
    <Stack gap="var(--space-6)">
      <div>
        <h1>Providers</h1>
        <p className={styles.lead}>
          What this instance can connect to. Each page explains, in this order, what the plugin
          does, the model it has of the provider, every risk a mission can accept with the reason it
          is a risk, the presets with everything they contain, and the tools an agent gets. A
          mission never holds a provider credential: it holds a list of these risks, each with a
          quota, a rate limit and a gate.
        </p>
      </div>
      <ul className={styles.cards}>
        {cards.map((card) => (
          <li key={card.id}>
            <Link
              href={providerPath(card.id)}
              className={styles.card}
              data-testid={`provider-${card.id}`}
            >
              <span className={styles.cardName}>
                {card.name}
                {card.experimental && <ExperimentalBadge />}
                <ValidationBadge status={validation.get(card.id) ?? null} />
              </span>
              {card.description && <span className={styles.cardText}>{card.description}</span>}
              <span className={styles.cardMeta}>
                {credentialKindLabel(card.credential_kind)} · {countsLine(card.counts)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Stack>
  );
}
