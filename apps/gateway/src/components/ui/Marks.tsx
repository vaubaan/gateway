/**
 * The three small marks of a permission, the same on every page.
 *
 * - `SeverityChip` — one word: low, medium, high, critical. Low is written
 *   plainly; only medium and above take a colour.
 * - `GateMark` — what happens when the agent uses the permission: it **runs
 *   freely**, or it must **ask me first**; `off` is "not included". A dot and
 *   the words: never the dot alone.
 * - `WhyCells` — the six words behind a severity (undo, blast radius, data,
 *   cost, visible to, lasts), each labelled. Shown behind "why?", never by
 *   default.
 *
 * No hook: these render in server and client components alike.
 */
import {
  GATE_WORDS,
  WHY_LABELS,
  WHY_ORDER,
  whyValue,
  type GateWord,
  type SeverityWord,
  type WhyAxis,
} from '@/lib/vocabulary';

import styles from './Marks.module.css';

export function SeverityChip({ level }: { level: SeverityWord }) {
  return (
    <span
      className={[styles.severity, styles[`severity_${level}`]].join(' ')}
      data-severity={level}
    >
      {level}
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

/** The six cells of the risk model, in words. Axes the caller does not give are left out. */
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
