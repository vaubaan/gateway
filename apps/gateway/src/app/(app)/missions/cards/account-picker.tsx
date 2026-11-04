'use client';

/**
 * "+ Add an account" (spec §4.2): step 1 picks the account, step 2 its resources,
 * grouped by environment — one environment per card. Each group is a radio: choosing
 * one ticks its free resources, and switching unticks the previous group's; resources
 * are then ticked one by one, and "+ future <resources>" adds those that later appear
 * in that environment. Resources without a label are listed but not selectable where
 * the provider needs labels. "Change" on a card reopens step 2.
 */
import Link from 'next/link';
import { useState } from 'react';

import {
  Button,
  Checkbox,
  Dialog,
  EnvTag,
  Radio,
  SearchField,
  ServiceMark,
  Tag,
} from '@/components/ui';
import type { ServiceMarkIcon } from '@/components/ui';
import { ACTIONS, CARD_WORDS, ROUTES } from '@/lib/vocabulary';
import type { IssuanceConnection } from '@/lib/missions/model';

import { cardsOf, type CardResources, type CardState, type FormState } from '../new/form-state';
import {
  accountLabel,
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
  context: readonly IssuanceConnection[],
  state: Pick<FormState, 'cards'>,
  connection: IssuanceConnection,
): string | null {
  const taken = state.cards.some((card) => {
    const other = context.find((c) => c.id === card.connectionId);
    return (
      other !== undefined && other.provider === connection.provider && other.id !== connection.id
    );
  });
  return taken ? CARD_WORDS.oneAccountPerService : null;
}

/** The accounts "+ Add an account" offers, in context order, with why one cannot be taken. */
export function offeredAccounts(
  context: readonly IssuanceConnection[],
  state: Pick<FormState, 'cards'>,
): { readonly connection: IssuanceConnection; readonly blocked: string | null }[] {
  return context.map((connection) => ({
    connection,
    blocked: blockedBy(context, state, connection),
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
  context: readonly IssuanceConnection[];
  state: FormState;
  icons: Readonly<Record<string, ServiceMarkIcon | null>>;
  picking: Picking;
  onCancel: () => void;
  onDone: (connectionId: string, resources: CardResources) => void;
}) {
  const editing = picking.kind === 'change' ? picking.card : null;
  const [connectionId, setConnectionId] = useState<string | null>(editing?.connectionId ?? null);
  const [query, setQuery] = useState('');
  const connection = context.find((c) => c.id === connectionId) ?? null;

  if (!connection) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const offered = offeredAccounts(context, state).filter(({ connection: c }) => {
      const text = `${c.provider_label} ${c.display_name}`.toLowerCase();
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
          {offered.map(({ connection: c, blocked }) => {
            const has = cardsOf(state, c.id).length > 0;
            const free = has ? freeResources(c, state) : null;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className={styles.accountItem}
                  disabled={blocked !== null}
                  title={blocked ?? undefined}
                  onClick={() => setConnectionId(c.id)}
                >
                  <ServiceMark name={c.provider_label} icon={icons[c.provider] ?? null} />
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
      key={connection.id}
      connection={connection}
      state={state}
      editing={editing}
      onBack={editing ? null : () => setConnectionId(null)}
      onCancel={onCancel}
      onDone={(resources) => onDone(connection.id, resources)}
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

function freeIdsOf(group: ResourceGroup | undefined): string[] {
  return (group?.resources ?? []).filter((r) => !r.elsewhere).map((r) => r.resource.id);
}

function ResourceStep({
  connection,
  state,
  editing,
  onBack,
  onCancel,
  onDone,
}: {
  connection: IssuanceConnection;
  state: FormState;
  editing: CardState | null;
  onBack: (() => void) | null;
  onCancel: () => void;
  onDone: (resources: CardResources) => void;
}) {
  const groups = resourceGroups(connection, state, editing?.key ?? null);
  const initial = startGroup(groups, editing);
  // `undefined`: no group chosen yet.
  const [env, setEnv] = useState<string | null | undefined>(initial);
  const [ticked, setTicked] = useState<readonly string[]>(() =>
    editing
      ? editing.resourceIds
      : initial === undefined
        ? []
        : freeIdsOf(groups.find((g) => g.env === initial)),
  );
  const [future, setFuture] = useState(editing?.future ?? false);
  const noun = connection.resource_noun;
  const labelled = showsEnv(connection);
  const several = groups.filter((g) => g.selectable).length > 1;
  const nothingListed = groups.every((g) => g.resources.length === 0);

  function choose(group: ResourceGroup) {
    if (group.env === env) return;
    setEnv(group.env);
    setTicked(freeIdsOf(group));
    setFuture(false);
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
  return (
    <Dialog
      open
      onClose={onCancel}
      width="lg"
      title={`${accountLabel(connection)} · ${CARD_WORDS.whichResources(noun.other)}`}
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
                  name={`group-${connection.id}`}
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
                    {resource.hidden && <Tag>hidden by its owner</Tag>}
                    {elsewhere && (
                      <span className={styles.groupNote}> {CARD_WORDS.inAnotherCard}</span>
                    )}
                  </Checkbox>
                ) : (
                  <span key={resource.id}>
                    {resourceName(resource)}{' '}
                    <Link
                      href={`${ROUTES.accounts}/${connection.id}`}
                      className={styles.groupNote}
                      target="_blank"
                    >
                      {CARD_WORDS.labelIt}
                    </Link>
                  </span>
                ),
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
            </div>
          </div>
        );
      })}
    </Dialog>
  );
}
