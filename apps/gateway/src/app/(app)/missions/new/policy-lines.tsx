'use client';

/**
 * `ExplicitList` — what a person confirms before the mission is created: **every
 * permission, card by card, with its limit**, per period and per minute, and whether
 * it asks first. Nothing in it stands for "all" (spec §4.2 "Creating confirms the
 * explicit list").
 */
import { EnvTag, GateMark, Mono } from '@/components/ui';
import { count, formatNumber, gateWordOf, TERMS } from '@/lib/vocabulary';
import type { IssuanceConnection } from '@/lib/missions/model';

import styles from '../missions.module.css';
import { accountLabel, reachesAccountItself, resourcesLine } from '../cards/card-model';
import { cardResources, type CardState } from './form-state';

/** "10,000 a day", "50 in total": a limit with its period, as a person confirms it. */
export function limitPhrase(quota: string, periodSeconds: number | null): string {
  if (quota.trim() === '') return 'no limit yet';
  const n = formatNumber(Number(quota));
  if (periodSeconds === null) return `${n} in total`;
  if (periodSeconds === 3600) return `${n} an hour`;
  if (periodSeconds === 86_400) return `${n} a day`;
  if (periodSeconds === 604_800) return `${n} a week`;
  return `${n} a period`;
}

export function ratePhrase(max: string, window: string): string {
  if (max.trim() === '') return 'no limit yet';
  const n = formatNumber(Number(max));
  return window === '60' ? `${n} a minute` : `${n} per ${window} s`;
}

export function ExplicitList({
  context,
  cards,
  periodSeconds,
}: {
  context: readonly IssuanceConnection[];
  cards: readonly CardState[];
  /** The length of the mission's period; `null` for limits that never reset. */
  periodSeconds: number | null;
}) {
  return (
    <div className={styles.explicit} data-testid="explicit-list">
      {cards.map((card) => {
        const connection = context.find((c) => c.id === card.connectionId);
        if (!connection) return null;
        const chosen = connection.risks.filter((risk) => card.entries[risk.risk_id]);
        return (
          <section key={card.key} aria-label={accountLabel(connection)}>
            <h3 className={styles.explicitAccount}>
              {accountLabel(connection)}
              {card.env && (
                <span className={styles.inlineTag}>
                  <EnvTag env={card.env} />
                </span>
              )}
              <span className={styles.explicitNote}>
                {resourcesLine(
                  connection.resource_noun,
                  cardResources(connection, card),
                  card.future,
                  reachesAccountItself(connection, card),
                )}{' '}
                · {count(chosen.length, TERMS.risk)}
              </span>
            </h3>
            <ul className={styles.explicitRows}>
              {chosen.map((risk) => {
                const entry = card.entries[risk.risk_id];
                if (!entry) return null;
                return (
                  <li
                    key={risk.risk_id}
                    className={styles.explicitRow}
                    data-permission={risk.risk_id}
                  >
                    <span>
                      {risk.label}
                      <span className={styles.sub}>
                        <Mono quiet>{risk.risk_id}</Mono>
                      </span>
                    </span>
                    <span className={styles.explicitLimits}>
                      {limitPhrase(entry.quota, periodSeconds)}
                      <span className={styles.sub}>
                        {ratePhrase(entry.rateMax, entry.rateWindow)}
                      </span>
                    </span>
                    <GateMark gate={gateWordOf(entry.gate)} />
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
