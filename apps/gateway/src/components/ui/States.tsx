/**
 * What a page shows when it has nothing yet, or not yet.
 *
 * - `EmptyState` — nothing to list: one sentence that says so and what comes
 *   next, optionally one action and a few links. No illustration.
 * - `Lede` + `ModelDiagram` + `StepMark` / `CheckMark` — the first run: one
 *   paragraph that says what the product is, the model drawn as a few nodes,
 *   then the steps (as `Rows` whose `lead` is a `StepMark` or a `CheckMark`).
 * - `Skeleton` — the shape of what is loading, in place of it.
 */
import { cn } from '@/lib/utils';

import { Icon } from './Icon.tsx';

export function EmptyState({
  title,
  children,
  action,
  links,
  testId,
}: {
  /** What is the case, as a sentence: "Nothing needs you. 4 missions are running." */
  title: React.ReactNode;
  /** One more sentence, when the next step is not obvious. */
  children?: React.ReactNode;
  /** The one thing to do next (a `Button` or a `ButtonLink`). */
  action?: React.ReactNode;
  /** Where else to go (a `SummaryLine`). */
  links?: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="py-(--section-gap) text-center text-small" data-testid={testId}>
      <p className="m-0 text-body text-muted-foreground">{title}</p>
      {children && (
        <p className="mx-auto mt-1 mb-0 max-w-[52ch] text-muted-foreground">{children}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
      {links && <div className="mt-4">{links}</div>}
    </div>
  );
}

/** The one paragraph a newcomer reads: what the product is, with its three words in bold. */
export function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="m-0 max-w-[66ch] text-body leading-[1.55] text-muted-foreground [&_b]:text-foreground [&_strong]:text-foreground">
      {children}
    </p>
  );
}

export interface ModelNode {
  readonly name: string;
  readonly note: string;
}

/** The model in a few nodes, read left to right: Account → Mission → Key → Agent → Activity. */
export function ModelDiagram({ nodes, label }: { nodes: readonly ModelNode[]; label: string }) {
  return (
    <ol
      className="mt-7 mb-2 flex list-none flex-wrap items-center gap-y-2 p-0 text-small"
      aria-label={label}
    >
      {nodes.map((node, index) => (
        <li key={node.name} className="flex items-center">
          {index > 0 && (
            // The arrow between two nodes: a hairline and its head.
            <svg
              width="28"
              height="7"
              viewBox="0 0 28 7"
              className="block flex-none text-border-strong"
              aria-hidden="true"
            >
              <path d="M0 3.5h27M24 0.5l3 3-3 3" fill="none" stroke="currentColor" />
            </svg>
          )}
          <span className="block rounded-md border border-border-strong bg-card px-3 py-[7px] whitespace-nowrap">
            <span>{node.name}</span>
            <small className="block text-muted-foreground">{node.note}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

export type StepState = 'todo' | 'next' | 'later' | 'done';

const STEP: Readonly<Record<StepState, string>> = {
  todo: 'bg-foreground text-background',
  next: 'bg-primary text-primary-foreground',
  later: 'bg-muted text-muted-foreground',
  done: 'bg-allowed-bg text-allowed-fg',
};

const CHECK =
  'inline-grid size-5 flex-none place-items-center rounded-full text-[11px] font-semibold';

/** The number of a step, as the `lead` of a `Row`: done, the next one, or later. */
export function StepMark({ n, state = 'todo' }: { n: number; state?: StepState }) {
  return (
    <span
      className={cn(
        'inline-grid size-6 flex-none place-items-center rounded-full text-caption font-semibold',
        STEP[state],
      )}
      data-state={state}
    >
      {state === 'done' ? <Icon name="check" size={12} /> : n}
      <span className="vbn-sr-only">
        {state === 'done' ? ` Step ${n}, done` : state === 'next' ? ' — next' : ''}
      </span>
    </span>
  );
}

export type CheckState = 'done' | 'todo' | 'partial';

/** The state of a line of a checklist, as the `lead` of a `Row`. Green appears here only. */
export function CheckMark({ state, partial }: { state: CheckState; partial?: string }) {
  if (state === 'done') {
    return (
      <span className={cn(CHECK, 'bg-allowed-bg text-allowed-fg')} data-state="done">
        <Icon name="check" size={11} />
        <span className="vbn-sr-only">Done</span>
      </span>
    );
  }
  if (state === 'partial') {
    return (
      <span className={cn(CHECK, 'bg-approval-bg text-approval-fg')} data-state="partial">
        {partial}
        <span className="vbn-sr-only"> done</span>
      </span>
    );
  }
  return (
    <span
      className={cn(CHECK, 'border-[1.5px] border-dashed border-border-strong')}
      data-state="todo"
    >
      <span className="vbn-sr-only">To do</span>
    </span>
  );
}

export function Skeleton({
  width = '100%',
  height = 'text',
  label = 'Loading',
}: {
  /** A CSS width. Vary it between lines: text is not a block. */
  width?: string;
  /** `text` for one line, `row` for a list row, `title` for a heading. */
  height?: 'text' | 'row' | 'title';
  /** Said once to assistive technology; pass `''` on all but the first line of a group. */
  label?: string;
}) {
  return (
    <span
      className={cn(
        'block max-w-full animate-breathe rounded-sm bg-muted',
        height === 'text' && 'my-[5px] h-3',
        height === 'title' && 'my-1 h-5',
        height === 'row' &&
          'h-11 rounded-none border-b border-border bg-[linear-gradient(var(--muted),var(--muted))] bg-[length:40%_12px] bg-[position:left_center] bg-no-repeat [background-color:transparent]',
      )}
      style={{ width }}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}
