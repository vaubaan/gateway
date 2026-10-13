'use client';

/**
 * A button whose act is a plain form post, asked first: it opens a
 * `ConfirmDialog` that states the consequence, and submits the form when the
 * person confirms. The post is a normal navigation — the handler checks the
 * origin and the session like every other mutation, and answers with a
 * redirect — so nothing here needs a fetch.
 *
 * Use it for an act that stops, removes or hands over something (remove an
 * access, deactivate a person, disconnect an app). An act that only adds or
 * edits is a plain submit button.
 *
 * `consequence` and `children` are rendered nodes: a server page passes them
 * as it would to any client component.
 */
import { useRef, useState } from 'react';

import { Button, type ButtonSize, type ButtonVariant } from './Button.tsx';
import { ConfirmDialog } from './Dialog.tsx';

export function ConfirmSubmit({
  action,
  fields = {},
  label,
  ariaLabel,
  variant = 'secondary',
  size = 'sm',
  title,
  consequence,
  confirmLabel,
  tone = 'primary',
  hint,
  children,
  testId,
}: {
  /** Where the form posts. */
  action: string;
  /** Hidden fields sent with it (`{ action: 'disable' }`). */
  fields?: Readonly<Record<string, string>>;
  /** The words on the button that opens the dialog. */
  label: React.ReactNode;
  /** Names the button when its words alone do not say on what it acts. */
  ariaLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** The question: "Deactivate Bob?" */
  title: React.ReactNode;
  /** What changes and what does not, before anything happens. Required. */
  consequence: React.ReactNode;
  /** The act, as a verb: "Deactivate". */
  confirmLabel: string;
  tone?: 'primary' | 'danger';
  hint?: React.ReactNode;
  /** More controls inside the dialog; they are NOT part of the form. */
  children?: React.ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={form} method="post" action={action} hidden>
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} readOnly />
        ))}
      </form>
      <Button
        type="button"
        variant={variant}
        size={size}
        aria-label={ariaLabel}
        onClick={() => setOpen(true)}
        data-testid={testId}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={open}
        title={title}
        consequence={consequence}
        confirmLabel={confirmLabel}
        tone={tone}
        busy={busy}
        hint={hint}
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setBusy(true);
          form.current?.submit();
        }}
        testId={testId ? `${testId}-dialog` : undefined}
      >
        {children}
      </ConfirmDialog>
    </>
  );
}
