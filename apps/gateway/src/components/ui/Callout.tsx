/**
 * A note that interrupts on purpose: an optional short title, a sentence or
 * two. Tinted by its tone, and used sparingly — a filled box is a claim that
 * something is a separate object, so a page holds **one at most** for the
 * thing that needs the person. Never a tinted paragraph of help: help is one
 * sentence in the lede, or behind a disclosure.
 *
 * `neutral` — a fact worth setting apart; `info` — where to go next;
 * `warn` — needs you (the accent family of what waits); `bad` — stopped,
 * refused, failed (the one red); `ok` — done (rare: the absence of a problem
 * needs no box), drawn in the accent with a check: green is for checklist
 * ticks only (style guide, "Colour").
 *
 * shadcn/ui's Alert, rewritten on the shared tokens (ADR
 * design-system-on-shadcn-shared-by-the-app-and-the-site).
 */
import { cn } from '@/lib/utils';
import type { Tone } from '@/lib/vocabulary';

import { toneOfBadge, type BadgeTone } from './Badge.tsx';
import { Icon, type IconName } from './Icon.tsx';

const TONE_ICON: Readonly<Record<Tone, IconName | null>> = {
  neutral: null,
  info: 'info',
  ok: 'check',
  warn: 'alert',
  bad: 'alert',
};

/** The box, then the colour of its icon and title. */
const TONE_STYLE: Readonly<Record<Tone, readonly [box: string, mark: string]>> = {
  neutral: ['border-border bg-sidebar', 'text-muted-foreground'],
  info: ['border-approval-border bg-primary-soft', 'text-primary-ink'],
  // Done is not an exception: the accent, never green (green is for checklist ticks only).
  ok: ['border-approval-border bg-primary-soft', 'text-primary-ink'],
  warn: ['border-approval-border bg-approval-bg', 'text-approval-fg'],
  bad: ['border-refused-border bg-refused-bg', 'text-refused-fg'],
};

const BADGE_TONES: readonly string[] = ['success', 'warning', 'danger'];

function toneOf(tone: Tone | BadgeTone): Tone {
  return BADGE_TONES.includes(tone) ? toneOfBadge(tone as BadgeTone) : (tone as Tone);
}

export function Callout({
  tone = 'neutral',
  title,
  children,
  action,
  testId,
}: {
  tone?: Tone | BadgeTone;
  title?: React.ReactNode;
  children: React.ReactNode;
  /** One action at the end of the note (a small `Button` or `ButtonLink`). */
  action?: React.ReactNode;
  testId?: string;
}) {
  const resolved = toneOf(tone);
  const toneIcon = TONE_ICON[resolved];
  const [box, mark] = TONE_STYLE[resolved];
  return (
    <div
      className={cn(
        'flex max-w-full items-start gap-3 rounded-lg border px-3.5 py-3 text-body',
        box,
      )}
      role="note"
      data-tone={resolved}
      data-testid={testId}
    >
      {toneIcon && (
        <span className={cn('mt-0.5 inline-flex flex-none', mark)}>
          <Icon name={toneIcon} size={16} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {title && (
          <div className={cn('font-semibold', resolved === 'neutral' ? null : mark)}>{title}</div>
        )}
        <div className="text-muted-foreground [&_a]:text-primary [&_p]:m-0 [&_p+p]:mt-1">
          {children}
        </div>
      </div>
      {action && <div className="flex-none self-center">{action}</div>}
    </div>
  );
}
