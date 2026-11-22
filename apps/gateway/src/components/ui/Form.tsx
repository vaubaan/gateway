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
    <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-10 max-[1100px]:grid-cols-1 max-[1100px]:gap-8">
      <div className="min-w-0">{children}</div>
      {/*
        The rail stays in view: the summary and the one action are never a scroll away. It is
        shorter than the window by what stands above the form (the header of the page), and its
        box keeps its head and its foot (the action) while what is between scrolls.
      */}
      <aside className="sticky top-6 flex max-h-[calc(100vh-168px)] min-w-0 max-[1100px]:static max-[1100px]:block max-[1100px]:max-h-none [&>*]:flex [&>*]:min-h-0 [&>*]:w-full [&>*]:flex-col [&>*>*]:flex-none [&>*>:not(:first-child):not(:last-child)]:min-h-0 [&>*>:not(:first-child):not(:last-child)]:flex-auto [&>*>:not(:first-child):not(:last-child)]:overflow-y-auto">
        {rail}
      </aside>
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
    <section
      className="mt-[30px] first:mt-0"
      id={id}
      aria-labelledby={headingId}
      data-testid={testId}
    >
      <div className="mb-2.5 flex items-center gap-2.5 [&>:first-child]:size-5">
        <StepMark n={n} />
        <h2 className="m-0 flex-none text-body font-semibold whitespace-nowrap" id={headingId}>
          {title}
        </h2>
        {hint && (
          <div className="ml-auto flex min-w-0 items-center justify-end gap-3 text-right text-small text-muted-foreground">
            {hint}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

export function FormColumns({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_200px_minmax(0,1fr)] items-start gap-3.5 max-[720px]:grid-cols-1">
      {children}
    </div>
  );
}
