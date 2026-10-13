/**
 * The frame of a page outside the application shell: the sign-in, the first
 * sign-in of whoever installs the gateway, "not found" and "something went
 * wrong" when no shell can be drawn. One narrow column in the middle of the
 * window — the product and where this gateway lives, then the page — and the
 * build line where the page ends (`footer`).
 *
 * No hook: it renders in server and client components alike. It reads the
 * tokens, so it follows the theme the person chose like every other page.
 */
import { PRODUCT } from '@/lib/vocabulary';

import styles from './auth.module.css';

export function AuthPage({
  instance,
  footer,
  children,
}: {
  /** Where this gateway lives: the host of its public address. Absent when the page cannot know. */
  instance?: string | null;
  /** The build line (`BuildFooter`), given by a server page; a client page has none. */
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <main className={styles.column}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            {PRODUCT.mark}
          </span>
          <span className={styles.brandText}>
            <span className={styles.brandName}>{PRODUCT.name}</span>
            {instance && <span className={styles.brandInstance}>{instance}</span>}
          </span>
        </div>
        {children}
      </main>
      {footer}
    </div>
  );
}

/** The title of such a page and its one sentence. */
export function AuthHeading({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <>
      <h1 className={styles.heading}>{title}</h1>
      {children && <p className={styles.sentence}>{children}</p>}
    </>
  );
}
