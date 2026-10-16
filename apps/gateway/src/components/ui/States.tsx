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
import { Icon } from './Icon.tsx';
import styles from './States.module.css';

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
    <div className={styles.empty} data-testid={testId}>
      <p className={styles.emptyTitle}>{title}</p>
      {children && <p className={styles.emptyText}>{children}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
      {links && <div className={styles.emptyLinks}>{links}</div>}
    </div>
  );
}

/** The one paragraph a newcomer reads: what the product is, with its three words in bold. */
export function Lede({ children }: { children: React.ReactNode }) {
  return <p className={styles.lede}>{children}</p>;
}

export interface ModelNode {
  readonly name: string;
  readonly note: string;
}

/** The model in a few nodes, read left to right: Account → Mission → Key → Agent → Activity. */
export function ModelDiagram({ nodes, label }: { nodes: readonly ModelNode[]; label: string }) {
  return (
    <ol className={styles.model} aria-label={label}>
      {nodes.map((node) => (
        <li key={node.name} className={styles.node}>
          <span className={styles.nodeBox}>
            <span>{node.name}</span>
            <small>{node.note}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

export type StepState = 'todo' | 'next' | 'later' | 'done';

/** The number of a step, as the `lead` of a `Row`: done, the next one, or later. */
export function StepMark({ n, state = 'todo' }: { n: number; state?: StepState }) {
  return (
    <span className={[styles.step, styles[`step_${state}`]].join(' ')}>
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
      <span className={[styles.check, styles.check_done].join(' ')}>
        <Icon name="check" size={11} />
        <span className="vbn-sr-only">Done</span>
      </span>
    );
  }
  if (state === 'partial') {
    return (
      <span className={[styles.check, styles.check_partial].join(' ')}>
        {partial}
        <span className="vbn-sr-only"> done</span>
      </span>
    );
  }
  return (
    <span className={[styles.check, styles.check_todo].join(' ')}>
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
      className={[styles.skeleton, styles[`skeleton_${height}`]].join(' ')}
      style={{ width }}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    />
  );
}
