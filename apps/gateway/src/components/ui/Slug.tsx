/**
 * The name of an object with the glyph of its kind (`kinds.ts`): a risk id, a
 * tool name, a preset, a plane or an entity, a resource ref, a connection, a
 * mission, a member, a token.
 *
 * **Kept for the pages written before the redesign.** A redesigned page
 * prints an identifier with `Mono` and a masked key with `KeyMark`, and says
 * the kind in words; `Slug` goes when nothing imports it. Since the redesign
 * it carries no colour of its own (one accent, status colour for exceptions
 * only): the kind is said by the glyph, by the `title` and — as generated
 * content, so that the text of the element stays the bare name — to assistive
 * technology.
 *
 * No hook: it renders in server and client components alike.
 */
import { Glyph } from './Glyph.tsx';
import { ITEM_KIND_WORDS, type ItemKind } from './kinds.ts';
import { breakable } from './Mono.tsx';
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
