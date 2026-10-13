/**
 * Something waits for the person, answerable where they see it: who asks,
 * what exactly, on which mission, how long ago — then the answer buttons, on
 * the same row.
 *
 * - `AnswerList` / `AnswerRow` — the list of "Waiting for you" (the home, the
 *   inbox). Rows and hairlines.
 * - `AnswerRow` with `boxed` — the same row as the one filled box of a page:
 *   the banner at the top of a mission that waits for its creator. Amber
 *   surface, used **once per page at most**.
 *
 * The answers are the caller's (`answers`): `Approve` is the page's primary
 * action when something waits, `Refuse` a secondary one, `Details` a ghost.
 * For a limit that was reached the answer is `Raise`.
 */
import styles from './Answer.module.css';

export function AnswerList({
  children,
  label,
  testId,
}: {
  children: React.ReactNode;
  label?: string;
  testId?: string;
}) {
  return (
    <ul className={styles.list} aria-label={label} data-testid={testId}>
      {children}
    </ul>
  );
}

export function AnswerRow({
  who,
  title,
  age,
  description,
  answers,
  boxed = false,
  testId,
}: {
  /** The mark of who asks: an `Avatar` at `size="md"` (a person or a machine key). */
  who: React.ReactNode;
  /** What is asked, as a sentence: "Merge pull request #418 into main on acme/web". */
  title: React.ReactNode;
  /** How long ago, short ("4 min"). */
  age?: React.ReactNode;
  /** Who and where, then why it is asked, then the room left. */
  description?: React.ReactNode;
  /** The answer buttons: primary first. */
  answers?: React.ReactNode;
  /** The filled, amber form: the one thing on the page that needs the person. */
  boxed?: boolean;
  testId?: string;
}) {
  const Tag = boxed ? 'div' : 'li';
  return (
    <Tag
      className={[styles.item, boxed ? styles.boxed : ''].join(' ')}
      role={boxed ? 'status' : undefined}
      data-testid={testId}
    >
      <span className={styles.who}>{who}</span>
      <div className={styles.text}>
        <div className={styles.title}>
          {title}
          {age && <span className={styles.age}>{age}</span>}
        </div>
        {description && <div className={styles.description}>{description}</div>}
      </div>
      {answers && <div className={styles.answers}>{answers}</div>}
    </Tag>
  );
}
