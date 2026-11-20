/**
 * The three small marks of a permission, the same on every page.
 *
 * - `RowChip` — the row of the permission in words (Harmless, Worth a
 *   look, Repairable, at a price, Cannot be repaired), with the reason
 *   that put it there in quiet type when asked. Harmless is written plainly;
 *   only rows 2 and above take a colour.
 * - `GateMark` — what happens when the agent uses the permission: it **runs
 *   freely**, or it must **ask me first**; `off` is "not included". A dot and
 *   the words: never the dot alone.
 * - `WhyCells` — the five facts behind a row (undo, blast radius, data,
 *   cost, visible to), each labelled. Shown behind "why?" on the Reference
 *   only, never by default.
 *
 * No hook: these render in server and client components alike.
 */
import {
  GATE_WORDS,
  REASON_WORDS,
  ROW_WORDS,
  WHY_LABELS,
  WHY_ORDER,
  whyValue,
  type GateWord,
  type Reason,
  type Row,
  type WhyAxis,
} from '@/lib/vocabulary';

import styles from './Marks.module.css';

export function RowChip({
  row,
  reason,
  inline = false,
}: {
  row: Row;
  /** The branch of the tree that decided; shown in quiet type when given. */
  reason?: Reason | null;
  /** The reason on the same line, after a dot; under the row word by default (a table cell). */
  inline?: boolean;
}) {
  return (
    <span className={[styles.row, styles[`row_${row}`]].join(' ')} data-row={row}>
      {ROW_WORDS[row]}
      {reason ? (
        <>
          {inline ? ' · ' : ' '}
          <span className={inline ? styles.reasonInline : styles.reason}>
            {REASON_WORDS[reason]}
          </span>
        </>
      ) : null}
    </span>
  );
}

export function GateMark({
  gate,
  children,
}: {
  gate: GateWord;
  /** Other words for the same state ("asked you", "asks first", "waiting"). */
  children?: React.ReactNode;
}) {
  return (
    <span className={[styles.gate, styles[`gate_${gate}`]].join(' ')} data-gate={gate}>
      {children ?? GATE_WORDS[gate]}
    </span>
  );
}

/** The five facts of the risk model, in words. Axes the caller does not give are left out. */
export function WhyCells({ values }: { values: Readonly<Partial<Record<WhyAxis, string>>> }) {
  return (
    <dl className={styles.cells}>
      {WHY_ORDER.filter((axis) => values[axis] !== undefined).map((axis) => (
        <div key={axis} className={styles.cell}>
          <dt>{WHY_LABELS[axis]}</dt>
          <dd>{whyValue(axis, values[axis] ?? '')}</dd>
        </div>
      ))}
    </dl>
  );
}
