/**
 * Technical text.
 *
 * - `Code` — inline: a tool name, a branch, a path. Mono on a quiet fill.
 * - `CodeBlock` — a snippet a person copies into a terminal or a file: dark
 *   in both themes, with a Copy button that copies exactly `copy` (or the
 *   text itself when the block holds a plain string).
 * - `CodeTone` — a keyword, a string or a comment inside a block. Colour
 *   helps the eye here and says nothing a reader needs.
 *
 * A secret is shown in a `CodeBlock` once, at creation; afterwards a page
 * shows its masked form (`KeyMark`). Tailwind on the shared tokens; the code
 * colours are the shared `code-*` family.
 */
import type { HTMLAttributes } from 'react';

import { cn } from '@/lib/utils';

import { CopyButton } from './CopyButton.tsx';

const TONE = {
  key: 'text-code-accent',
  string: 'text-code-ok',
  comment: 'text-code-muted',
} as const;

export function Code({ children, className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <code
      {...rest}
      className={cn(
        'rounded-sm bg-muted px-[5px] py-px font-mono text-[0.93em] text-foreground',
        className,
      )}
    >
      {children}
    </code>
  );
}

export function CodeTone({
  tone,
  children,
}: {
  tone: 'key' | 'string' | 'comment';
  children: React.ReactNode;
}) {
  return <span className={TONE[tone]}>{children}</span>;
}

export function CodeBlock({
  children,
  copy,
  label,
  wrap = false,
  testId,
}: {
  children: React.ReactNode;
  /** What the button copies. Defaults to the content when it is a plain string; `false` hides the button. */
  copy?: string | false;
  /** Names the snippet for assistive technology ("MCP configuration"). */
  label?: string;
  /** Wrap long lines instead of scrolling sideways (prose-like instructions). */
  wrap?: boolean;
  testId?: string;
}) {
  const text = copy === false ? null : (copy ?? (typeof children === 'string' ? children : null));
  return (
    // A phone: the button sits above the block instead of over its first line.
    <div
      className="relative max-sm:flex max-sm:flex-col-reverse max-sm:items-end max-sm:gap-1"
      data-testid={testId}
    >
      <pre
        className={cn(
          'm-0 overflow-auto rounded-lg bg-code py-3 pr-[76px] pl-3.5 font-mono text-caption leading-[1.55] text-code-fg focus-visible:rounded-lg max-sm:self-stretch max-sm:pr-3.5 [&_code]:text-[length:inherit]',
          wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre',
        )}
        aria-label={label}
        // A block that scrolls sideways is reachable by keyboard.
        tabIndex={0}
      >
        <code>{children}</code>
      </pre>
      {text !== null && (
        <CopyButton text={text} className="absolute top-2 right-2 max-sm:static" onDark />
      )}
    </div>
  );
}
