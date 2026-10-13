'use client';

/**
 * The two acts of "Who has access" that ask before they happen: removing an
 * access, and handing the account to a team. Each opens a dialog that states
 * the consequence first, then submits a plain POST form — the handler checks
 * the origin and the session like every other mutation, and answers with a
 * redirect and a note.
 */
import { useId, useRef, useState } from 'react';

import { Button, ConfirmDialog, Field, Select } from '@/components/ui';
import { ACCOUNT_ACTIONS, ACTIONS, count, TERMS } from '@/lib/vocabulary';

export function RemoveAccess({
  action,
  who,
  missions,
}: {
  /** `POST /accounts/<id>/shares/<shareId>/revoke`. */
  action: string;
  /** Who loses the access, as the row names them. */
  who: string;
  /** How many of their missions use the account and still run. */
  missions: number;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  return (
    <>
      <form ref={form} method="post" action={action} hidden />
      <Button
        type="button"
        variant="danger"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Remove the access of ${who}`}
      >
        {ACTIONS.removeAccess}
      </Button>
      <ConfirmDialog
        open={open}
        title={`Remove the access of ${who}?`}
        consequence={
          <>
            {who} can no longer write missions on this account
            {missions === 0
              ? '; none of their missions uses it today.'
              : `, and the ${count(missions, TERMS.mission)} that ${missions === 1 ? 'uses' : 'use'} it ${missions === 1 ? 'stops' : 'stop'} at once: every call is refused, with the reason.`}{' '}
            Giving access again brings a stopped mission back, with the key its agent holds.
          </>
        }
        confirmLabel="Remove access"
        tone="danger"
        busy={busy}
        hint="Recorded in the activity, like every change."
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setBusy(true);
          form.current?.submit();
        }}
        testId="remove-access-dialog"
      />
    </>
  );
}

export function TransferOwnership({
  action,
  account,
  teams,
}: {
  /** `POST /accounts/<id>/transfer`. */
  action: string;
  account: string;
  /** The teams the server accepts: the ones the person belongs to. */
  teams: readonly { readonly id: string; readonly name: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [team, setTeam] = useState(teams[0]?.id ?? '');
  const form = useRef<HTMLFormElement>(null);
  const selectId = useId();
  const chosen = teams.find((candidate) => candidate.id === team);
  return (
    <>
      <form ref={form} method="post" action={action} hidden>
        <input type="hidden" name="group_id" value={team} readOnly />
      </form>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        {ACCOUNT_ACTIONS.transfer}
      </Button>
      <ConfirmDialog
        open={open}
        title={`Transfer ${account} to a team?`}
        consequence={
          <>
            Every member of {chosen ? `the ${chosen.name} team` : 'the team'}, now and later,
            becomes a full owner: they may give access, reconnect, transfer or disconnect it. The
            accesses already given are kept. You stay an owner as long as you belong to the team.
          </>
        }
        confirmLabel={ACCOUNT_ACTIONS.transfer}
        busy={busy}
        hint="Only a team you belong to: you would otherwise lose the account by mistake."
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          setBusy(true);
          form.current?.submit();
        }}
        testId="transfer-dialog"
      >
        <Field label="Team" htmlFor={selectId}>
          <Select id={selectId} value={team} onChange={(event) => setTeam(event.target.value)}>
            {teams.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </Select>
        </Field>
      </ConfirmDialog>
    </>
  );
}
