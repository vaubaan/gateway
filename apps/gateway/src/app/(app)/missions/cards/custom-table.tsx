'use client';

/**
 * The permissions of one macro-action of a card, one a row (spec §4.2): what each
 * does on the card (runs freely, asks first, left out), its limit per period and per
 * minute, and the permissions the catalog never accepts in the card's environment.
 * Editable in the Custom modal; read-only in the (i) of a row, the same content.
 */
import type { RiskId } from '@vaubaan/shared';

import { Input, RowChip } from '@/components/ui';
import { CARD_WORDS, LIMIT_WORDS } from '@/lib/vocabulary';
import type { IssuanceConnection } from '@/lib/missions/model';

import { defaultEntryFor, type CardState, type EntryState } from '../new/form-state';
import { ratePhrase } from '../new/policy-lines';
import { behaviourOf, gateOf, type Behaviour, type CustomView } from './card-model';
import styles from './cards.module.css';

const BEHAVIOURS: readonly { readonly id: Behaviour; readonly label: string }[] = [
  { id: 'free', label: CARD_WORDS.runsFreely },
  { id: 'ask', label: CARD_WORDS.asksFirst },
  { id: 'out', label: CARD_WORDS.leftOut },
];

const SECONDS_PER_MINUTE = '60';

export function CustomTable({
  connection,
  card,
  view,
  lines,
  plane,
  limitLabel,
  onLine,
}: {
  connection: IssuanceConnection;
  card: CardState;
  view: CustomView;
  /** The line of each row, `null` when left out. */
  lines: Readonly<Record<RiskId, EntryState | null>>;
  /** The plane chip on: only its rows are shown; `null` shows every row. */
  plane: string | null;
  /** The head of the limit column: "Per day", "Per week", "In total". */
  limitLabel: string;
  /** Absent: the table is read-only (the (i) of a row). */
  onLine?: (riskId: RiskId, entry: EntryState | null) => void;
}) {
  const shown = view.rows.filter((row) => plane === null || row.planes.includes(plane));
  const never = view.never.filter((row) => plane === null || row.planes.includes(plane));
  const editable = onLine !== undefined;
  return (
    <table className={styles.permissions}>
      <thead>
        <tr>
          <th scope="col">{CARD_WORDS.permission}</th>
          <th scope="col">{CARD_WORDS.behaviour}</th>
          <th scope="col">{limitLabel}</th>
          <th scope="col">{LIMIT_WORDS.perMinute}</th>
        </tr>
      </thead>
      <tbody>
        {shown.map(({ risk, unavailable }) => {
          const entry = lines[risk.risk_id] ?? null;
          const behaviour = behaviourOf(entry);
          const locked = unavailable !== null && entry === null;
          const perMinute = entry?.rateWindow === SECONDS_PER_MINUTE;
          const set = (patch: Partial<EntryState>) => {
            if (entry) onLine?.(risk.risk_id, { ...entry, ...patch });
          };
          return (
            <tr key={risk.risk_id} data-permission={risk.risk_id}>
              <td>
                {risk.label}
                <span className={styles.permissionRow}>
                  <RowChip row={risk.row} reason={risk.row_reason} inline />
                </span>
                <span className={styles.permissionId}>{risk.risk_id}</span>
                {unavailable && <span className={styles.unavailable}>{unavailable}</span>}
              </td>
              <td>
                {editable && !locked ? (
                  <fieldset className={styles.segments}>
                    <legend className="vbn-sr-only">{`Behaviour of ${risk.risk_id}`}</legend>
                    {BEHAVIOURS.map((b) => (
                      <label
                        key={b.id}
                        className={[
                          styles.segment,
                          behaviour === b.id ? styles.segmentOn : '',
                        ].join(' ')}
                      >
                        <input
                          type="radio"
                          name={`behaviour-${card.key}-${risk.risk_id}`}
                          value={b.id}
                          checked={behaviour === b.id}
                          onChange={() => {
                            if (b.id === 'out') onLine(risk.risk_id, null);
                            else
                              onLine(risk.risk_id, {
                                ...(entry ?? defaultEntryFor(connection, card.trustLevels, risk)),
                                gate: gateOf(b.id),
                              });
                          }}
                        />
                        {b.label}
                      </label>
                    ))}
                  </fieldset>
                ) : (
                  BEHAVIOURS.find((b) => b.id === behaviour)?.label
                )}
              </td>
              <td>
                {entry === null ? (
                  '—'
                ) : editable ? (
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    className={styles.number}
                    value={entry.quota}
                    aria-label={`Limit for ${risk.risk_id}`}
                    aria-invalid={entry.quota.trim() === ''}
                    onChange={(e) => set({ quota: e.target.value })}
                  />
                ) : (
                  entry.quota
                )}
              </td>
              <td>
                {entry === null ? (
                  '—'
                ) : editable && perMinute ? (
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    step={1}
                    inputMode="numeric"
                    className={styles.number}
                    value={entry.rateMax}
                    aria-label={`Per minute for ${risk.risk_id}`}
                    aria-invalid={entry.rateMax.trim() === ''}
                    onChange={(e) => set({ rateMax: e.target.value })}
                  />
                ) : perMinute ? (
                  entry.rateMax
                ) : (
                  ratePhrase(entry.rateMax, entry.rateWindow)
                )}
              </td>
            </tr>
          );
        })}
        {card.env &&
          never.map((row) => (
            <tr key={`never:${row.baseId}`} className={styles.never} data-never={row.baseId}>
              <td>
                {row.label}
                <span className={styles.permissionId}>{row.baseId}</span>
              </td>
              <td>{CARD_WORDS.neverIn(card.env ?? '')}</td>
              <td>—</td>
              <td>—</td>
            </tr>
          ))}
      </tbody>
    </table>
  );
}
