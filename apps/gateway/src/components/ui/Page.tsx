/**
 * The frame of a page, inside the application shell.
 *
 * - `PageHeader` — where one is (crumbs), the title, **one sentence** of lede
 *   at most, **one primary action** and at most two secondary ones.
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
 */
import Link from 'next/link';

import { formatNumber } from '@/lib/vocabulary';

import styles from './Page.module.css';
import { TrailSetter } from './Trail';

export type PageWidth = 'narrow' | 'default' | 'wide';

export interface Crumb {
  readonly label: string;
  /** Absent on the last crumb: where one is. */
  readonly href?: string;
}

export function Crumbs({ items }: { items: readonly Crumb[] }) {
  return (
    <nav className={styles.crumbs} aria-label="Breadcrumb">
      {items.map((item, index) => (
        <span key={`${item.label}:${index}`} className={styles.crumb}>
          {index > 0 && (
            <span className={styles.crumbSep} aria-hidden="true">
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
  /** The measure of the page column: `narrow` for one object or a form, `wide` for a table. */
  width?: PageWidth;
  /** `2` when the header is shown inside another page (a preview, the gallery). */
  level?: 1 | 2;
}) {
  const Title = level === 1 ? 'h1' : 'h2';
  const label = title;
  const hasActions = Boolean(primary) || Boolean(secondary) || Boolean(more);
  return (
    <header className={styles.header} data-page-width={level === 1 ? width : undefined}>
      {/* The page's place, for the path bar of the shell: its crumbs, then its title. */}
      {level === 1 && <TrailSetter items={[...(crumbs ?? []), { label }]} />}
      <div className={styles.headerRow}>
        <div className={styles.headerText}>
          <Title className={styles.title}>
            {mark && <span className={styles.titleMark}>{mark}</span>}
            <span>{title}</span>
            {status && <span className={styles.titleStatus}>{status}</span>}
          </Title>
          {lede && <p className={styles.lede}>{lede}</p>}
        </div>
        {hasActions && (
          <div className={styles.actions}>
            {secondary?.map((action, index) => (
              // A fixed, ordered pair: the index is its identity.
              <span key={index} className={styles.action}>
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
    <div className={styles.sectionHead}>
      <Heading className={styles.sectionTitle} id={id}>
        {title}
        {count !== undefined && (
          <span className={styles.sectionCount}>
            {typeof count === 'number' ? formatNumber(count) : count}
          </span>
        )}
      </Heading>
      {note && <div className={styles.sectionNote}>{note}</div>}
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
      className={[styles.section, first ? styles.sectionFirst : ''].join(' ')}
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
    <p className={[styles.summary, centered ? styles.summaryCentered : ''].join(' ')}>
      {items.map((item, index) =>
        item.href ? (
          <Link key={index} href={item.href} className={styles.summaryLink}>
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
    <dl className={styles.kv}>
      {items.map((item, index) => (
        <div key={index} className={styles.kvRow}>
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
    <dl className={styles.stats}>
      {items.map((item) => (
        <div key={item.label}>
          <dt className={styles.statLabel}>{item.label}</dt>
          <dd
            className={[styles.statValue, item.tone ? styles[`stat_${item.tone}`] : ''].join(' ')}
          >
            {item.value}
            {item.note && <span className={styles.statNote}>{item.note}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Quiet secondary text under a list: what is not shown, and where it is. */
export function Hint({ children }: { children: React.ReactNode }) {
  return <p className={styles.hint}>{children}</p>;
}
