'use client';
/**
 * "Disconnect" (the protocol's revocation of a connection, final: spec §2.3)
 * behind a type-to-confirm dialog that says what stops and what happens at the
 * service. The confirmation submits a plain POST form, so the handler's origin
 * check applies like on every other mutation.
 */
import { useRef, useState } from 'react';

import { Button, DangerConfirm } from '@/components/ui';
import { ACCOUNT_ACTIONS, count, TERMS } from '@/lib/vocabulary';

export function RevokeConnection({
  action,
  name,
  running,
  atProvider,
}: {
  action: string;
  name: string;
  /** How many running missions use the account: they lose it for good. */
  running: number;
  /** What disconnecting does to the access granted at the service, in one or two sentences. */
  atProvider: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={formRef} method="post" action={action} hidden />
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => setOpen(true)}
        data-testid="disconnect-account"
      >
        {ACCOUNT_ACTIONS.disconnect} this account…
      </Button>
      {open && (
        <DangerConfirm
          title={`${ACCOUNT_ACTIONS.disconnect} ${name}?`}
          body={
            <>
              The stored credential is erased, and{' '}
              {running === 0
                ? 'no mission uses this account today'
                : `the ${count(running, TERMS.mission)} that ${running === 1 ? 'uses' : 'use'} this account ${running === 1 ? 'loses' : 'lose'} it for good: one that uses only this account stops, one that uses others keeps running on them`}
              . This cannot be undone: to use the service again you connect a new account, and
              create new missions on it.
              <br />
              <br />
              {atProvider}
            </>
          }
          phrase={name}
          confirmLabel={ACCOUNT_ACTIONS.disconnect}
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
