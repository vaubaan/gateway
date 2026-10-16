'use client';

/**
 * What the mission being created would be able to do, read two ways:
 *
 * - `RailSummary` — the rail beside the form: per account, what is allowed,
 *   what asks first and what it cannot do, in three short lines, then what
 *   the mission carries in all. A summary: it counts, it does not list.
 * - `ExplicitList` — what a person confirms before the mission is created:
 *   **every permission, by account, with its limit**, per period and per
 *   minute, and whether it asks first. Nothing in it stands for "all".
 */
import { AllowSummary, EnvTag, GateMark, Mono } from '@/components/ui';
import { count, formatNumber, gateWordOf, listed, TERMS } from '@/lib/vocabulary';
import { groupVariants } from '@/server/missions/catalog-view';
import type { IssuanceConnection } from '@/server/missions/model';
import { defaultResources } from '@/server/missions/preview';

import styles from '../missions.module.css';
import { allowLines } from '../mission-view';
import { editorRows, selectedResources, type ConnectionState } from './form-state';

/** The rail is narrow: a line names two permissions and counts the rest. */
const NAMED_IN_THE_RAIL = 2;

export interface IncludedAccount {
  readonly connection: IssuanceConnection;
  readonly state: ConnectionState;
}

/** The three lines of one account in the rail: pure, so the wording is tested without a browser. */
export function accountLines(
  connection: IssuanceConnection,
  state: ConnectionState,
): { can: string; asks: string | null; cannot: string } {
  const rows = editorRows(connection, state);
  const chosen = rows.flatMap((row) => {
    const entry = state.entries[row.risk.risk_id];
    return entry ? [{ label: row.risk.label, gate: entry.gate }] : [];
  });
  const left = rows
    .filter(
      (row) =>
        !row.accepted && row.unavailable === null && !row.risk.deprecated && !row.risk.fallback,
    )
    .map((row) => row.risk)
    .sort((a, b) => b.severity - a.severity);
  const notIncluded = groupVariants(left).map((family) => family.label);
  // The resources left out are said after the permissions, never counted among them.
  const others = defaultResources(connection).length - state.resourceIds.length;
  const leftOut =
    others > 0 ? ` Nor the other ${others} ${others === 1 ? 'resource' : 'resources'}.` : '';
  const lines = allowLines(chosen, notIncluded, NAMED_IN_THE_RAIL);
  return {
    ...lines,
    can: chosen.length === 0 ? 'Nothing yet: pick a preset.' : lines.can,
    cannot: `${lines.cannot}${leftOut}`,
  };
}

function resourceNames(connection: IssuanceConnection, state: ConnectionState): string {
  const names = selectedResources(connection, state).map((r) => r.display_name || r.ref);
  return names.length === 0 ? 'the account itself, no resource' : listed(names, 3);
}

export function RailSummary({
  accounts,
  carries,
}: {
  accounts: readonly IncludedAccount[];
  /** "26 explicit permissions, limits reset every day, expires 12 Nov." */
  carries: string;
}) {
  if (accounts.length === 0) {
    return (
      <p className={styles.railEmpty} data-testid="summary">
        Nothing yet. Include an account and pick a preset.
      </p>
    );
  }
  return (
    <div data-testid="summary">
      {accounts.map(({ connection, state }) => {
        const lines = accountLines(connection, state);
        return (
          <div
            key={connection.id}
            className={styles.railBlock}
            data-testid={`summary-${connection.provider}`}
          >
            <div className={styles.railAccount}>
              {connection.provider_label}
              <span className={styles.railResources}>{resourceNames(connection, state)}</span>
            </div>
            <AllowSummary
              compact
              can={lines.can}
              asks={lines.asks}
              asksLabel="Asks you"
              cannot={lines.cannot}
            />
          </div>
        );
      })}
      <div className={styles.railBlock}>
        <dl className={styles.railCarries}>
          <dt>Carries</dt>
          <dd data-testid="summary-carries">{carries}</dd>
        </dl>
      </div>
    </div>
  );
}

/** "10,000 a day", "50 in total": a limit with its period, as a person confirms it. */
function limitPhrase(quota: string, periodSeconds: number | null): string {
  if (quota.trim() === '') return 'no limit yet';
  const n = formatNumber(Number(quota));
  if (periodSeconds === null) return `${n} in total`;
  if (periodSeconds === 3600) return `${n} an hour`;
  if (periodSeconds === 86_400) return `${n} a day`;
  if (periodSeconds === 604_800) return `${n} a week`;
  return `${n} a period`;
}

function ratePhrase(max: string, window: string): string {
  if (max.trim() === '') return 'no limit yet';
  const n = formatNumber(Number(max));
  return window === '60' ? `${n} a minute` : `${n} per ${window} s`;
}

export function ExplicitList({
  accounts,
  periodSeconds,
}: {
  accounts: readonly IncludedAccount[];
  /** The length of the mission's period; `null` for limits that never reset. */
  periodSeconds: number | null;
}) {
  return (
    <div className={styles.explicit} data-testid="explicit-list">
      {accounts.map(({ connection, state }) => {
        const chosen = connection.risks.filter((risk) => state.entries[risk.risk_id]);
        return (
          <section
            key={connection.id}
            aria-label={`${connection.provider_label} ${connection.display_name}`}
          >
            <h3 className={styles.explicitAccount}>
              {connection.provider_label} · {connection.display_name}
              <span className={styles.explicitNote}>
                {resourceNames(connection, state)} · {count(chosen.length, TERMS.risk)}
              </span>
            </h3>
            <ul className={styles.explicitRows}>
              {chosen.map((risk) => {
                const entry = state.entries[risk.risk_id];
                if (!entry) return null;
                return (
                  <li
                    key={risk.risk_id}
                    className={styles.explicitRow}
                    data-permission={risk.risk_id}
                  >
                    <span>
                      {risk.label}
                      {risk.env && (
                        <span className={styles.inlineTag}>
                          <EnvTag env={risk.env} />
                        </span>
                      )}
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
