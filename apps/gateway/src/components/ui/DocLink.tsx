'use client';

/**
 * The pointer to the documentation: a small (i) that opens, in a new tab, the
 * page of the user docs explaining where one is (docs/handbook/web-app.md,
 * "doc links").
 *
 * - At the right of a page's title (`PageHeader`'s `doc`), on every page that
 *   has a page in the docs.
 * - Inside a form, beside a concept that trips people (a trust level, the
 *   resources found later, an environment label): a few, no more.
 *
 * The target is an entry of `DOC_PAGES` or `serviceDoc` (`lib/vocabulary.ts`),
 * never a path written in a page. The docs root comes from the instance's
 * configuration (`docs.url`) through `DocsProvider`, which the shell renders;
 * outside it (a test, the gallery's previews) the link draws nothing.
 */
import { createContext, useContext } from 'react';

import { docHref } from '@/lib/docs-links';
import { docLinkLabel, type DocTarget } from '@/lib/vocabulary';

import styles from './DocLink.module.css';

const DocsRootContext = createContext<string | null>(null);

/** Rendered by the shell with `root.config.docs.url`. */
export function DocsProvider({ root, children }: { root: string; children: React.ReactNode }) {
  return <DocsRootContext.Provider value={root}>{children}</DocsRootContext.Provider>;
}

export function DocLink({ to, testId }: { to: DocTarget; testId?: string }) {
  const root = useContext(DocsRootContext);
  if (!root) return null;
  const label = docLinkLabel(to);
  return (
    <a
      className={styles.doc}
      href={docHref(root, to)}
      target="_blank"
      rel="noreferrer noopener"
      aria-label={label}
      title={label}
      data-testid={testId ?? 'doc-link'}
    >
      <span aria-hidden="true">i</span>
    </a>
  );
}
