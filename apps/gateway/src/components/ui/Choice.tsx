/**
 * One choice among a few, each said in a word or two with a short hint beside
 * it: the presets of an account while a mission is created.
 *
 * `ChoiceRow` is the group (a `fieldset` named by its `legend`, which is read
 * out and not drawn); `ChoiceChip` is one radio, drawn as a chip. A chip that
 * cannot be chosen is not hidden: it is drawn dashed and **says why** in its
 * hint ("needs a prod project — none selected"), so that nobody picks a
 * choice that would yield nothing, and nobody wonders where it went.
 *
 * No hook: renders in server and client components alike.
 */
import styles from './Choice.module.css';

export function ChoiceRow({
  legend,
  children,
  testId,
}: {
  /** Names the group for assistive technology: "Preset for GitHub · acme". */
  legend: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <fieldset className={styles.row} data-testid={testId}>
      <legend className="vbn-sr-only">{legend}</legend>
      {children}
    </fieldset>
  );
}

export function ChoiceChip({
  name,
  value,
  checked,
  onChange,
  label,
  hint,
  unavailable,
  title,
}: {
  /** The radio group: one name per `ChoiceRow`. */
  name: string;
  value: string;
  checked: boolean;
  onChange: (value: string) => void;
  /** The choice, in a word or two. */
  label: string;
  /** A short fact beside it: how many permissions it holds. */
  hint?: React.ReactNode;
  /** Why it cannot be chosen now; the chip is then dashed and disabled. */
  unavailable?: string | null;
  title?: string;
}) {
  const off = typeof unavailable === 'string' && unavailable !== '';
  return (
    <label
      className={[styles.chip, checked ? styles.on : '', off ? styles.off : ''].join(' ')}
      title={title}
      data-choice={value}
      data-unavailable={off ? 'true' : undefined}
    >
      <input
        type="radio"
        className={styles.radio}
        name={name}
        value={value}
        checked={checked}
        disabled={off}
        onChange={() => onChange(value)}
      />
      <span className={styles.label}>{label}</span>
      {(off || hint) && <span className={styles.hint}>{off ? unavailable : hint}</span>}
    </label>
  );
}
