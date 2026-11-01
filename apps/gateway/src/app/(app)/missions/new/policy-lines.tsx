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
import { count, formatNumber, gateWordOf, reachedOnAccount, TERMS } from '@/lib/vocabulary';
import { groupVariants } from '@/lib/missions/catalog-view';
import type { IssuanceConnection } from '@/lib/missions/model';
import { defaultResources } from '@/lib/missions/preview';

import styles from '../missions.module.css';
import { allowLines } from '../mission-view';
import {
  editorRows,
  entriesOfAccount,
  resourceIdsOfAccount,
  selectedResources,
  takesTheRest,
  type ConnectionState,
  type SetState,
} from './form-state';

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
  // A permission chosen in several resource sets is said once: it asks first if one set asks.
  const chosenBy = new Map<string, { label: string; gate: 'auto' | 'approval' }>();
  for (const set of state.sets) {
    for (const row of editorRows(connection, set)) {
      const entry = set.entries[row.risk.risk_id];
      if (!entry) continue;
      const seen = chosenBy.get(row.risk.risk_id);
      chosenBy.set(row.risk.risk_id, {
        label: row.risk.label,
        gate: seen?.gate === 'approval' || entry.gate === 'approval' ? 'approval' : 'auto',
      });
    }
  }
  const chosen = [...chosenBy.values()];
  const held = entriesOfAccount(state);
  const left = state.sets
    .flatMap((set) => editorRows(connection, set))
    .filter(
      (row, i, all) =>
        held[row.risk.risk_id] === undefined &&
        row.unavailable === null &&
        !row.risk.deprecated &&
        !row.risk.fallback &&
        all.findIndex((other) => other.risk.risk_id === row.risk.risk_id) === i,
    )
    .map((row) => row.risk)
    .sort((a, b) => b.severity - a.severity);
  const notIncluded = groupVariants(left).map((family) => family.label);
  // The resources left out are said after the permissions, never counted among them.
  const others = defaultResources(connection).length - resourceIdsOfAccount(state).length;
  const leftOut =
    others > 0 ? ` Nor the other ${others} ${others === 1 ? 'resource' : 'resources'}.` : '';
  const lines = allowLines(chosen, notIncluded, NAMED_IN_THE_RAIL);
  return {
    ...lines,
    can: chosen.length === 0 ? 'Nothing yet: tick a macro-action.' : lines.can,
    cannot: `${lines.cannot}${leftOut}`,
  };
}

function resourceNames(connection: IssuanceConnection, state: ConnectionState): string {
  const names = selectedResources(connection, { resourceIds: resourceIdsOfAccount(state) }).map(
    (r) => r.display_name || r.ref,
  );
  return reachedOnAccount(
    names,
    state.sets.some((set) => set.resourceScope === 'connection'),
  );
}

function setResourceNames(connection: IssuanceConnection, set: SetState): string {
  const names = selectedResources(connection, set).map((r) => r.display_name || r.ref);
  return reachedOnAccount(names, set.resourceScope === 'connection' && takesTheRest(set));
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
        Nothing yet. Include an account and tick a macro-action.
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
        const several = state.sets.length > 1;
        const chosenCount = state.sets.reduce(
          (n, set) => n + connection.risks.filter((risk) => set.entries[risk.risk_id]).length,
          0,
        );
        return (
          <section
            key={connection.id}
            aria-label={`${connection.provider_label} ${connection.display_name}`}
          >
            <h3 className={styles.explicitAccount}>
              {connection.provider_label} · {connection.display_name}
              <span className={styles.explicitNote}>
                {resourceNames(connection, state)} · {count(chosenCount, TERMS.risk)}
              </span>
            </h3>
            {state.sets.map((set, index) => (
              <div
                key={set.id ?? `new-${index}`}
                data-testid={several ? `explicit-set-${index + 1}` : undefined}
              >
                {several && (
                  <h4 className={styles.explicitSet}>
                    Resource set {index + 1}
                    <span className={styles.explicitNote}>{setResourceNames(connection, set)}</span>
                  </h4>
                )}
                <ExplicitRows connection={connection} set={set} periodSeconds={periodSeconds} />
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function ExplicitRows({
  connection,
  set,
  periodSeconds,
}: {
  connection: IssuanceConnection;
  set: SetState;
  periodSeconds: number | null;
}) {
  const chosen = connection.risks.filter((risk) => set.entries[risk.risk_id]);
  return (
    <ul className={styles.explicitRows}>
      {chosen.map((risk) => {
        const entry = set.entries[risk.risk_id];
        if (!entry) return null;
        return (
          <li key={risk.risk_id} className={styles.explicitRow} data-permission={risk.risk_id}>
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
              <span className={styles.sub}>{ratePhrase(entry.rateMax, entry.rateWindow)}</span>
            </span>
            <GateMark gate={gateWordOf(entry.gate)} />
          </li>
        );
      })}
    </ul>
  );
}
