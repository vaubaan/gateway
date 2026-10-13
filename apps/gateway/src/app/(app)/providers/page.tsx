/**
 * `/providers` — the provider reference, index (spec §4.2 "Providers"): the
 * plugins this instance ships as a grid of cards that differ at a glance —
 * what each connects to, how it authenticates, the planes of its model, the
 * environments it knows and how large its catalog is. The list is the plugin
 * registry's; nothing is enumerated here. Any signed-in visitor reads it: it
 * documents the instance, it shows no connection and no mission.
 */
import Link from 'next/link';

import { credentialKindLabel, ExperimentalBadge } from '@/components/connections/parts';
import { ValidationBadge } from '@/components/telemetry/ValidationBadge';
import { Badge, Glyph, Help, KindLegend, Slug, Stack, type ItemKind } from '@/components/ui';
import { requirePrincipal } from '@/lib/auth/session';
import { providerPath } from '@/server/providers/links';
import { providerCards } from '@/server/providers/reference';

import styles from './providers.module.css';

export const dynamic = 'force-dynamic';

function Count({ kind, count, word }: { kind: ItemKind; count: number; word: string }) {
  return (
    <span className={styles.stat} data-kind={kind}>
      <Glyph name={kind} className={styles.statGlyph} />
      <strong>{count}</strong> {word}
    </span>
  );
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
    <Stack gap="var(--space-5)">
      <div>
        <h1>Providers</h1>
        <Help
          id="providers-index"
          line="What this instance can connect to. A mission never holds a provider credential: it holds a list of risks, each with a quota, a rate limit and a gate."
        >
          <p>
            Each page shows the presets of the plugin side by side, every risk a mission can accept
            with the reason it is a risk, the model the plugin has of the provider, and the tools an
            agent gets.
          </p>
          <KindLegend />
        </Help>
      </div>
      <ul className={styles.cards}>
        {cards.map((card) => (
          <li key={card.id}>
            <Link
              href={providerPath(card.id)}
              className={styles.card}
              data-testid={`provider-${card.id}`}
            >
              <span className={styles.cardHead}>
                <span className={styles.cardName}>{card.name}</span>
                <span className={styles.cardKind}>{credentialKindLabel(card.credential_kind)}</span>
              </span>
              {(card.experimental || validation.get(card.id)) && (
                <span className={styles.badges}>
                  {card.experimental && <ExperimentalBadge />}
                  <ValidationBadge status={validation.get(card.id) ?? null} />
                </span>
              )}
              {card.description && <span className={styles.cardText}>{card.description}</span>}
              <span className={styles.cardTags}>
                {card.plane_slugs.map((slug) => (
                  <Slug key={slug} kind="plane" title={`Plane ${slug} of the data model`}>
                    {slug}
                  </Slug>
                ))}
                {card.envs.map((env) => (
                  <Badge key={env} mono>
                    <span title="Environment a risk can be accepted in">{env}</span>
                  </Badge>
                ))}
              </span>
              <span className={styles.cardStats}>
                <Count kind="preset" count={card.counts.presets} word="presets" />
                <Count kind="risk" count={card.counts.risks} word="risks" />
                <Count kind="tool" count={card.counts.tools} word="tools" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Stack>
  );
}
