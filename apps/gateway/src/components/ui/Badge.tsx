/**
 * Marks of state. The rule they serve: **a status is coloured only when it
 * differs from normal.** Nothing is ever labelled "active" or "allowed" in
 * colour; the accent means "waits for you", red means "stopped, refused, limit
 * reached", and no mark is orange or yellow. Every mark carries its word:
 * never colour alone.
 *
 * - `StatusMark` — a pill with a dot, for the exception on a row or a title.
 * - `Dot` — the dot alone, next to a word that already says the state.
 * - `Tag` — a small squared label for a fact that is not a state: an
 *   environment (`staging`, `prod`), a short code.
 * - `BadgeTone`, `toneOfBadge` — the tone names of the first interface
 *   (`success`, `warning`, `danger`), which `Callout` still accepts.
 *
 * shadcn/ui's Badge, rewritten for these three shapes on the shared tokens
 * (ADR design-system-on-shadcn-shared-by-the-app-and-the-site).
 */
import { cn } from '@/lib/utils';
import type { Tone } from '@/lib/vocabulary';

export type { Tone };

/** The tone names of the first interface, kept for the pages that still use them. */
export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const TONE_OF_BADGE: Readonly<Record<BadgeTone, Tone>> = {
  neutral: 'neutral',
  info: 'info',
  success: 'ok',
  warning: 'warn',
  danger: 'bad',
};

export function toneOfBadge(tone: BadgeTone): Tone {
  return TONE_OF_BADGE[tone];
}

const PILL: Readonly<Record<Tone, string>> = {
  neutral: 'bg-muted text-muted-foreground before:bg-faint',
  info: 'bg-primary-soft text-primary-ink',
  ok: 'bg-allowed-bg text-allowed-fg',
  warn: 'bg-approval-bg text-approval-fg',
  bad: 'bg-refused-bg text-refused-fg',
};

export function StatusMark({
  tone = 'neutral',
  dot = true,
  children,
  testId,
}: {
  tone?: Tone;
  /** The dot before the word; a count ("2") takes none. */
  dot?: boolean;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-[5px] whitespace-nowrap rounded-full px-2 align-middle text-caption leading-none font-normal',
        tone === 'neutral' ? null : 'before:bg-current',
        PILL[tone],
        dot ? "before:size-1.5 before:rounded-full before:content-['']" : 'before:hidden',
      )}
      data-tone={tone}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

const DOT: Readonly<Record<Tone, string>> = {
  neutral: 'bg-faint',
  info: 'bg-primary',
  ok: 'bg-allowed',
  warn: 'bg-approval',
  bad: 'bg-refused',
};

export function Dot({ tone = 'neutral', label }: { tone?: Tone; label?: string }) {
  return (
    <span
      className={cn('inline-block size-1.5 flex-none rounded-full align-middle', DOT[tone])}
      data-tone={tone}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/** The environments the catalogs know; anything else is drawn neutral. */
const ENVIRONMENT_TONE: Readonly<Record<string, Tone>> = {
  prod: 'bad',
  production: 'bad',
  live: 'bad',
  staging: 'warn',
  preview: 'warn',
  test: 'ok',
  dev: 'ok',
  development: 'ok',
};

const TAG: Readonly<Record<Tone, string>> = {
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-approval-border bg-primary-soft text-primary-ink',
  ok: 'border-allowed-border bg-allowed-bg text-allowed-fg',
  warn: 'border-approval-border bg-approval-bg text-approval-fg',
  bad: 'border-refused-border bg-refused-bg text-refused-fg',
};

export function Tag({
  tone = 'neutral',
  mono = false,
  dashed = false,
  children,
}: {
  tone?: Tone;
  mono?: boolean;
  /** "Nothing here": a missing label, an option that is not available. */
  dashed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex min-h-[18px] items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 align-middle text-caption leading-[1.3] font-normal',
        TAG[tone],
        mono && 'font-mono',
        dashed && 'border-dashed border-border-strong bg-transparent text-muted-foreground',
      )}
      data-tone={tone}
    >
      {children}
    </span>
  );
}

/** An environment label: the word, with the tone production deserves. `null` → "no label". */
export function EnvTag({ env }: { env: string | null | undefined }) {
  if (!env) return <Tag dashed>no label</Tag>;
  return <Tag tone={ENVIRONMENT_TONE[env.toLowerCase()] ?? 'neutral'}>{env}</Tag>;
}
