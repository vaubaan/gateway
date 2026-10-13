/**
 * An identifier as the protocol spells it — a permission id
 * (`github.merge-protected`), a tool name, a resource ref (`acme/web`), a
 * slice — in the monospace face, so that a person can read it out or paste it
 * into a ticket. The words around it are the interface's (`lib/vocabulary`);
 * the id itself is never renamed.
 *
 * An identifier wraps between its words (`github__create_|or_|update_|file`),
 * never inside one: a break opportunity follows each separator.
 *
 * No hook: it renders in server and client components alike.
 */
import { Fragment } from 'react';

import styles from './Mono.module.css';

/** `a_b.c-d/e` → `a_`, `b.`, `c-`, `d/`, `e`: where an identifier may wrap. */
const WORD_END = /(?<=[_.\-/:\]@])(?=[^_.\-/:\]@])/;

export function breakable(children: React.ReactNode): React.ReactNode {
  if (typeof children !== 'string') return children;
  const words = children.split(WORD_END);
  return words.map((word, index) => (
    // The words of one id, in order: the index is their identity.
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {word}
    </Fragment>
  ));
}

export function Mono({
  children,
  href,
  quiet = false,
  title,
}: {
  children: React.ReactNode;
  /** Makes the id a link to where it is explained (the reference). */
  href?: string;
  /** The id under a label that already says the thing in words: smaller, in the quiet ink. */
  quiet?: boolean;
  title?: string;
}) {
  const classes = [styles.mono, quiet ? styles.quiet : '', href ? styles.link : '']
    .filter(Boolean)
    .join(' ');
  if (href) {
    return (
      <a href={href} className={classes} title={title}>
        {breakable(children)}
      </a>
    );
  }
  return (
    <span className={classes} title={title}>
      {breakable(children)}
    </span>
  );
}
