/**
 * Tables. Hairlines between rows, no zebra, no filled head, no card around.
 *
 * `DataTable` is what a page uses: typed columns, **five by default**. More
 * columns are marked `detail` and stay hidden until the person asks for them
 * through a `DetailScope` ("Show details", remembered per page) — the detailed
 * level may go to seven. A table that needs more than that is two tables.
 *
 * On a phone a table is not a grid: five columns in 390 px wrap word by word.
 * Each row is drawn as a block instead — its first cell as the title, then one
 * line per column with the column's name before the value — and the actions of
 * the row are always drawn, since a finger cannot hover. The roles are written
 * out so that the table stays a table for assistive technology whatever its
 * drawing. A table that must stay a grid (few narrow columns) opts out with
 * `narrow="scroll"` and scrolls inside its own box.
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
  /**
   * The column's name before its value when a row is drawn as a block (a
   * phone). By default the `header` when it is text; `null` draws the value
   * alone, on the whole line.
   */
  readonly label?: string | null;
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
  /**
   * What the table becomes on a phone: `stack` (the default) draws each row as
   * a block; `scroll` keeps the grid and scrolls it inside its own box.
   */
  readonly narrow?: 'stack' | 'scroll';
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

/** The name drawn before a value in a stacked row; `undefined` draws the value alone. */
export function stackLabel<Row>(
  column: Pick<Column<Row>, 'header' | 'label'>,
  index: number,
  headless: boolean,
): string | undefined {
  // The first cell is the row's title; a table without a head names no column.
  if (index === 0 || headless || column.label === null) return undefined;
  if (column.label !== undefined) return column.label;
  return typeof column.header === 'string' && column.header !== '' ? column.header : undefined;
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
  narrow = 'stack',
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
      <tr key={key} role="row" className={tone ? styles[`row_${tone}`] : undefined} data-row={key}>
        {columns.map((column, index) => (
          <td
            key={column.id}
            role="cell"
            className={cellClasses(column)}
            data-column={column.id}
            data-label={stackLabel(column, index, headless)}
          >
            {column.cell(row)}
          </td>
        ))}
        {actions && (
          <td role="cell" className={styles.actions}>
            {actions(row)}
          </td>
        )}
      </tr>,
      detail ? (
        <tr key={`${key}:detail`} role="row" className={styles.rowDetail}>
          <td role="cell" colSpan={span}>
            {detail}
          </td>
        </tr>
      ) : null,
    ];
  };

  return (
    <div className={styles.scroll}>
      <table
        role="table"
        className={[
          styles.table,
          density === 'tight' ? styles.tight : '',
          narrow === 'stack' ? styles.stack : '',
        ].join(' ')}
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
        <thead role="rowgroup" className={headless ? 'vbn-sr-only' : undefined}>
          <tr role="row">
            {columns.map((column) => (
              <th key={column.id} role="columnheader" scope="col" className={cellClasses(column)}>
                {column.header}
              </th>
            ))}
            {actions && (
              <th role="columnheader" scope="col">
                <span className="vbn-sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        {groups ? (
          groups.map((group) => (
            <tbody key={group.key} role="rowgroup">
              <tr role="row" className={styles.group}>
                <th role="rowheader" colSpan={span} scope="rowgroup">
                  {group.title}
                  {group.note && <span className={styles.groupNote}>{group.note}</span>}
                </th>
              </tr>
              {group.rows.map(renderRow)}
            </tbody>
          ))
        ) : (
          <tbody role="rowgroup">{all.map(renderRow)}</tbody>
        )}
      </table>
    </div>
  );
}
