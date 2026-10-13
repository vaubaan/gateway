/**
 * The name of an object, in the colour of its kind (`kinds.ts`): a risk id, a
 * tool name, a preset, a plane or an entity, a resource ref, a connection, a
 * mission, a member, a token. One component for every page, so that a reader
 * tells "this tag is a risk, that one is a tool" before reading it. The kind
 * is also said by the glyph, by the `title` and — as generated content, so
 * that the text of the element stays the bare name — to assistive technology:
 * never by the colour alone.
 *
 * An identifier (`mono`) wraps between its words
 * (`github__create_|or_|update_|file`), never inside one: a break opportunity
 * follows each separator. A human name wraps as prose does.
 *
 * No hook: it renders in server and client components alike.
 */
import { Fragment } from 'react';

import { Glyph } from './Glyph.tsx';
import { ITEM_KIND_WORDS, type ItemKind } from './kinds.ts';
import styles from './Slug.module.css';

/** `a_b.c-d/e` → `a_`, `b.`, `c-`, `d/`, `e`: where an identifier may wrap. */
const WORD_END = /(?<=[_.\-/:\]@])(?=[^_.\-/:\]@])/;

function breakable(children: React.ReactNode): React.ReactNode {
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

export function Slug({
  kind,
  children,
  href,
  newTab = false,
  mono = true,
  title,
  className,
  onClick,
}: {
  kind: ItemKind;
  children: React.ReactNode;
  /** Makes the slug a link to the object it names. */
  href?: string | null;
  /** For the pages that hold unsaved input: the target opens beside the form. */
  newTab?: boolean;
  /** Identifiers are monospace; a human name (a mission, a connection) is not. */
  mono?: boolean;
  title?: string;
  className?: string;
  onClick?: React.MouseEventHandler<HTMLAnchorElement>;
}) {
  const { label } = ITEM_KIND_WORDS[kind];
  const classes = [styles.slug, mono ? styles.mono : '', href ? styles.link : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const content = (
    <>
      <Glyph name={kind} className={styles.glyph} />
      <span className={styles.text}>{mono ? breakable(children) : children}</span>
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        className={classes}
        data-kind={kind}
        data-kind-label={`${label}: `}
        title={title ?? label}
        onClick={onClick}
        {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        {content}
      </a>
    );
  }
  return (
    <span
      className={classes}
      data-kind={kind}
      data-kind-label={`${label}: `}
      title={title ?? label}
    >
      {content}
    </span>
  );
}
