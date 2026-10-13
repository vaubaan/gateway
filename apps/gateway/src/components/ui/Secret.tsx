/**
 * A key, whole, **once**: right after it was created or replaced. The one
 * filled box of the page it is on — the accent, because it is the thing to
 * take away — with a button that copies exactly the key.
 *
 * Afterwards a page shows the masked form (`KeyMark`) and nothing can show
 * the key again: replacing it is the way to get a new one.
 */
import { CopyButton } from './CopyButton.tsx';
import { Icon } from './Icon.tsx';
import styles from './Secret.module.css';

export function SecretBox({
  value,
  label,
  testId,
}: {
  /** The secret, as its holder must paste it. */
  value: string;
  /** Names the box for assistive technology: "Your key". */
  label: string;
  testId?: string;
}) {
  return (
    <div className={styles.box} role="group" aria-label={label}>
      <Icon name="key" size={16} className={styles.icon} />
      <code className={styles.value} data-testid={testId}>
        {value}
      </code>
      <CopyButton text={value} />
    </div>
  );
}
