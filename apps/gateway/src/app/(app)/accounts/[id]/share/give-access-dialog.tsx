'use client';

/**
 * "Give access" (the protocol's share: spec §4.2, §7.3), as a dialog over the
 * account page: who — a person by email, or a team — then the permissions.
 *
 * The checklist is the catalog as explicit ids, grouped the way the reference
 * groups them (reads, writes, irreversible writes), each line with its
 * severity and a "why?" one click away. "Select all" and the macro-actions
 * tick the boxes one by one: the form posts one `risk` value per ticked permission, so
 * what is stored is the list resolved at the time of the click (spec §3.1
 * "Enumeration"), never "everything". A permission the catalog gains later is
 * not part of it.
 *
 * When the access would bring stopped missions back (spec §2.3), the dialog
 * comes back from the first post with their names: the access is given by a
 * second post that carries exactly the missions the owner was shown.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import {
  Button,
  Callout,
  Checkbox,
  Dialog,
  EnvTag,
  Field,
  Input,
  PermissionGroup,
  PermissionRow,
  PermissionTable,
  Select,
  Tag,
} from '@/components/ui';
import { ACTIONS, formatNumber, giveAccessLabel } from '@/lib/vocabulary';
import { groupByKind } from '@/server/missions/catalog-view';
import type { CatalogRisk } from '@/server/missions/model';
import { riskReferencePath } from '@/server/providers/links';
import {
  envNotes,
  selectAllIds,
  summarizeRestriction,
  type EnvLabelling,
} from '@/server/shares/restriction';

import styles from '../../accounts.module.css';

export interface GiveAccessInitial {
  readonly targetKind: 'user' | 'group';
  readonly email: string;
  readonly groupId: string;
  readonly selected: readonly string[];
  /** True when the dialog edits the access a person or a team already holds. */
  readonly editing: boolean;
  /** Who holds it, when editing: the row's own words. */
  readonly holder: string | null;
}

/** A macro-action of the service: the explicit ids it stands for, ticked or unticked together. */
export interface AccessMacroAction {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly riskIds: readonly string[];
}

/** What the first post found the access would bring back; confirmed by the second. */
export interface AccessRestore {
  readonly holder: string;
  readonly missions: readonly {
    readonly id: string;
    readonly name: string;
    readonly creator: string;
  }[];
}

/** The names of the form fields; the server reads these (`SHARE_FIELDS`). */
export interface AccessFields {
  readonly targetKind: string;
  readonly email: string;
  readonly group: string;
  readonly risk: string;
  readonly restore: string;
}

/** True when every id of the group is ticked. */
function holdsAll(selected: ReadonlySet<string>, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => selected.has(id));
}

/** The selection with every id of the group ticked (`on`) or unticked. */
function toggled(selected: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** The tick of a whole group: all, some (drawn indeterminate), none. */
function GroupTick({
  label,
  picked,
  total,
  onChange,
}: {
  label: string;
  picked: number;
  total: number;
  onChange: (all: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = picked > 0 && picked < total;
  }, [picked, total]);
  return (
    <Checkbox
      ref={ref}
      checked={picked === total}
      onChange={(event) => onChange(event.target.checked)}
      aria-label={`All of: ${label}`}
    />
  );
}

export function GiveAccessDialog({
  action,
  closeHref,
  account,
  service,
  fields,
  risks,
  teams,
  macroActions,
  labelling,
  initial,
  restore,
}: {
  /** `POST /accounts/<id>/shares`. */
  action: string;
  /** The account page, without the dialog. */
  closeHref: string;
  account: string;
  service: { readonly id: string; readonly label: string; readonly referenceHref: string };
  fields: AccessFields;
  risks: readonly CatalogRisk[];
  teams: readonly { readonly id: string; readonly name: string }[];
  macroActions: readonly AccessMacroAction[];
  labelling: EnvLabelling;
  initial: GiveAccessInitial;
  restore: AccessRestore | null;
}) {
  const router = useRouter();
  const formId = useId();
  const [confirming, setConfirming] = useState(restore !== null);
  const [targetKind, setTargetKind] = useState(initial.targetKind);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initial.selected));
  const groups = useMemo(() => groupByKind(risks), [risks]);
  const notes = envNotes(risks, selected, labelling);
  const close = () => router.push(closeHref);

  function toggle(riskId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(riskId)) next.add(riskId);
      return next;
    });
  }
  function setMany(ids: readonly string[], on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  const everything = selectAllIds(risks);

  if (confirming && restore) {
    const n = restore.missions.length;
    const one = n === 1;
    return (
      <Dialog
        open
        onClose={close}
        testId="give-access-confirm"
        title={`Give access and bring ${one ? 'a stopped mission' : `${formatNumber(n)} stopped missions`} back?`}
        description={
          <>
            {one ? 'This mission was' : 'These missions were'} written on this account with
            permissions their creator lost since, and {one ? 'refuses' : 'refuse'} every call today.
            Once {restore.holder} holds this access, {one ? 'it serves' : 'they serve'} calls again
            at once, with the key {one ? 'its agent already holds' : 'their agents already hold'}{' '}
            and {one ? 'its' : 'their'} limits as they were.
          </>
        }
        footer={
          <>
            <Button type="submit" form={formId} variant="primary">
              Give access and bring {one ? 'it' : 'them'} back
            </Button>
            <Button type="button" onClick={() => setConfirming(false)}>
              Change the permissions
            </Button>
            <Button type="button" variant="ghost" onClick={close}>
              {ACTIONS.cancel}
            </Button>
          </>
        }
        hint={`To give access without bringing ${one ? 'it' : 'them'} back, untick what ${one ? 'it uses' : 'they use'}.`}
      >
        <ul className={styles.restores} data-testid="share-restores">
          {restore.missions.map((mission) => (
            <li key={mission.id}>
              <strong>{mission.name}</strong> — written by {mission.creator}
            </li>
          ))}
        </ul>
        <form id={formId} method="post" action={action}>
          <input type="hidden" name={fields.targetKind} value={initial.targetKind} />
          {initial.targetKind === 'user' ? (
            <input type="hidden" name={fields.email} value={initial.email} />
          ) : (
            <input type="hidden" name={fields.group} value={initial.groupId} />
          )}
          {initial.selected.map((riskId) => (
            <input key={riskId} type="hidden" name={fields.risk} value={riskId} />
          ))}
          {restore.missions.map((mission) => (
            <input key={mission.id} type="hidden" name={fields.restore} value={mission.id} />
          ))}
        </form>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      width="lg"
      divided
      testId="give-access-dialog"
      title={
        initial.editing && initial.holder
          ? `Access of ${initial.holder} to ${account}`
          : `Give access to ${account}`
      }
      description={
        <>
          They will be able to give their agents <strong>up to</strong> the permissions ticked here,
          on anything this account reaches. Never more; they narrow from there, and cannot pass it
          on.
        </>
      }
      footer={
        <>
          <Button type="submit" form={formId} variant="primary" disabled={selected.size === 0}>
            {giveAccessLabel(selected.size, initial.editing)}
          </Button>
          <Button type="button" variant="ghost" onClick={close}>
            {ACTIONS.cancel}
          </Button>
        </>
      }
      hint={
        <>
          Change or remove it at any time;
          <br />
          their running missions narrow or stop accordingly.
        </>
      }
    >
      <form id={formId} method="post" action={action}>
        {initial.editing ? (
          <>
            <input type="hidden" name={fields.targetKind} value={initial.targetKind} />
            <input type="hidden" name={fields.email} value={initial.email} />
            <input type="hidden" name={fields.group} value={initial.groupId} />
          </>
        ) : (
          <div className={styles.target}>
            <Field label="To" htmlFor={`${formId}-kind`}>
              <Select
                id={`${formId}-kind`}
                name={fields.targetKind}
                value={targetKind}
                onChange={(event) =>
                  setTargetKind(event.target.value === 'group' ? 'group' : 'user')
                }
              >
                <option value="user">A person</option>
                <option value="group" disabled={teams.length === 0}>
                  A team{teams.length === 0 ? ' (none yet)' : ''}
                </option>
              </Select>
            </Field>
            {targetKind === 'user' ? (
              <Field
                label="Email"
                shape="the one they sign in with"
                htmlFor={`${formId}-email`}
                hint="They must have signed in to this gateway once."
              >
                <Input
                  id={`${formId}-email`}
                  name={fields.email}
                  type="email"
                  required
                  autoComplete="off"
                  defaultValue={initial.email}
                  placeholder="colleague@example.com"
                />
              </Field>
            ) : (
              <Field
                label="Team"
                htmlFor={`${formId}-team`}
                hint="Every member of the team, now and later, holds this access."
              >
                <Select id={`${formId}-team`} name={fields.group} defaultValue={initial.groupId}>
                  {teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}

        <div className={styles.starts}>
          {macroActions.length > 0 && <span>Tick</span>}
          {macroActions.map((action) => {
            const on = holdsAll(selected, action.riskIds);
            return (
              <Button
                key={action.id}
                type="button"
                size="sm"
                title={action.description}
                aria-pressed={on}
                className={on ? styles.macroActionOn : undefined}
                disabled={action.riskIds.length === 0}
                onClick={() => setSelected(toggled(selected, action.riskIds, !on))}
              >
                {action.label}
              </Button>
            );
          })}
          <span className={styles.startsEnd}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setSelected(new Set(everything))}
            >
              Select all {formatNumber(everything.length)}
            </button>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </span>
        </div>

        <div className={styles.checklist}>
          <PermissionTable
            variant="pick"
            caption={`Permissions on ${account}`}
            testId="access-checklist"
          >
            {groups.map((group) => {
              const ids = group.families.flatMap((family) =>
                family.variants.map((risk) => risk.risk_id),
              );
              const picked = ids.filter((id) => selected.has(id)).length;
              return (
                <PermissionGroup
                  key={group.kind}
                  title={group.title}
                  note={`${formatNumber(picked)} of ${formatNumber(ids.length)}`}
                  select={
                    <GroupTick
                      label={group.title}
                      picked={picked}
                      total={ids.length}
                      onChange={(all) => setMany(ids, all)}
                    />
                  }
                >
                  {group.families.flatMap((family) =>
                    family.variants.map((risk) => (
                      <PermissionRow
                        key={risk.risk_id}
                        label={family.label}
                        id={risk.risk_id}
                        severity={risk.level}
                        included={selected.has(risk.risk_id)}
                        tag={
                          risk.env || risk.fallback || risk.deprecated ? (
                            <>
                              {risk.env && <EnvTag env={risk.env} />}
                              {risk.fallback && <Tag>anything not named</Tag>}
                              {risk.deprecated && <Tag>being retired</Tag>}
                            </>
                          ) : undefined
                        }
                        select={
                          <Checkbox
                            name={fields.risk}
                            value={risk.risk_id}
                            checked={selected.has(risk.risk_id)}
                            onChange={() => toggle(risk.risk_id)}
                            aria-label={`Give ${risk.risk_id}`}
                          />
                        }
                        why={{
                          reason: risk.reason,
                          cells: risk.vector,
                          referenceHref: riskReferencePath(risk.risk_id) ?? service.referenceHref,
                        }}
                      />
                    )),
                  )}
                </PermissionGroup>
              );
            })}
          </PermissionTable>
        </div>

        <p className={styles.summary} data-testid="restriction-summary" aria-live="polite">
          {summarizeRestriction(risks, selected)}
        </p>

        {notes.length > 0 && (
          <div className={styles.dialogNotes}>
            <Callout tone="warn" title="Environment labels">
              {notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </Callout>
          </div>
        )}

        <p className={styles.summary}>
          Each line is explained in the{' '}
          <a href={service.referenceHref} target="_blank" rel="noreferrer">
            {service.label} reference
          </a>
          . “Select all” leaves out what is being retired and “anything not named”; a permission
          added to the catalog later is not included until you tick it.
        </p>
      </form>
    </Dialog>
  );
}
