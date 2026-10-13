/**
 * The presets side by side: one column per preset against the risks of the
 * catalog, grouped by class. A cell is the budget the preset gives the risk
 * (quota per period, rate limit, gate), per environment when the risk is
 * accepted per environment; an empty cell is a risk the preset leaves out.
 * The difference between two presets is read along a row.
 */
import { Fragment } from 'react';

import { GateBadge } from '@/components/risk/RiskBadges';
import { RiskMarkers } from '@/components/risk/RiskExplain';
import { Badge, Slug } from '@/components/ui';
import { formatRate } from '@/server/missions/catalog-view';
import type { PresetLine, PresetReference, RiskReferenceGroup } from '@/server/providers/reference';

import styles from '../reference.module.css';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The lines of a preset per catalog entry, catalog order kept inside an entry. */
function linesByEntry(preset: PresetReference): ReadonlyMap<string, readonly PresetLine[]> {
  const byEntry = new Map<string, PresetLine[]>();
  for (const line of [...preset.auto, ...preset.approval]) {
    const lines = byEntry.get(line.risk.base_id);
    if (lines) lines.push(line);
    else byEntry.set(line.risk.base_id, [line]);
  }
  return byEntry;
}

export function PresetMatrix({
  presets,
  groups,
  target,
  onGo,
}: {
  presets: readonly PresetReference[];
  /** The catalog, already limited to the plane in view. */
  groups: readonly RiskReferenceGroup[];
  /** The anchor a link pointed at: its column is marked. */
  target: string | null;
  onGo: (fragment: string) => void;
}) {
  const cells = presets.map((preset) => ({ preset, lines: linesByEntry(preset) }));
  const link = (fragment: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    onGo(fragment);
  };

  if (presets.length === 0) {
    return (
      <p className={styles.empty}>This plugin ships no preset: a mission is built in Custom.</p>
    );
  }

  return (
    <div className={styles.section}>
      <p className={styles.sectionLine}>
        A preset is a starting selection of risks with budgets; a mission stores the risks, never
        the preset. Each cell reads <span className={styles.cellKey}>quota per period</span> ·{' '}
        <span className={styles.cellKey}>rate limit</span> · gate; an empty cell is a risk the
        preset leaves out.
      </p>
      <div className={styles.tableWrap}>
        <table className={styles.matrix} data-testid="preset-matrix">
          <caption className="vbn-sr-only">
            Presets compared: the budget each preset gives each risk of the catalog
          </caption>
          <thead>
            <tr>
              <th scope="col" className={styles.matrixCorner}>
                Risk
              </th>
              {presets.map((preset) => {
                const included = preset.auto.length + preset.approval.length;
                return (
                  <th
                    key={preset.id}
                    scope="col"
                    id={preset.anchor}
                    data-testid={preset.anchor}
                    data-kind="preset"
                    className={[
                      styles.presetHead,
                      target === preset.anchor ? styles.presetTarget : '',
                    ].join(' ')}
                  >
                    <span className={styles.presetName}>
                      <Slug
                        kind="preset"
                        mono={false}
                        href={`#${preset.anchor}`}
                        onClick={link(preset.anchor)}
                        title={`Preset ${preset.id} — link to this column`}
                      >
                        {preset.label}
                      </Slug>
                    </span>
                    <span className={styles.presetMeta}>
                      {plural(included, 'risk', 'risks')}
                      {preset.approval.length > 0 && ` · ${preset.approval.length} under approval`}
                      {` · ${preset.not_included.length} left out`}
                    </span>
                    <span className={styles.presetText} title={preset.description}>
                      {preset.description}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          {groups.map((group) => (
            <tbody key={group.kind}>
              <tr className={styles.matrixGroup}>
                <th colSpan={presets.length + 1} scope="rowgroup">
                  {group.title} <span className={styles.groupCount}>{group.entries.length}</span>
                </th>
              </tr>
              {group.entries.map((entry) => (
                <tr key={entry.base_id} data-risk={entry.base_id}>
                  <th scope="row" className={styles.matrixRisk} data-kind="risk">
                    <a
                      href={`#${entry.anchor}`}
                      onClick={link(entry.anchor)}
                      className={styles.matrixLabel}
                    >
                      {entry.label}
                    </a>{' '}
                    <RiskMarkers fallback={entry.fallback} deprecated={entry.deprecated} />
                    <span className={styles.matrixId}>
                      <Slug kind="risk" href={`#${entry.anchor}`} onClick={link(entry.anchor)}>
                        {entry.base_id}
                      </Slug>
                    </span>
                  </th>
                  {cells.map(({ preset, lines }) => {
                    const own = lines.get(entry.base_id) ?? [];
                    return (
                      <td
                        key={preset.id}
                        className={[
                          styles.matrixCell,
                          target === preset.anchor ? styles.presetTarget : '',
                        ].join(' ')}
                        data-testid={`cell-${preset.id}-${entry.base_id}`}
                      >
                        {own.length === 0 ? (
                          <span className={styles.matrixEmpty}>
                            <span aria-hidden="true">—</span>
                            <span className="vbn-sr-only">not included</span>
                          </span>
                        ) : (
                          own.map((line) => (
                            <Fragment key={line.risk.risk_id}>
                              <span className={styles.budgetLine}>
                                {line.risk.env && (
                                  <span className={styles.budgetEnv}>
                                    <Badge mono>{line.risk.env}</Badge>
                                  </span>
                                )}
                                <span className={styles.budgetNumbers}>
                                  {line.quota} · {formatRate(line.rate_limit)}
                                </span>
                                <span className={styles.budgetGate}>
                                  <GateBadge gate={line.gate} />
                                </span>
                              </span>
                            </Fragment>
                          ))
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}
