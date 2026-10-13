/**
 * The compact, always-visible reading of a policy on one connection: which
 * risks pass without asking, which wait for an approval, which are left out —
 * by human label, with the quota and the rate limit of each. Used for the
 * preset a creator picks and for a custom policy shown before it is edited.
 */
import { Badge } from '@/components/ui';
import { formatRate, type RiskFamily } from '@/server/missions/catalog-view';
import type { CatalogRisk } from '@/server/missions/model';

import styles from '../missions.module.css';
import type { ConnectionState, EntryState, ExplainedLine, SkippedFamily } from './form-state';

/** One accepted risk with its budget already worded. */
export interface PolicyLine {
  readonly risk: CatalogRisk;
  /** `2000 · 120/min`, or what is missing. */
  readonly budget: string;
}

export function lineOf(line: ExplainedLine): PolicyLine {
  return { risk: line.risk, budget: `${line.quota} · ${formatRate(line.rate_limit)}` };
}

/** The budget of an entry as typed in the editor; a blank field is said, not hidden. */
function typedBudget(entry: EntryState): string {
  const quota = entry.quota.trim();
  const max = Number(entry.rateMax);
  const window = Number(entry.rateWindow);
  const rate =
    entry.rateMax.trim() !== '' && entry.rateWindow.trim() !== ''
      ? formatRate({ max, window_seconds: window })
      : 'no rate limit yet';
  return `${quota === '' ? 'no quota yet' : quota} · ${rate}`;
}

/** The accepted entries of a connection's state as lines, catalog order, split by gate. */
export function linesOfState(
  risks: readonly CatalogRisk[],
  state: Pick<ConnectionState, 'entries'>,
): { auto: PolicyLine[]; approval: PolicyLine[] } {
  const auto: PolicyLine[] = [];
  const approval: PolicyLine[] = [];
  for (const risk of risks) {
    const entry = state.entries[risk.risk_id];
    if (!entry) continue;
    (entry.gate === 'approval' ? approval : auto).push({ risk, budget: typedBudget(entry) });
  }
  return { auto, approval };
}

export function PolicyLines({
  title,
  lines,
  empty,
  testId,
}: {
  title: string;
  lines: readonly PolicyLine[];
  /** What to say when the group is empty; the group is always shown, so nothing is implied. */
  empty: string;
  testId?: string;
}) {
  return (
    <div className={styles.lineGroup} data-testid={testId}>
      <div className={styles.lineTitle}>
        <span>
          {title} <span className={styles.count}>({lines.length})</span>
        </span>
        {lines.length > 0 && <span className={styles.lineCaption}>quota · rate limit</span>}
      </div>
      {lines.length === 0 ? (
        <p className={styles.lineEmpty}>{empty}</p>
      ) : (
        <ul className={styles.lines}>
          {lines.map(({ risk, budget }) => (
            <li key={risk.risk_id} title={risk.reason}>
              <span className={styles.lineLabel}>{risk.label}</span>
              <span className={styles.lineBudget}>
                {risk.env && <Badge mono>{risk.env}</Badge>}
                {budget}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FamilyName({ family }: { family: RiskFamily }) {
  const envs = family.variants.flatMap((risk) => (risk.env === null ? [] : [risk.env]));
  return (
    <>
      {family.label}
      {envs.map((env) => (
        <Badge key={env} mono>
          {env}
        </Badge>
      ))}
      {family.fallback && <Badge tone="warning">fallback</Badge>}
      {family.deprecated && <Badge tone="warning">deprecated</Badge>}
    </>
  );
}

/**
 * Catalog entries named without a budget: what a policy leaves out. The title
 * always states how many; the names unfold in place. It is the one part of a
 * preset's reading that is not spread out by default: on a long catalog it is
 * longer than everything the preset allows, and the screen must stay about
 * two viewports for three connections (spec §4.2).
 */
export function FamilyList({
  title,
  families,
  empty,
  testId,
}: {
  title: string;
  families: readonly RiskFamily[];
  empty: string;
  testId?: string;
}) {
  if (families.length === 0) {
    return (
      <div className={styles.lineGroup} data-testid={testId}>
        <div className={styles.lineTitle}>
          <span>
            {title} <span className={styles.count}>(0)</span>
          </span>
        </div>
        <p className={styles.lineEmpty}>{empty}</p>
      </div>
    );
  }
  return (
    <details className={styles.lineFold} data-testid={testId}>
      <summary className={styles.lineTitle}>
        <span>
          {title} <span className={styles.count}>({families.length})</span>
          <span className={styles.lineCaption}> — show the list</span>
        </span>
      </summary>
      <ul className={styles.families}>
        {families.map((family) => (
          <li key={family.base_id} title={family.reason}>
            <FamilyName family={family} />
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Entries of the preset this mission cannot get, each with the reason. */
export function SkippedList({
  families,
  testId,
}: {
  families: readonly SkippedFamily[];
  testId?: string;
}) {
  if (families.length === 0) return null;
  return (
    <div className={styles.lineGroup} data-testid={testId}>
      <div className={styles.lineTitle}>
        <span>
          In the preset, left out here <span className={styles.count}>({families.length})</span>
        </span>
      </div>
      <ul className={styles.skipped}>
        {families.map((family) => (
          <li key={`${family.base_id}:${family.why}`}>
            <span className={styles.lineLabel}>
              <FamilyName family={family} />
            </span>
            <span className={styles.skippedWhy}>{family.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
