'use client';
/**
 * "Revoke" with a type-to-confirm dialog (revocation is terminal, spec §2.3).
 * The confirmation submits a plain POST form, so the handler's origin check
 * applies like on every other mutation.
 */
import { useRef, useState } from 'react';

import { Button, DangerConfirm } from '@/components/ui';

export function RevokeConnection({ action, name }: { action: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={formRef} method="post" action={action} hidden />
      <Button type="button" variant="danger" size="sm" onClick={() => setOpen(true)}>
        Revoke
      </Button>
      {open && (
        <DangerConfirm
          title="Revoke this connection"
          body={
            <>
              Revocation is final: the stored credential is erased and every mission that carries
              this connection refuses its calls from now on. To use the provider again you will
              create a new connection.
            </>
          }
          phrase={name}
          confirmLabel="Revoke"
          busy={busy}
          onCancel={() => setOpen(false)}
          onConfirm={() => {
            setBusy(true);
            formRef.current?.submit();
          }}
        />
      )}
    </>
  );
}
