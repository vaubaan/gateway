/**
 * One choice among a few, each said in a word or two with a short hint beside
 * it: the trust level of a macro-action while a mission is created.
 *
 * `ChoiceRow` is the group (a `fieldset` named by its `legend`, which is read
 * out and not drawn); `ChoiceChip` is one radio, drawn as a chip. A chip that
 * cannot be chosen is not hidden: it is drawn dashed and **says why** in its
 * hint ("needs a prod project — none selected"), so that nobody picks a
 * choice that would yield nothing, and nobody wonders where it went.
 *
 * This is the trust level picker: the chosen chip is the ink, twice (border and
 * weight), never a colour — trust levels are said in ink (style guide §3.1).
 * shadcn/ui's RadioGroup look on native radios, on the shared tokens.
 *
 * No hook: renders in server and client components alike.
 */
import { cn } from '@/lib/utils';

export function ChoiceRow({
  legend,
  children,
  testId,
}: {
  /** Names the group for assistive technology: "Trust level of Read on GitHub acme". */
  legend: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0" data-testid={testId}>
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
      className={cn(
        'inline-flex min-h-8 cursor-pointer items-center gap-2 rounded-md border border-border-strong bg-card px-[11px] text-small text-foreground transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring',
        // The chosen one: the ink, twice. Not a colour.
        checked && 'border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]',
        // Cannot be chosen now: dashed, and its hint says why.
        off
          ? 'cursor-not-allowed border-dashed bg-sidebar text-muted-foreground'
          : 'hover:border-muted-foreground',
      )}
      title={title}
      data-choice={value}
      data-unavailable={off ? 'true' : undefined}
    >
      <input
        type="radio"
        className="m-0 size-3.5 flex-none accent-primary focus-visible:outline-none"
        name={name}
        value={value}
        checked={checked}
        disabled={off}
        onChange={() => onChange(value)}
      />
      <span className={cn('whitespace-nowrap', checked && 'font-semibold')}>{label}</span>
      {(off || hint) && (
        <span className="font-normal text-muted-foreground">{off ? unavailable : hint}</span>
      )}
    </label>
  );
}
