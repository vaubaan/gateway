/**
 * The three small marks of a permission, the same on every page.
 *
 * - `RowChip` — the row of the permission in words (Harmless, Worth a
 *   look, Repairable, at a price, Cannot be repaired), a light pill in the
 *   row's own hue (green, cool grey, soft plum, deep plum: `row-1…4` of the
 *   shared theme), row 4 in the strong weight; the reason that put it there
 *   follows in quiet type when asked. No gauge, no icon: the word carries the
 *   order (style guide §5).
 * - `GateMark` — what happens when the agent uses the permission: it **runs
 *   freely**, or it must **ask me first**; `off` is "not included". A dot and
 *   the words: never the dot alone.
 * - `WhyCells` — the five facts behind a row (undo, blast radius, data,
 *   cost, visible to), each labelled. Shown behind "why?" on the Reference
 *   only, never by default.
 *
 * No hook: these render in server and client components alike. Styled with
 * Tailwind on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site).
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

import { cn } from '@/lib/utils';

const ROW_PILL: Readonly<Record<Row, string>> = {
  1: 'row-1 font-normal',
  2: 'row-2 font-normal',
  3: 'row-3 font-normal',
  4: 'row-4',
};

const GATE_STYLE: Readonly<Record<GateWord, string>> = {
  free: 'text-muted-foreground before:bg-allowed',
  ask: 'text-approval-fg before:bg-approval',
  off: 'text-muted-foreground before:border-[1.5px] before:border-faint',
};

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
    <span
      className={cn('text-caption', inline ? 'whitespace-nowrap' : 'inline-block')}
      data-row={row}
    >
      <span
        className={cn(
          'inline-flex h-[22px] items-center whitespace-nowrap rounded-md border px-2 text-caption',
          ROW_PILL[row],
        )}
      >
        {ROW_WORDS[row]}
      </span>
      {reason ? (
        <>
          {inline ? ' · ' : ' '}
          <span className={cn('font-normal text-muted-foreground', inline ? null : 'mt-0.5 block')}>
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
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-caption before:size-1.5 before:flex-none before:rounded-full before:content-['']",
        GATE_STYLE[gate],
      )}
      data-gate={gate}
    >
      {children ?? GATE_WORDS[gate]}
    </span>
  );
}

/** The five facts of the risk model, in words. Axes the caller does not give are left out. */
export function WhyCells({ values }: { values: Readonly<Partial<Record<WhyAxis, string>>> }) {
  return (
    <dl className="m-0 flex flex-wrap gap-1">
      {WHY_ORDER.filter((axis) => values[axis] !== undefined).map((axis) => (
        <div
          key={axis}
          className="flex flex-col whitespace-nowrap rounded-sm border border-border bg-card px-2 py-1 text-caption"
        >
          <dt className="text-muted-foreground">{WHY_LABELS[axis]}</dt>
          <dd className="m-0 text-foreground">{whyValue(axis, values[axis] ?? '')}</dd>
        </div>
      ))}
    </dl>
  );
}
