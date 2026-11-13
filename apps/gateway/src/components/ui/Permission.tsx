'use client';

/**
 * A permission, as a row: what it lets an agent do in words, its id in mono
 * (a person may need to quote it), its row and the reason that put it there,
 * its limits per day and per minute, whether it runs freely or asks first,
 * and — one click away — why it is rated the way it is.
 *
 * `PermissionTable` chooses the columns once (`variant`) and its rows follow:
 *
 * | variant  | columns                                                        | used for                         |
 * | -------- | -------------------------------------------------------------- | -------------------------------- |
 * | `editor` | tick · permission · risk · per day · per minute · ask me first | the granular editor of a mission |
 * | `read`   | permission · risk · per day · per minute · gate                | what a mission holds             |
 * | `usage`  | permission · used today · per minute · gate                    | a mission, today                 |
 * | `pick`   | tick · permission · risk                                       | the ceiling given with an access |
 *
 * The list is always explicit: a row is a permission that is there, or one
 * that is shown as not included. Nothing here ever stands for "all".
 */
import { createContext, useContext, useId, useState } from 'react';

import {
  ACTIONS,
  formatNumber,
  LIMIT_WORDS,
  ROW_LABEL,
  type GateWord,
  type Reason,
  type Row,
  type WhyAxis,
} from '@/lib/vocabulary';

import { GateMark, RowChip, WhyCells } from './Marks.tsx';
import styles from './Permission.module.css';

export type PermissionVariant = 'editor' | 'read' | 'usage' | 'pick';

interface Layout {
  readonly select: boolean;
  readonly row: boolean;
  readonly usage: boolean;
  readonly perDay: boolean;
  readonly perMinute: boolean;
  readonly gate: boolean;
  readonly gateHeader: string;
}

const LAYOUTS: Readonly<Record<PermissionVariant, Layout>> = {
  editor: {
    select: true,
    row: true,
    usage: false,
    perDay: true,
    perMinute: true,
    gate: true,
    gateHeader: 'Ask me first',
  },
  read: {
    select: false,
    row: true,
    usage: false,
    perDay: true,
    perMinute: true,
    gate: true,
    gateHeader: 'When used',
  },
  usage: {
    select: false,
    row: false,
    usage: true,
    perDay: false,
    perMinute: true,
    gate: true,
    gateHeader: 'When used',
  },
  pick: {
    select: true,
    row: true,
    usage: false,
    perDay: false,
    perMinute: false,
    gate: false,
    gateHeader: '',
  },
};

function columnCount(layout: Layout): number {
  return (
    1 +
    Number(layout.select) +
    Number(layout.row) +
    Number(layout.usage) +
    Number(layout.perDay) +
    Number(layout.perMinute) +
    Number(layout.gate)
  );
}

const LayoutContext = createContext<Layout>(LAYOUTS.read);

export function PermissionTable({
  variant = 'read',
  caption,
  children,
  testId,
  labels,
}: {
  variant?: PermissionVariant;
  /** Names the table for assistive technology ("Permissions on GitHub · acme"). */
  caption: string;
  /** `PermissionGroup`s (or bare `PermissionRow`s inside one `<tbody>`). */
  children: React.ReactNode;
  testId?: string;
  /**
   * Other heads for the two columns that depend on the period of a mission whose
   * limits do not reset every day ("Per week", "Used this week"). Daily by default.
   */
  labels?: { readonly limit?: string; readonly usage?: string };
}) {
  const layout = LAYOUTS[variant];
  return (
    <LayoutContext.Provider value={layout}>
      <div className={styles.scroll}>
        <table className={styles.table} data-variant={variant} data-testid={testId}>
          <caption className="vbn-sr-only">{caption}</caption>
          <thead>
            <tr>
              {layout.select && (
                <th scope="col" className={styles.selectCell}>
                  <span className="vbn-sr-only">Included</span>
                </th>
              )}
              <th scope="col">Permission</th>
              {layout.row && <th scope="col">{ROW_LABEL}</th>}
              {layout.usage && <th scope="col">{labels?.usage ?? LIMIT_WORDS.usedToday}</th>}
              {layout.perDay && (
                <th scope="col" className={styles.number}>
                  {labels?.limit ?? LIMIT_WORDS.perDay}
                </th>
              )}
              {layout.perMinute && (
                <th scope="col" className={styles.number}>
                  {LIMIT_WORDS.perMinute}
                </th>
              )}
              {layout.gate && <th scope="col">{layout.gateHeader}</th>}
            </tr>
          </thead>
          {children}
        </table>
      </div>
    </LayoutContext.Provider>
  );
}

export function PermissionGroup({
  title,
  note,
  select,
  children,
}: {
  /** "Reads", "Writes on working branches", or an account ("GitHub · acme"). */
  title: React.ReactNode;
  /** A few quiet words: "look without changing anything", "3 of 5". */
  note?: React.ReactNode;
  /** A tick for the whole group (all, some, none), in the `pick` and `editor` variants. */
  select?: React.ReactNode;
  children: React.ReactNode;
}) {
  const layout = useContext(LayoutContext);
  const span = columnCount(layout) - (layout.select ? 1 : 0);
  return (
    <tbody>
      <tr className={styles.group}>
        {layout.select && <td className={styles.selectCell}>{select}</td>}
        <th colSpan={span} scope="rowgroup">
          {title}
          {note && <span className={styles.groupNote}>{note}</span>}
        </th>
      </tr>
      {children}
    </tbody>
  );
}

export interface PermissionWhy {
  /** Why it is rated this way, in a sentence or two. */
  readonly reason: React.ReactNode;
  /** The five facts of the risk model, by axis; values are the catalog's. The Reference only. */
  readonly cells?: Readonly<Partial<Record<WhyAxis, string>>>;
  /** Where the whole entry is: the reference of the service. */
  readonly referenceHref?: string;
  /** The tools behind the permission, as the protocol names them. */
  readonly tools?: readonly string[];
}

function limitCell(value: React.ReactNode): React.ReactNode {
  return typeof value === 'number' ? formatNumber(value) : value;
}

export function PermissionRow({
  label,
  id,
  row,
  rowReason,
  included = true,
  select,
  usage,
  perDay,
  perMinute,
  gate = 'free',
  gateControl,
  why,
  defaultWhyOpen = false,
  tag,
}: {
  /** What the permission lets an agent do, in words. */
  label: React.ReactNode;
  /** The protocol's id (`github.merge-protected`), printed in mono under the label. */
  id?: string;
  /** The row of the permission (risk model §4.6); required by the variants that show it. */
  row?: Row;
  /** The branch of the tree that put it there, in quiet type beside the row; none in row 1. */
  rowReason?: Reason | null;
  /** `false`: the permission is listed as not included (quiet row, no limits). */
  included?: boolean;
  /** The tick of the row (a `Checkbox`), in the `editor` and `pick` variants. */
  select?: React.ReactNode;
  /** A `Meter`, in the `usage` variant. */
  usage?: React.ReactNode;
  /** A number, or a control to edit it. */
  perDay?: React.ReactNode;
  perMinute?: React.ReactNode;
  gate?: GateWord;
  /** A `Switch` to change the gate, in the `editor` variant; the words follow it. */
  gateControl?: React.ReactNode;
  why?: PermissionWhy;
  defaultWhyOpen?: boolean;
  /** A fact after the label: the environment the permission applies to (an `EnvTag`). */
  tag?: React.ReactNode;
}) {
  const layout = useContext(LayoutContext);
  const [open, setOpen] = useState(defaultWhyOpen);
  const panelId = useId();
  const shownGate: GateWord = included ? gate : 'off';
  const whyButton = why && (
    <button
      type="button"
      className={styles.why}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => setOpen(!open)}
    >
      {open ? ACTIONS.hideWhy : ACTIONS.why}
    </button>
  );

  return (
    <>
      <tr className={included ? undefined : styles.out} data-permission={id}>
        {layout.select && <td className={styles.selectCell}>{select}</td>}
        <td>
          <span className={styles.label}>
            {label}
            {tag && <span className={styles.tag}>{tag}</span>}
          </span>
          {id && <code className={styles.id}>{id}</code>}
        </td>
        {layout.row && (
          <td className={styles.rowCell}>
            {row !== undefined && <RowChip row={row} reason={rowReason} />}
            {!layout.gate && whyButton}
          </td>
        )}
        {layout.usage && <td className={styles.usageCell}>{included ? usage : null}</td>}
        {layout.perDay && <td className={styles.number}>{included ? limitCell(perDay) : null}</td>}
        {layout.perMinute && (
          <td className={styles.number}>{included ? limitCell(perMinute) : null}</td>
        )}
        {layout.gate && (
          <td className={styles.gateCell}>
            <span className={styles.gateRow}>
              {included && gateControl}
              {(shownGate !== 'free' || !gateControl) && <GateMark gate={shownGate} />}
              {whyButton}
            </span>
          </td>
        )}
      </tr>
      {why && (
        <tr className={styles.whyRow} hidden={!open}>
          <td colSpan={columnCount(layout)} id={panelId}>
            <div className={styles.whyBox}>
              <div className={styles.reason}>
                {why.reason}
                {why.referenceHref && (
                  <>
                    {' '}
                    <a href={why.referenceHref} className={styles.reference}>
                      Full entry in the reference
                    </a>
                  </>
                )}
              </div>
              {why.cells && <WhyCells values={why.cells} />}
              {why.tools && why.tools.length > 0 && (
                <div className={styles.tools}>tools: {why.tools.join(', ')}</div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
