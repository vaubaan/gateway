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

import { cn } from '@/lib/utils';

/*
 * The table's look, on the table itself (shadcn/ui's Table written for the
 * attention budget, on the shared tokens): every cell is styled through what
 * it is — its row's tone (`data-tone`), a group's head (`data-group`), a row's
 * detail (`data-detail-row`), a detail column (`data-detail`), the actions
 * (`data-actions`), a figure (`data-align`).
 */
const TABLE = [
  'w-full border-collapse text-body',
  '[&_th]:border-b [&_th]:border-border [&_th]:px-(--cell-x) [&_th]:py-1.5 [&_th]:text-left [&_th]:text-caption [&_th]:font-normal [&_th]:whitespace-nowrap [&_th]:text-muted-foreground',
  '[&_td]:border-b [&_td]:border-border [&_td]:px-(--cell-x) [&_td]:py-(--cell-y) [&_td]:align-middle [&_td]:text-foreground',
  '[&_tbody:last-child_tr:last-child_td]:border-b-0',
  '[&_tbody_tr:not([data-tone=bad],[data-tone=warn],[data-detail-row]):hover_td]:bg-accent',
  // Detail columns: on demand, through a DetailScope or the `details` prop.
  '[&_[data-detail]]:hidden',
  '[[data-details=open]_&_td[data-detail]]:table-cell [[data-details=open]_&_th[data-detail]]:table-cell [[data-details=open]_&_col[data-detail]]:table-column',
  '[&[data-details=open]_td[data-detail]]:table-cell [&[data-details=open]_th[data-detail]]:table-cell [&[data-details=open]_col[data-detail]]:table-column',
  // The exception rows. The text of the row says what the tint says.
  '[&_tbody_tr[data-tone=bad]_td]:bg-refused-bg [&_tbody_tr[data-tone=warn]_td]:bg-approval-bg [&_tbody_tr[data-tone=quiet]_td]:text-muted-foreground',
  '[&_tbody_tr[data-detail-row]_td]:bg-sidebar [&_tbody_tr[data-detail-row]_td]:pt-3 [&_tbody_tr[data-detail-row]_td]:pr-4 [&_tbody_tr[data-detail-row]_td]:pb-4 [&_tbody_tr[data-detail-row]_td]:pl-12',
  '[&_tbody_tr[data-group]_th]:bg-sidebar [&_tbody_tr[data-group]_th]:font-semibold',
  // Row actions appear when the row is pointed at or holds the keyboard focus (transparent,
  // not hidden: the keyboard still reaches them); a device that cannot hover always shows them.
  '[&_[data-actions]>*]:opacity-0 [&_tr:hover_[data-actions]>*]:opacity-100 [&_tr:focus-within_[data-actions]>*]:opacity-100 [@media(hover:none)]:[&_[data-actions]>*]:opacity-100 max-sm:[&_[data-actions]>*]:opacity-100',
].join(' ');

/*
 * A phone. Five columns in 390 px wrap word by word, so a row is drawn as a
 * block: its first cell is the title, every other cell is a line — the name of
 * its column in the quiet ink, then the value. The head leaves the drawing
 * (each line carries its column's name) and stays in the document.
 */
const STACK = [
  'max-sm:block max-sm:[&_tbody]:block max-sm:[&_tr]:block max-sm:[&_td]:block max-sm:[&_tbody_th]:block max-sm:[&_colgroup]:hidden max-sm:[&_thead]:sr-only',
  'max-sm:[&_tbody_tr]:border-b max-sm:[&_tbody_tr]:border-border max-sm:[&_tbody_tr]:py-2.5 max-sm:[&_tbody:last-child_tr:last-child]:border-b-0',
  'max-sm:[&_td]:border-b-0 max-sm:[&_td]:px-1 max-sm:[&_td]:py-0.5 max-sm:[&_td]:whitespace-normal max-sm:[&_td]:[overflow-wrap:anywhere] max-sm:[&_td:empty]:hidden max-sm:[&_[data-align=right]]:text-left',
  // A line of the block: the column's name, then its value.
  'max-sm:[&_td[data-label]]:relative max-sm:[&_td[data-label]]:pl-[calc(96px+0.75rem)]',
  'max-sm:[&_td[data-label]]:before:absolute max-sm:[&_td[data-label]]:before:top-0.5 max-sm:[&_td[data-label]]:before:left-1 max-sm:[&_td[data-label]]:before:w-[96px] max-sm:[&_td[data-label]]:before:overflow-hidden max-sm:[&_td[data-label]]:before:text-caption max-sm:[&_td[data-label]]:before:leading-[calc(var(--text-small)*1.5)] max-sm:[&_td[data-label]]:before:text-ellipsis max-sm:[&_td[data-label]]:before:whitespace-nowrap max-sm:[&_td[data-label]]:before:text-muted-foreground max-sm:[&_td[data-label]]:before:content-[attr(data-label)]',
  'max-sm:[[data-details=open]_&_td[data-detail]]:block max-sm:[&[data-details=open]_td[data-detail]]:block',
  'max-sm:[&_td[data-actions]]:pt-2 max-sm:[&_td[data-actions]]:text-left max-sm:[&_td[data-actions]]:whitespace-normal',
  // A tinted row is tinted as a whole, not cell by cell.
  'max-sm:[&_tbody_tr[data-tone=bad]]:bg-refused-bg max-sm:[&_tbody_tr[data-tone=warn]]:bg-approval-bg max-sm:[&_tbody_tr[data-tone=bad]_td]:bg-transparent max-sm:[&_tbody_tr[data-tone=warn]_td]:bg-transparent max-sm:[&_tbody_tr:not([data-tone=bad],[data-tone=warn],[data-detail-row]):hover_td]:bg-transparent',
  'max-sm:[&_tbody_tr[data-detail-row]]:p-0 max-sm:[&_tbody_tr[data-detail-row]_td]:p-3 max-sm:[&_tbody_tr[data-group]]:p-0',
].join(' ');

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

/** What a cell is, said as attributes the table's rules read. */
function cellAttributes<Row>(column: Column<Row>) {
  return {
    className:
      cn(
        column.align === 'right' && 'text-right tabular-nums',
        column.nowrap && 'whitespace-nowrap',
      ) || undefined,
    'data-align': column.align === 'right' ? 'right' : undefined,
    'data-detail': column.detail ? '' : undefined,
  };
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
      <tr key={key} role="row" data-tone={tone} data-row={key}>
        {columns.map((column, index) => (
          <td
            key={column.id}
            role="cell"
            {...cellAttributes(column)}
            data-column={column.id}
            data-label={stackLabel(column, index, headless)}
          >
            {column.cell(row)}
          </td>
        ))}
        {actions && (
          <td role="cell" className="text-right whitespace-nowrap" data-actions="">
            {actions(row)}
          </td>
        )}
      </tr>,
      detail ? (
        <tr key={`${key}:detail`} role="row" data-detail-row="">
          <td role="cell" colSpan={span}>
            {detail}
          </td>
        </tr>
      ) : null,
    ];
  };

  return (
    // A wide table scrolls inside its own box; the page never scrolls sideways. The box is the
    // containing block of what a cell hides for assistive technology.
    <div className="relative max-w-full overflow-x-auto">
      <table
        role="table"
        className={cn(TABLE, density === 'tight' && '[&_td]:py-[7px]', narrow === 'stack' && STACK)}
        data-narrow={narrow}
        data-details={details ? 'open' : undefined}
        data-testid={testId}
      >
        <caption className="vbn-sr-only">{caption}</caption>
        {columns.some((column) => column.width) && (
          <colgroup>
            {columns.map((column) => (
              <col
                key={column.id}
                data-detail={column.detail ? '' : undefined}
                style={column.width ? { width: column.width } : undefined}
              />
            ))}
            {actions && <col />}
          </colgroup>
        )}
        <thead role="rowgroup" className={headless ? 'vbn-sr-only' : undefined}>
          <tr role="row">
            {columns.map((column) => (
              <th key={column.id} role="columnheader" scope="col" {...cellAttributes(column)}>
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
              <tr role="row" data-group="">
                <th role="rowheader" colSpan={span} scope="rowgroup">
                  {group.title}
                  {group.note && (
                    <span className="ml-1.5 font-normal text-muted-foreground">{group.note}</span>
                  )}
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
