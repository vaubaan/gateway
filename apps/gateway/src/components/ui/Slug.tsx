/**
 * The name of an object, in the colour of its kind (`kinds.ts`): a risk id, a
 * tool name, a preset, a plane or an entity, a resource ref, a connection, a
 * mission, a token. One component for every page, so that a reader tells "this
 * tag is a risk, that one is a tool" before reading it. The kind is also said
 * by the glyph, by the `title` and to assistive technology: never by the
 * colour alone.
 *
 * No hook: it renders in server and client components alike.
 */
import { Glyph } from './Glyph.tsx';
import { ITEM_KIND_WORDS, type ItemKind } from './kinds.ts';
import styles from './Slug.module.css';

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
      <span className="vbn-sr-only">{label}: </span>
      <span className={styles.text}>{children}</span>
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        className={classes}
        data-kind={kind}
        title={title ?? label}
        onClick={onClick}
        {...(newTab ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        {content}
      </a>
    );
  }
  return (
    <span className={classes} data-kind={kind} title={title ?? label}>
      {content}
    </span>
  );
}
