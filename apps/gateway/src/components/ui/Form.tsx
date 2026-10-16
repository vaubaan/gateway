/**
 * A form a person fills from top to bottom while a rail beside it says what
 * the result will be (creating a mission).
 *
 * - `FormWithRail` — the two columns: the steps, and the rail, which stays in
 *   view while the steps scroll. The rail holds the one bordered box of the
 *   page (`Card`) and its one primary action. In a narrow window the rail
 *   comes after the steps.
 * - `FormStep` — one step: its number, its heading, at most one short
 *   sentence on the right, then its controls. Steps are separated by
 *   whitespace.
 * - `FormColumns` — a few fields of one step side by side.
 *
 * No hook: renders in server and client components alike.
 */
import styles from './Form.module.css';
import { StepMark } from './States.tsx';

export function FormWithRail({
  children,
  rail,
}: {
  /** `FormStep`s. */
  children: React.ReactNode;
  /** What the result will be, and the action: a `Card`. */
  rail: React.ReactNode;
}) {
  return (
    <div className={styles.form}>
      <div className={styles.steps}>{children}</div>
      <aside className={styles.rail}>{rail}</aside>
    </div>
  );
}

export function FormStep({
  n,
  title,
  hint,
  children,
  id,
  testId,
}: {
  n: number;
  title: string;
  /** One short sentence on the right. */
  hint?: React.ReactNode;
  children: React.ReactNode;
  id?: string;
  testId?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={styles.step} id={id} aria-labelledby={headingId} data-testid={testId}>
      <div className={styles.head}>
        <StepMark n={n} />
        <h2 className={styles.title} id={headingId}>
          {title}
        </h2>
        {hint && <div className={styles.hint}>{hint}</div>}
      </div>
      {children}
    </section>
  );
}

export function FormColumns({ children }: { children: React.ReactNode }) {
  return <div className={styles.columns}>{children}</div>;
}
