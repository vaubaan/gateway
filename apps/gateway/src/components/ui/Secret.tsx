/**
 * A key, whole, **once**: right after it was created or replaced. The one
 * filled box of the page it is on — the accent, because it is the thing to
 * take away — with a button that copies exactly the key.
 *
 * Afterwards a page shows the masked form (`KeyMark`) and nothing can show
 * the key again: replacing it is the way to get a new one. Tailwind on the
 * shared tokens.
 */
import { CopyButton } from './CopyButton.tsx';
import { Icon } from './Icon.tsx';

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
    <div
      className="flex items-center gap-3 rounded-lg border border-approval-border bg-primary-soft px-4 py-3.5"
      role="group"
      aria-label={label}
    >
      <Icon name="key" size={16} className="flex-none text-primary-ink" />
      <code
        className="min-w-0 flex-1 font-mono text-body text-foreground [overflow-wrap:anywhere]"
        data-testid={testId}
      >
        {value}
      </code>
      <CopyButton text={value} />
    </div>
  );
}
