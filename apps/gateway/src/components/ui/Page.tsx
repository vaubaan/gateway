/**
 * The frame of a page, inside the application shell.
 *
 * - `PageHeader` — where one is (crumbs), the title with its (i) to the docs
 *   (`doc`, a `DOC_PAGES` entry), **one sentence** of lede at most, **one
 *   primary action** and at most two secondary ones.
 * - `Section` / `SectionHeading` — a region of the page: a heading, an
 *   optional count, an optional short note on the right. Sections are
 *   separated by whitespace (`--section-gap`), not by boxes.
 * - `SummaryLine` — the counts that lead elsewhere ("4 missions running ·
 *   3 refused in the last hour"): overview first, details on demand.
 * - `KeyValue` — a definition list for the facts of one object.
 * - `Stats` — a few labelled figures, in the detailed views only.
 *
 * The attention budget these serve (style guide §1): above the fold at
 * 1440×900, at most three regions, one focal point, fifteen to twenty-five
 * data points.
 *
 * Tailwind on the shared tokens: the classes of each part are named once, in
 * `S`, so the markup below reads as it did.
 */
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { formatNumber, type DocTarget } from '@/lib/vocabulary';

import { DocHint } from './DocHint';
import { TrailSetter } from './Trail';

/** The parts of a page's frame. A narrow window puts the actions under the title. */
const S = {
  header: 'mb-[22px]',
  crumbs: 'mb-2 flex flex-wrap items-center gap-1.5 text-small text-muted-foreground',
  crumb: 'inline-flex gap-1.5 [&_a:hover]:text-foreground [&_a:hover]:no-underline',
  crumbSep: 'text-faint',
  headerRow: 'flex items-start justify-between gap-6 max-[720px]:flex-col max-[720px]:gap-3',
  headerText: 'min-w-0',
  titleLine: 'flex items-center gap-2',
  title:
    'm-0 flex flex-wrap items-center gap-x-3 gap-y-2 text-title leading-snug font-semibold tracking-(--tracking-title)',
  titleMark: 'inline-flex',
  titleStatus: 'inline-flex',
  lede: 'mt-[3px] mb-0 max-w-(--measure) text-small text-muted-foreground',
  actions: 'flex flex-none items-center gap-2 pt-0.5 max-[720px]:flex-wrap',
  action: 'inline-flex',
  section: 'mt-(--section-gap)',
  sectionFirst: 'mt-0',
  sectionHead:
    'mb-2.5 flex items-baseline justify-between gap-4 max-[720px]:flex-col max-[720px]:gap-0.5',
  sectionTitle: 'm-0 flex-none text-body font-semibold whitespace-nowrap [&:is(h3)]:text-small',
  sectionCount: 'ml-1.5 tabular-nums text-muted-foreground',
  sectionNote:
    'flex min-w-0 items-center gap-3 text-right text-body text-muted-foreground max-[720px]:text-left [&_a]:text-primary',
  summary: 'm-0 flex flex-wrap gap-x-[18px] gap-y-1 text-body tabular-nums text-muted-foreground',
  summaryCentered: 'justify-center',
  summaryLink: 'text-primary',
  kv: 'm-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-[18px] gap-y-1.5 text-small [&_dd]:m-0 [&_dd]:min-w-0 [&_dt]:text-muted-foreground',
  kvRow: 'contents',
  stats: 'm-0 flex flex-wrap gap-x-10 gap-y-4',
  statLabel: 'text-caption text-muted-foreground',
  statValue: 'mt-px mb-0 text-body font-semibold tabular-nums',
  stat_warn: 'text-approval-fg',
  stat_bad: 'text-refused-fg',
  statNote: 'ml-1 text-caption font-normal text-muted-foreground',
  hint: 'mt-2.5 mb-0 max-w-(--measure) text-small text-muted-foreground [&_a]:text-primary',
} as const;

export type PageWidth = 'narrow' | 'default' | 'wide';

export interface Crumb {
  readonly label: string;
  /** Absent on the last crumb: where one is. */
  readonly href?: string;
}

export function Crumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav className={S.crumbs} aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={`${item.label}:${index}`} className={S.crumb}>
          {index > 0 && (
            <span className={S.crumbSep} aria-hidden="true">
              /
            </span>
          )}
          {item.href ? (
            <Link href={item.href}>{item.label}</Link>
          ) : (
            <span aria-current="page">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

export function PageHeader({
  title,
  lede,
  crumbs,
  mark,
  status,
  primary,
  secondary,
  more,
  doc,
  width = 'default',
  level = 1,
}: {
  title: React.ReactNode;
  /** One sentence. A page explains itself in its title and its content, not in a paragraph. */
  lede?: React.ReactNode;
  crumbs?: readonly Crumb[];
  /** A mark before the title: the service of an account. */
  mark?: React.ReactNode;
  /** The exception this object is in, beside its title (a `StatusMark`). */
  status?: React.ReactNode;
  /** The one primary action of the screen. */
  primary?: React.ReactNode;
  /** At most two secondary actions: the type refuses a third. */
  secondary?: readonly [React.ReactNode] | readonly [React.ReactNode, React.ReactNode];
  /** Everything else, behind "···". */
  more?: React.ReactNode;
  /** The page of the user docs that explains this one: an (i) after the title showing its context, with a link to its docs. */
  doc?: DocTarget;
  /** The measure of the page column: `narrow` for one object or a form, `wide` for a table. */
  width?: PageWidth;
  /** `2` when the header is shown inside another page (a preview, the gallery). */
  level?: 1 | 2;
}) {
  const Title = level === 1 ? 'h1' : 'h2';
  const label = title;
  const hasActions = Boolean(primary) || Boolean(secondary) || Boolean(more);
  return (
    <header className={S.header} data-page-width={level === 1 ? width : undefined}>
      {/* The page's place, for the path bar of the shell: its crumbs, then its title. */}
      {level === 1 && <TrailSetter items={[...(crumbs ?? []), { label }]} />}
      <div className={S.headerRow}>
        <div className={S.headerText}>
          <div className={S.titleLine}>
            <Title className={S.title}>
              {mark && <span className={S.titleMark}>{mark}</span>}
              <span>{title}</span>
              {status && <span className={S.titleStatus}>{status}</span>}
            </Title>
            {doc && <DocHint to={doc} testId="page-doc-link" />}
          </div>
          {lede && <p className={S.lede}>{lede}</p>}
        </div>
        {hasActions && (
          <div className={S.actions}>
            {secondary?.map((action, index) => (
              // A fixed, ordered pair: the index is its identity.
              <span key={index} className={S.action}>
                {action}
              </span>
            ))}
            {primary}
            {more}
          </div>
        )}
      </div>
    </header>
  );
}

export function SectionHeading({
  title,
  count,
  note,
  level = 2,
  id,
}: {
  title: React.ReactNode;
  /** How many things the section lists; a string for "612 today". */
  count?: number | string;
  /** A short sentence or a link on the right: what the list is, or where the rest is. */
  note?: React.ReactNode;
  level?: 2 | 3;
  id?: string;
}) {
  const Heading = level === 2 ? 'h2' : 'h3';
  return (
    <div className={S.sectionHead}>
      <Heading className={S.sectionTitle} id={id}>
        {title}
        {count !== undefined && (
          <span className={S.sectionCount}>
            {typeof count === 'number' ? formatNumber(count) : count}
          </span>
        )}
      </Heading>
      {note && <div className={S.sectionNote}>{note}</div>}
    </div>
  );
}

export function Section({
  title,
  count,
  note,
  id,
  first = false,
  children,
  testId,
}: {
  title?: React.ReactNode;
  count?: number | string;
  note?: React.ReactNode;
  /** The anchor of the section; the heading is its accessible name. */
  id?: string;
  /** The first region of a page sits right under the header: no gap above it. */
  first?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      className={cn(S.section, first && S.sectionFirst)}
      aria-labelledby={title ? headingId : undefined}
      data-testid={testId}
    >
      {title && <SectionHeading title={title} count={count} note={note} id={headingId} />}
      {children}
    </section>
  );
}

export interface SummaryItem {
  readonly label: React.ReactNode;
  /** A count that leads to its list is a link; a plain fact is not. */
  readonly href?: string;
}

export function SummaryLine({
  items,
  centered = false,
}: {
  items: readonly SummaryItem[];
  centered?: boolean;
}) {
  return (
    <p className={cn(S.summary, centered && S.summaryCentered)}>
      {items.map((item, index) =>
        item.href ? (
          <Link key={index} href={item.href} className={S.summaryLink}>
            {item.label}
          </Link>
        ) : (
          <span key={index}>{item.label}</span>
        ),
      )}
    </p>
  );
}

export function KeyValue({
  items,
}: {
  items: readonly { readonly term: React.ReactNode; readonly value: React.ReactNode }[];
}) {
  return (
    <dl className={S.kv}>
      {items.map((item, index) => (
        <div key={index} className={S.kvRow}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface Stat {
  readonly label: string;
  readonly value: React.ReactNode;
  /** A few words after the figure, in the quiet ink. */
  readonly note?: React.ReactNode;
  /** Coloured only when the figure is an exception. */
  readonly tone?: 'warn' | 'bad';
}

export function Stats({ items }: { items: readonly Stat[] }) {
  return (
    <dl className={S.stats}>
      {items.map((item) => (
        <div key={item.label}>
          <dt className={S.statLabel}>{item.label}</dt>
          <dd className={cn(S.statValue, item.tone && S[`stat_${item.tone}`])}>
            {item.value}
            {item.note && <span className={S.statNote}>{item.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Quiet secondary text under a list: what is not shown, and where it is. */
export function Hint({ children }: { children: React.ReactNode }) {
  return <p className={S.hint}>{children}</p>;
}
