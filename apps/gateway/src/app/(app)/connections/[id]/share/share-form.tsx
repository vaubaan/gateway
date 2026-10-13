'use client';

/**
 * The Share dialog (spec §4.2, §7.3): a target — a user by email, or a group —
 * then the risks. The checklist is the catalog as explicit ids, grouped by
 * severity under a one-line summary; each risk is explained the way every
 * page explains it (label, reason, vector, id linked to the provider
 * reference). "Select all" ticks the boxes one by one: the form posts one
 * `risk` value per ticked risk, so what is stored is the list resolved at the
 * time of the click (spec §3.1 "Enumeration"), never "everything".
 */
import { useMemo, useState } from 'react';

import { SeverityBadge } from '@/components/risk/RiskBadges';
import { RiskExplain } from '@/components/risk/RiskExplain';
import { Banner, Button, Field, Input, Select } from '@/components/ui';
import type { CatalogRisk } from '@/server/missions/model';
import { providerPath, REFERENCE_SECTIONS } from '@/server/providers/links';
import {
  envNotes,
  groupBySeverity,
  selectAllIds,
  summarizeRestriction,
  type EnvLabelling,
} from '@/server/shares/restriction';

import styles from './share.module.css';

export interface ShareFormInitial {
  readonly targetKind: 'user' | 'group';
  readonly email: string;
  readonly groupId: string;
  readonly selected: readonly string[];
  /** True when the dialog edits the restriction a target already holds. */
  readonly editing: boolean;
}

export function ShareForm({
  action,
  cancelHref,
  risks,
  groups,
  labelling,
  initial,
  provider,
}: {
  action: string;
  cancelHref: string;
  /** The connection's plugin: where "what these risks mean" points. */
  provider: { readonly id: string; readonly label: string };
  risks: readonly CatalogRisk[];
  groups: readonly { id: string; name: string }[];
  labelling: EnvLabelling;
  initial: ShareFormInitial;
}) {
  const [targetKind, setTargetKind] = useState(initial.targetKind);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(initial.selected));
  const bySeverity = useMemo(() => groupBySeverity(risks), [risks]);
  const summary = summarizeRestriction(risks, selected);
  const notes = envNotes(risks, selected, labelling);

  function toggle(riskId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(riskId)) next.add(riskId);
      return next;
    });
  }

  return (
    <form method="post" action={action} className={styles.form}>
      <fieldset className={styles.target}>
        <legend>Share with</legend>
        <Field label="Target" htmlFor="share-target-kind">
          <Select
            id="share-target-kind"
            name="target_kind"
            value={targetKind}
            onChange={(e) => setTargetKind(e.target.value === 'group' ? 'group' : 'user')}
          >
            <option value="user">A user</option>
            <option value="group" disabled={groups.length === 0}>
              A group{groups.length === 0 ? ' (none exists yet)' : ''}
            </option>
          </Select>
        </Field>
        {targetKind === 'user' ? (
          <Field
            label="Email"
            htmlFor="share-target-email"
            hint="The email they sign in with. They must have signed in to this instance once."
          >
            <Input
              id="share-target-email"
              name="target_email"
              type="email"
              required
              autoComplete="off"
              defaultValue={initial.email}
              placeholder="colleague@example.com"
            />
          </Field>
        ) : (
          <Field
            label="Group"
            htmlFor="share-target-group"
            hint="Every member of the group, now and later, receives this share."
          >
            <Select id="share-target-group" name="target_group" defaultValue={initial.groupId}>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </fieldset>

      <div className={styles.restriction}>
        <p className={styles.summary} data-testid="restriction-summary" aria-live="polite">
          {summary}
        </p>
        <details className={styles.fold} open>
          <summary>Risks ({risks.length})</summary>
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => setSelected(new Set(selectAllIds(risks)))}
            >
              Select all
            </button>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
            <span className={styles.muted}>
              “Select all” ticks each risk of today&apos;s catalog, one by one; it leaves out
              deprecated entries and the uncategorized-write fallback. A risk added to the catalog
              later is not shared. Each id links to its entry in the{' '}
              <a
                href={`${providerPath(provider.id)}#${REFERENCE_SECTIONS.risks}`}
                target="_blank"
                rel="noreferrer"
                className={styles.refLink}
              >
                {provider.label} reference
              </a>{' '}
              (new tab), where the badges are explained.
            </span>
          </div>
          {bySeverity.map((group) => (
            <section key={group.level} aria-label={`${group.level} risks`}>
              <h3 className={styles.level}>
                <SeverityBadge level={group.level} />
                <span className={styles.muted}>
                  {group.risks.filter((risk) => selected.has(risk.risk_id)).length} of{' '}
                  {group.risks.length}
                </span>
              </h3>
              <ul className={styles.risks}>
                {group.risks.map((risk) => (
                  <li key={risk.risk_id}>
                    <div className={styles.risk}>
                      <input
                        id={`share-risk-${risk.risk_id}`}
                        type="checkbox"
                        name="risk"
                        value={risk.risk_id}
                        checked={selected.has(risk.risk_id)}
                        onChange={() => toggle(risk.risk_id)}
                        aria-label={`Share risk ${risk.risk_id}`}
                      />
                      <RiskExplain risk={risk} newTab labelFor={`share-risk-${risk.risk_id}`} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </details>
      </div>

      {notes.length > 0 && (
        <Banner tone="warning" title="Environment labels">
          {notes.map((note) => (
            <p key={note} className={styles.note}>
              {note}
            </p>
          ))}
        </Banner>
      )}

      <div className={styles.actions}>
        <Button type="submit" disabled={selected.size === 0}>
          {initial.editing ? 'Update the share' : 'Share'}
        </Button>
        <a href={cancelHref}>Cancel</a>
      </div>
    </form>
  );
}
