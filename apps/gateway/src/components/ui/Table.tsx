/**
 * Tables. Hairlines between rows, no zebra, no filled head, no card around.
 *
 * `DataTable` is what a page uses: typed columns, **five by default**. More
 * columns are marked `detail` and stay hidden until the person asks for them
 * through a `DetailScope` ("Show details", remembered per page) — the detailed
 * level may go to seven. A table that needs more than that is two tables.
 */

import styles from './Table.module.css';

/** The attention budget of a table (style guide §1). */
export const DEFAULT_COLUMN_BUDGET = 5;
export const DETAIL_COLUMN_BUDGET = 7;

export interface Column<Row> {
  /** Stable name of the column: its key and its `data-column`. */
  readonly id: string;
  readonly header: React.ReactNode;
  readonly cell: (row: Row) => React.ReactNode;
  /** Figures and times read better aligned right, in tabular numerals. */
  readonly align?: 'left' | 'right';
  /** Shown only when details are asked for. */
  readonly detail?: boolean;
  /** Kept on one line (a name, a date, an id). */
  readonly nowrap?: boolean;
  /** A CSS width (`34px`, `230px`, `20%`) for a column that must not move. */
  readonly width?: string;
}

/** A tint for the row that is the exception; the cell text still says why. */
export type RowTone = 'bad' | 'warn' | 'quiet';

export interface RowGroup<Row> {
  readonly key: string;
  readonly title: React.ReactNode;
  /** A few quiet words after the title ("acme/app, acme/web · 7 used of 12"). */
  readonly note?: React.ReactNode;
  readonly rows: readonly Row[];
}

export interface DataTableProps<Row> {
  readonly columns: readonly Column<Row>[];
  /** The rows, flat… */
  readonly rows?: readonly Row[];
  /** …or grouped under a quiet title each. */
  readonly groups?: readonly RowGroup<Row>[];
  readonly rowKey: (row: Row) => string;
  /** Names the table for assistive technology; not drawn. */
  readonly caption: string;
  /** The actions of a row, at its end: shown on hover and on keyboard focus. */
  readonly actions?: (row: Row) => React.ReactNode;
  readonly rowTone?: (row: Row) => RowTone | undefined;
  /** More about one row, under it, across the table (the detail of an activity record). */
  readonly rowDetail?: (row: Row) => React.ReactNode | null | undefined;
  /** A list of a few objects needs no head (the people of a mission). */
  readonly headless?: boolean;
  readonly density?: 'default' | 'tight';
  /**
   * `true` shows the detail columns whatever the scope says. By default they
   * follow the nearest `DetailScope`.
   */
  readonly details?: boolean;
  /**
   * How many columns are shown by default. Five; the Activity record is the
   * documented exception at six ("a log is rows").
   */
  readonly columnBudget?: number;
  /** What is said instead of the table when there is no row. */
  readonly empty?: React.ReactNode;
  readonly testId?: string;
}

/** Throws on a table over its budget: a programming error, caught at the first render. */
export function checkColumnBudget(
  columns: readonly Pick<Column<unknown>, 'id' | 'detail'>[],
  budget: number = DEFAULT_COLUMN_BUDGET,
): void {
  const byDefault = columns.filter((column) => !column.detail).length;
  if (byDefault > budget) {
    throw new Error(
      `DataTable: ${byDefault} columns by default, the budget is ${budget}. Mark the others \`detail\`.`,
    );
  }
  if (columns.length > Math.max(DETAIL_COLUMN_BUDGET, budget)) {
    throw new Error(
      `DataTable: ${columns.length} columns with details, the budget is ${DETAIL_COLUMN_BUDGET}.`,
    );
  }
}

function cellClasses<Row>(column: Column<Row>): string {
  return [
    column.align === 'right' ? styles.right : '',
    column.detail ? styles.detail : '',
    column.nowrap ? styles.nowrap : '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function DataTable<Row>({
  columns,
  rows,
  groups,
  rowKey,
  caption,
  actions,
  rowTone,
  rowDetail,
  headless = false,
  density = 'default',
  details,
  columnBudget = DEFAULT_COLUMN_BUDGET,
  empty,
  testId,
}: DataTableProps<Row>) {
  checkColumnBudget(columns, columnBudget);
  const all = groups ? groups.flatMap((group) => group.rows) : (rows ?? []);
  if (all.length === 0 && empty !== undefined) return <>{empty}</>;
  const span = columns.length + (actions ? 1 : 0);

  const renderRow = (row: Row) => {
    const tone = rowTone?.(row);
    const detail = rowDetail?.(row);
    const key = rowKey(row);
    return [
      <tr key={key} className={tone ? styles[`row_${tone}`] : undefined} data-row={key}>
        {columns.map((column) => (
          <td key={column.id} className={cellClasses(column)} data-column={column.id}>
            {column.cell(row)}
          </td>
        ))}
        {actions && <td className={styles.actions}>{actions(row)}</td>}
      </tr>,
      detail ? (
        <tr key={`${key}:detail`} className={styles.rowDetail}>
          <td colSpan={span}>{detail}</td>
        </tr>
      ) : null,
    ];
  };

  return (
    <div className={styles.scroll}>
      <table
        className={[styles.table, density === 'tight' ? styles.tight : ''].join(' ')}
        data-details={details ? 'open' : undefined}
        data-testid={testId}
      >
        <caption className="vbn-sr-only">{caption}</caption>
        {columns.some((column) => column.width) && (
          <colgroup>
            {columns.map((column) => (
              <col
                key={column.id}
                className={column.detail ? styles.detail : undefined}
                style={column.width ? { width: column.width } : undefined}
              />
            ))}
            {actions && <col />}
          </colgroup>
        )}
        <thead className={headless ? 'vbn-sr-only' : undefined}>
          <tr>
            {columns.map((column) => (
              <th key={column.id} scope="col" className={cellClasses(column)}>
                {column.header}
              </th>
            ))}
            {actions && (
              <th scope="col">
                <span className="vbn-sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        {groups ? (
          groups.map((group) => (
            <tbody key={group.key}>
              <tr className={styles.group}>
                <th colSpan={span} scope="rowgroup">
                  {group.title}
                  {group.note && <span className={styles.groupNote}>{group.note}</span>}
                </th>
              </tr>
              {group.rows.map(renderRow)}
            </tbody>
          ))
        ) : (
          <tbody>{all.map(renderRow)}</tbody>
        )}
      </table>
    </div>
  );
}
