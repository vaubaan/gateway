'use client';

/**
 * "+ Add an account" (spec §4.2): step 1 picks the account, step 2 its resources,
 * grouped by environment — one environment per card. Each group is a radio: choosing
 * one ticks its resource when it has exactly one, and nothing otherwise ("Select all"
 * ticks its free ones); switching unticks the previous group's. Resources are ticked one
 * by one, and "+ future <resources>" adds those that later appear in that environment.
 * Resources hidden from new missions are collapsed under "Hidden from new missions (n)",
 * never ticked by default. Resources without a label are listed but not selectable where
 * the service needs labels. "Change" on a card reopens step 2.
 */
import Link from 'next/link';
import { useState } from 'react';

import {
  Button,
  Checkbox,
  Dialog,
  DocHint,
  EnvTag,
  Radio,
  SearchField,
  ServiceMark,
} from '@/components/ui';
import type { ServiceMarkIcon } from '@/components/ui';
import { ACTIONS, CARD_WORDS, DOC_PAGES, ROUTES } from '@/lib/vocabulary';
import type { IssuanceAccount } from '@/lib/missions/model';

import { cardsOf, type CardResources, type CardState, type FormState } from '../new/form-state';
import {
  accountLabel,
  defaultTicked,
  freeIdsOf,
  freeResources,
  nounCount,
  resourceGroups,
  resourceName,
  showsEnv,
  type ResourceGroup,
} from './card-model';
import styles from './cards.module.css';

/** What the dialog edits: a new card (from step 1), or the resources of a card ("Change"). */
export type Picking =
  { readonly kind: 'add' } | { readonly kind: 'change'; readonly card: CardState };

/** The account cannot be added: another account of its service is in the mission. */
function blockedBy(
  context: readonly IssuanceAccount[],
  state: Pick<FormState, 'cards'>,
  account: IssuanceAccount,
): string | null {
  const taken = state.cards.some((card) => {
    const other = context.find((c) => c.id === card.accountId);
    return other !== undefined && other.service === account.service && other.id !== account.id;
  });
  return taken ? CARD_WORDS.oneAccountPerService : null;
}

/** The accounts "+ Add an account" offers, in context order, with why one cannot be taken. */
export function offeredAccounts(
  context: readonly IssuanceAccount[],
  state: Pick<FormState, 'cards'>,
): { readonly account: IssuanceAccount; readonly blocked: string | null }[] {
  return context.map((account) => ({
    account,
    blocked: blockedBy(context, state, account),
  }));
}

export function AccountPicker({
  context,
  state,
  icons,
  picking,
  onCancel,
  onDone,
}: {
  context: readonly IssuanceAccount[];
  state: FormState;
  icons: Readonly<Record<string, ServiceMarkIcon | null>>;
  picking: Picking;
  onCancel: () => void;
  onDone: (accountId: string, resources: CardResources) => void;
}) {
  const editing = picking.kind === 'change' ? picking.card : null;
  const [accountId, setAccountId] = useState<string | null>(editing?.accountId ?? null);
  const [query, setQuery] = useState('');
  const account = context.find((c) => c.id === accountId) ?? null;

  if (!account) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const offered = offeredAccounts(context, state).filter(({ account: c }) => {
      const text = `${c.service_label} ${c.display_name}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    return (
      <Dialog
        open
        onClose={onCancel}
        title={CARD_WORDS.pickAccount}
        testId="account-picker"
        footer={
          <Button type="button" variant="ghost" onClick={onCancel}>
            {ACTIONS.cancel}
          </Button>
        }
      >
        <SearchField
          label={CARD_WORDS.searchAccounts}
          placeholder={CARD_WORDS.searchAccounts}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ul className={styles.accountList}>
          {offered.map(({ account: c, blocked }) => {
            const has = cardsOf(state, c.id).length > 0;
            const free = has ? freeResources(c, state) : null;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={styles.accountItem}
                  disabled={blocked !== null}
                  title={blocked ?? undefined}
                  onClick={() => setAccountId(c.id)}
                >
                  <ServiceMark name={c.service_label} icon={icons[c.service] ?? null} />
                  {accountLabel(c)}
                  <span className={styles.accountFree}>
                    {blocked ??
                      (free ? CARD_WORDS.free(free.free, free.total, c.resource_noun.other) : '')}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Dialog>
    );
  }

  return (
    <ResourceStep
      key={account.id}
      account={account}
      state={state}
      editing={editing}
      onBack={editing ? null : () => setAccountId(null)}
      onCancel={onCancel}
      onDone={(resources) => onDone(account.id, resources)}
    />
  );
}

/** The group a set of resources was ticked in; the first selectable one with free resources otherwise. */
function startGroup(
  groups: readonly ResourceGroup[],
  editing: CardState | null,
): string | null | undefined {
  if (editing) return editing.env;
  const selectable = groups.filter((g) => g.selectable);
  return selectable.length === 1 ? selectable[0]?.env : undefined;
}

function ResourceStep({
  account,
  state,
  editing,
  onBack,
  onCancel,
  onDone,
}: {
  account: IssuanceAccount;
  state: FormState;
  editing: CardState | null;
  onBack: (() => void) | null;
  onCancel: () => void;
  onDone: (resources: CardResources) => void;
}) {
  const groups = resourceGroups(account, state, editing?.key ?? null);
  const initial = startGroup(groups, editing);
  // `undefined`: no group chosen yet.
  const [env, setEnv] = useState<string | null | undefined>(initial);
  const [ticked, setTicked] = useState<readonly string[]>(() =>
    editing
      ? editing.resourceIds
      : initial === undefined
        ? []
        : defaultTicked(groups.find((g) => g.env === initial)),
  );
  const [future, setFuture] = useState(editing?.future ?? false);
  // Open at first only where the card being changed holds a hidden resource; the person
  // opens or closes it after that (a constant prop, so a tick never closes it).
  const [openHidden] = useState(
    () =>
      new Set(
        groups
          .filter((g) => g.hidden.some((r) => editing?.resourceIds.includes(r.resource.id)))
          .map((g) => g.env ?? 'no label'),
      ),
  );
  const noun = account.resource_noun;
  const labelled = showsEnv(account);
  const several = groups.filter((g) => g.selectable).length > 1;
  const nothingListed = groups.every((g) => g.resources.length + g.hidden.length === 0);

  function choose(group: ResourceGroup) {
    if (group.env === env) return;
    setEnv(group.env);
    setTicked(defaultTicked(group));
    setFuture(false);
  }
  function selectAll(group: ResourceGroup) {
    if (group.env !== env) {
      setEnv(group.env);
      setFuture(false);
    }
    setTicked(freeIdsOf(group));
  }
  function tick(group: ResourceGroup, id: string, on: boolean) {
    if (group.env !== env) {
      setEnv(group.env);
      setFuture(false);
      setTicked(on ? [id] : []);
      return;
    }
    setTicked((current) => (on ? [...current, id] : current.filter((x) => x !== id)));
  }

  const ready = env !== undefined && (ticked.length > 0 || future || (nothingListed && !labelled));
  // One (i) for "resources found later", beside the first checkbox that offers them.
  const firstFuture = groups.find((group) => group.selectable);
  return (
    <Dialog
      open
      onClose={onCancel}
      width="lg"
      title={`${accountLabel(account)} · ${CARD_WORDS.whichResources(noun.other)}`}
      testId="resource-picker"
      footer={
        <>
          <Button
            type="button"
            variant="primary"
            disabled={!ready}
            onClick={() => env !== undefined && onDone({ resourceIds: ticked, future, env })}
          >
            {editing ? CARD_WORDS.saveCard : CARD_WORDS.addCard}
          </Button>
          {onBack && (
            <Button type="button" variant="ghost" onClick={onBack}>
              Back
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={onCancel}>
            {ACTIONS.cancel}
          </Button>
        </>
      }
    >
      {groups.map((group) => {
        const on = group.env === env;
        const label = group.env ?? 'no label';
        return (
          <div
            key={label}
            className={[styles.group, on ? styles.groupOn : ''].join(' ')}
            data-testid={`group-${label}`}
          >
            <div className={styles.groupHead}>
              {several && group.selectable && (
                <Radio
                  name={`group-${account.id}`}
                  checked={on}
                  aria-label={`Environment ${label}`}
                  onChange={() => choose(group)}
                />
              )}
              {labelled || group.env !== null ? <EnvTag env={group.env} /> : null}
              <span className={styles.groupCount}>
                {group.selectable
                  ? nounCount(group.resources.length, noun)
                  : CARD_WORDS.notSelectable}
              </span>
              {group.selectable && freeIdsOf(group).length > 1 && (
                <span className={styles.groupSelectAll}>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={`${CARD_WORDS.selectAll} in ${label}`}
                    onClick={() => selectAll(group)}
                    data-testid={`select-all-${label}`}
                  >
                    {CARD_WORDS.selectAll}
                  </Button>
                </span>
              )}
            </div>
            <div className={styles.groupBody}>
              {group.resources.map(({ resource, elsewhere }) =>
                group.selectable ? (
                  <Checkbox
                    key={resource.id}
                    checked={on && ticked.includes(resource.id)}
                    disabled={elsewhere}
                    aria-label={`Resource ${resource.ref}`}
                    onChange={(e) => tick(group, resource.id, e.target.checked)}
                  >
                    {resourceName(resource)}
                    {elsewhere && (
                      <span className={styles.groupNote}> {CARD_WORDS.inAnotherCard}</span>
                    )}
                  </Checkbox>
                ) : (
                  <span key={resource.id}>
                    {resourceName(resource)}{' '}
                    <Link
                      href={`${ROUTES.accounts}/${account.id}`}
                      className={styles.groupNote}
                      target="_blank"
                    >
                      {CARD_WORDS.labelIt}
                    </Link>
                  </span>
                ),
              )}
              {group.selectable && group.hidden.length > 0 && (
                <details
                  className={styles.groupHidden}
                  open={openHidden.has(label)}
                  data-testid={`hidden-${label}`}
                >
                  <summary>{CARD_WORDS.hiddenResources(group.hidden.length)}</summary>
                  <div className={styles.groupHiddenList}>
                    {group.hidden.map(({ resource, elsewhere }) => (
                      <Checkbox
                        key={resource.id}
                        checked={on && ticked.includes(resource.id)}
                        disabled={elsewhere}
                        aria-label={`Hidden resource ${resource.ref}`}
                        onChange={(e) => tick(group, resource.id, e.target.checked)}
                      >
                        {resourceName(resource)}
                        {elsewhere && (
                          <span className={styles.groupNote}> {CARD_WORDS.inAnotherCard}</span>
                        )}
                      </Checkbox>
                    ))}
                  </div>
                </details>
              )}
              {group.selectable && (
                <Checkbox
                  checked={on && future}
                  disabled={group.futureElsewhere}
                  aria-label={`${CARD_WORDS.future(noun.other)} in ${label}`}
                  onChange={(e) => {
                    if (!on) {
                      setEnv(group.env);
                      setTicked([]);
                    }
                    setFuture(e.target.checked);
                  }}
                >
                  {CARD_WORDS.future(noun.other)}
                  {group.futureElsewhere && (
                    <span className={styles.groupNote}> {CARD_WORDS.inAnotherCard}</span>
                  )}
                </Checkbox>
              )}
              {group === firstFuture && (
                <DocHint to={DOC_PAGES.futureResources} testId="doc-link-future-resources" />
              )}
            </div>
          </div>
        );
      })}
    </Dialog>
  );
}
