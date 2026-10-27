'use client';

/**
 * The frame of the gallery: a section per component, and inside it specimens.
 * A specimen is drawn twice — once on a light island, once on a dark one —
 * so that both themes are compared on one screen whatever the theme of the
 * page. `children` receives the theme so that ids stay unique.
 */
import type { ServiceMarkIcon } from '@/components/ui';
import type { ChosenTheme } from '@/lib/theme';

import styles from './design.module.css';

const THEMES: readonly ChosenTheme[] = ['light', 'dark'];

export function GallerySection({
  id,
  title,
  rule,
  children,
}: {
  id: string;
  title: string;
  /** The rule of use, in a sentence: when the component is the right one. */
  rule: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className={styles.section} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.sectionTitle}>
        {title}
      </h2>
      <p className={styles.rule}>{rule}</p>
      {children}
    </section>
  );
}

export function Specimen({
  name,
  note,
  children,
}: {
  /** The state or the variant shown: "near the limit", "disabled". */
  name: string;
  note?: React.ReactNode;
  children: (theme: ChosenTheme) => React.ReactNode;
}) {
  return (
    <div className={styles.specimen} data-specimen={name}>
      <div className={styles.specimenHead}>
        <h3 className={styles.specimenName}>{name}</h3>
        {note && <span className={styles.specimenNote}>{note}</span>}
      </div>
      <div className={styles.islands}>
        {THEMES.map((theme) => (
          <div key={theme} className={styles.island} data-theme={theme}>
            <span className={styles.islandLabel}>{theme}</span>
            {children(theme)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Lays a few small things of one specimen in a wrapping line. */
export function Line({ children }: { children: React.ReactNode }) {
  return <div className={styles.line}>{children}</div>;
}

/** Stacks a few things of one specimen. */
export function Pile({ children }: { children: React.ReactNode }) {
  return <div className={styles.pile}>{children}</div>;
}

/**
 * The marks of the shipped services, by provider id (path and brand colour),
 * read from the registry by the server page: the gallery shows real icons
 * beside the lettered fallback, without a list of its own.
 */
export type GalleryIcons = Readonly<Record<string, ServiceMarkIcon>>;
