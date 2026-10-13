/**
 * Technical text.
 *
 * - `Code` — inline: a tool name, a branch, a path. Mono on a quiet fill.
 * - `CodeBlock` — a snippet a person copies into a terminal or a file: dark
 *   in both themes, with a Copy button that copies exactly `copy` (or the
 *   text itself when the block holds a plain string).
 * - `CodeTone` — a keyword, a string or a comment inside a block. Colour
 *   helps the eye here and says nothing a reader needs.
 *
 * A secret is shown in a `CodeBlock` once, at creation; afterwards a page
 * shows its masked form (`KeyMark`).
 */
import type { HTMLAttributes } from 'react';

import styles from './Code.module.css';
import { CopyButton } from './CopyButton.tsx';

export function Code({ children, className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <code {...rest} className={[styles.code, className ?? ''].join(' ')}>
      {children}
    </code>
  );
}

export function CodeTone({
  tone,
  children,
}: {
  tone: 'key' | 'string' | 'comment';
  children: React.ReactNode;
}) {
  return <span className={styles[`tone_${tone}`]}>{children}</span>;
}

export function CodeBlock({
  children,
  copy,
  label,
  wrap = false,
  testId,
}: {
  children: React.ReactNode;
  /** What the button copies. Defaults to the content when it is a plain string; `false` hides the button. */
  copy?: string | false;
  /** Names the snippet for assistive technology ("MCP configuration"). */
  label?: string;
  /** Wrap long lines instead of scrolling sideways (prose-like instructions). */
  wrap?: boolean;
  testId?: string;
}) {
  const text = copy === false ? null : (copy ?? (typeof children === 'string' ? children : null));
  return (
    <div className={styles.block} data-testid={testId}>
      <pre
        className={[styles.pre, wrap ? styles.wrap : ''].join(' ')}
        aria-label={label}
        // A block that scrolls sideways is reachable by keyboard.
        tabIndex={0}
      >
        <code>{children}</code>
      </pre>
      {text !== null && <CopyButton text={text} className={styles.copy} onDark />}
    </div>
  );
}
