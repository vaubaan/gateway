/**
 * What a mission card shows, read from its state — pure, so the screen's words and
 * counts are unit-tested without a browser (spec §4.2; risk model §4.6, §4.7; ADR
 * resource-set-is-one-environment-with-optional-future-resources).
 *
 * Every word a card prints comes from a field every plugin declares or from a
 * generic word of the gateway: the plugin's `resourceNoun` ("boards", else
 * "resources"), the catalog's macro-action and risk labels, the data model's plane
 * slugs, the resources' environment labels, the trust level labels, and "Custom",
 * "never in <env>", "future", "Check now". Nothing here is written for one service.
 *
 * The creation/edit screen and the mission page draw the same cards from these
 * functions: the page is the screen frozen, plus the use of the period.
 */
import type { ResourceNoun } from '@vaubaan/plugin-sdk';
import type { Gate, RiskId } from '@vaubaan/shared';

import { isResolvable } from '@/lib/missions/catalog-view';
import { expandMacroAction, rowsOf, type TrustLevel } from '@/lib/missions/macro-actions';
import type { CatalogRisk, IssuanceAccount, IssuanceResource } from '@/lib/missions/model';
import { needsEnvLabel } from '@/lib/missions/preview';
import type { RiskPlanes } from '@/lib/providers/planes';
import {
  CARD_WORDS,
  formatNumber,
  listed,
  TRUST_LEVEL_CUSTOM,
  TRUST_LEVEL_LABELS,
} from '@/lib/vocabulary';

import {
  accountWithoutResources,
  actionEntries,
  cardResources,
  cardsOf,
  levelEntries,
  OUTSIDE_AUTHORITY,
  sameEntries,
  type CardState,
  type EntryState,
  type FormState,
} from '../new/form-state';

// ─────────────────────────────────────────────────────────────────────────────
// Generic words of a card
// ─────────────────────────────────────────────────────────────────────────────

/** A card's level as its segment names it. */
export type CardLevel = TrustLevel | 'custom';

export function levelLabel(level: CardLevel): string {
  return level === 'custom' ? TRUST_LEVEL_CUSTOM : TRUST_LEVEL_LABELS[level];
}

/** "2 boards", "1 board". */
export function nounCount(n: number, noun: ResourceNoun): string {
  return `${formatNumber(n)} ${n === 1 ? noun.one : noun.other}`;
}

/** A resource as the pages name it. */
export function resourceName(r: Pick<IssuanceResource, 'display_name' | 'ref'>): string {
  return r.display_name || r.ref;
}

/**
 * What a card reaches, in one line: "2 boards: Unizic, Roadmap Q1", "+ future
 * boards", or "the account itself" for an account that lists no resource.
 */
export function resourcesLine(
  noun: ResourceNoun,
  resources: readonly Pick<IssuanceResource, 'display_name' | 'ref'>[],
  future: boolean,
  accountItself = false,
): string {
  const tail = future ? CARD_WORDS.future(noun.other) : '';
  if (resources.length === 0) {
    if (future) return tail;
    return accountItself ? CARD_WORDS.accountItself : nounCount(0, noun);
  }
  const head = `${nounCount(resources.length, noun)}: ${listed(resources.map(resourceName), 3)}`;
  return future ? `${head} ${tail}` : head;
}

/**
 * True when the card names its environment in its head: the provider has permissions
 * that depend on an environment read from resource labels (`needsEnvLabel`). A
 * provider that reads it from the call itself, or has none, shows no badge.
 */
export function showsEnv(account: Pick<IssuanceAccount, 'risks' | 'derives_env'>): boolean {
  return needsEnvLabel(account);
}

/** "Miro · Renaud Perso". */
export function accountLabel(
  account: Pick<IssuanceAccount, 'provider_label' | 'display_name'>,
): string {
  return `${account.provider_label} · ${account.display_name}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The rows of a card: one per macro-action
// ─────────────────────────────────────────────────────────────────────────────

/** A line of a macro-action as a card holds it. */
export interface ActionLine {
  readonly risk: CatalogRisk;
  readonly entry: EntryState;
}

export interface ActionRow {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The segment lit: a level, Custom, or `null` when not ticked. */
  readonly level: CardLevel | null;
  /** The trust level stored with the card (Custom's starting level); `null` when not ticked. */
  readonly storedLevel: TrustLevel | null;
  /** Its lines on the card, catalog order. */
  readonly lines: readonly ActionLine[];
  readonly free: number;
  readonly asks: number;
  /** Permissions of it that could be given on this card and are not. */
  readonly leftOut: readonly CatalogRisk[];
  /** Nothing of it can be given on this card: its row cannot be ticked. */
  readonly empty: boolean;
}

function lineOf(card: Pick<CardState, 'entries'>) {
  return (risk: CatalogRisk): ActionLine[] => {
    const entry = card.entries[risk.risk_id];
    return entry ? [{ risk, entry }] : [];
  };
}

/** Why a permission cannot be given on a card, or `null`. */
export function unavailableOn(
  account: Pick<IssuanceAccount, 'authority' | 'derives_env'>,
  risk: Pick<CatalogRisk, 'risk_id' | 'env'>,
  resources: readonly Pick<IssuanceResource, 'env'>[],
): string | null {
  if (!account.authority.includes(risk.risk_id)) return OUTSIDE_AUTHORITY;
  if (!isResolvable(risk, account, resources)) return `no ${risk.env ?? ''} resource on the card`;
  return null;
}

/**
 * The rows of a card's macro-action that belong to its environment: account-wide
 * ones, and the ones qualified with the card's environment (every environment when
 * the plugin reads it from the call).
 */
function rowsOnCard(
  account: Pick<IssuanceAccount, 'risks' | 'derives_env'>,
  card: Pick<CardState, 'env'>,
  action: Parameters<typeof rowsOf>[1],
): CatalogRisk[] {
  return rowsOf(account, action).filter(
    (risk) => risk.env === null || account.derives_env || risk.env === card.env,
  );
}

/** One row per macro-action of the account, with what the card holds of it. */
export function actionRows(account: IssuanceAccount, card: CardState): ActionRow[] {
  const resources = cardResources(account, card);
  return account.macro_actions.map((action) => {
    const storedLevel = card.trustLevels[action.id] ?? null;
    const own = actionEntries(account, card, action.id);
    const lines = rowsOf(account, action).flatMap(lineOf(card));
    const level: CardLevel | null =
      storedLevel !== null && sameEntries(own, levelEntries(account, card, action.id, storedLevel))
        ? storedLevel
        : lines.length > 0
          ? 'custom'
          : null;
    const free = lines.filter((line) => line.entry.gate === 'auto').length;
    const leftOut = rowsOnCard(account, card, action).filter(
      (risk) =>
        card.entries[risk.risk_id] === undefined &&
        unavailableOn(account, risk, resources) === null &&
        !risk.deprecated,
    );
    return {
      id: action.id,
      label: action.label,
      description: action.description,
      level,
      storedLevel: level === null ? null : storedLevel,
      lines,
      free,
      asks: lines.length - free,
      leftOut,
      empty:
        level === null &&
        expandMacroAction(account, action, 'autonomous', resources).lines.length === 0,
    };
  });
}

/** "5 permissions · 3 run freely · 2 ask you": the foot of a card. */
export interface CardDigest {
  readonly total: number;
  readonly free: number;
  readonly asks: number;
}

export function cardDigest(rows: readonly ActionRow[]): CardDigest {
  const free = rows.reduce((n, row) => n + row.free, 0);
  const asks = rows.reduce((n, row) => n + row.asks, 0);
  return { total: free + asks, free, asks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Custom: the permissions of one macro-action, one by one
// ─────────────────────────────────────────────────────────────────────────────

/** What a permission does on the card: runs freely, asks first, or is left out. */
export type Behaviour = 'free' | 'ask' | 'out';

export function behaviourOf(entry: EntryState | null | undefined): Behaviour {
  if (!entry) return 'out';
  return entry.gate === 'approval' ? 'ask' : 'free';
}

export function gateOf(behaviour: Exclude<Behaviour, 'out'>): Gate {
  return behaviour === 'ask' ? 'approval' : 'auto';
}

export interface CustomRow {
  readonly risk: CatalogRisk;
  /** The planes of its catalog entry (data model slugs); empty when the model has one. */
  readonly planes: readonly string[];
  /** Why it cannot be given on this card, or `null`. */
  readonly unavailable: string | null;
}

/** A permission of the macro-action the catalog does not accept in the card's environment. */
export interface NeverRow {
  readonly baseId: RiskId;
  readonly label: string;
  readonly planes: readonly string[];
}

export interface CustomView {
  readonly rows: readonly CustomRow[];
  /** "never in <env>": listed, never offered. */
  readonly never: readonly NeverRow[];
  /** The plane chips: every slug some row carries, with how many rows; empty without planes. */
  readonly planes: readonly { readonly slug: string; readonly count: number }[];
}

/** The content of the Custom modal (and of the (i) of a row) for one macro-action of a card. */
export function customView(
  account: IssuanceAccount,
  card: CardState,
  actionId: string,
  planes: RiskPlanes | null,
): CustomView {
  const action = account.macro_actions.find((a) => a.id === actionId);
  if (!action) return { rows: [], never: [], planes: [] };
  const resources = cardResources(account, card);
  const planesOf = (baseId: RiskId): readonly string[] => planes?.by_risk[baseId] ?? [];
  const rows = rowsOnCard(account, card, action)
    .filter((risk) => !risk.deprecated || card.entries[risk.risk_id] !== undefined)
    .map((risk) => ({
      risk,
      planes: planesOf(risk.base_id),
      unavailable: unavailableOn(account, risk, resources),
    }));
  const env = card.env;
  const never: NeverRow[] = [];
  if (env !== null && !account.derives_env) {
    const shown = new Set(rows.map((row) => row.risk.base_id));
    const variants = rowsOf(account, action);
    for (const entry of action.entries) {
      if (shown.has(entry.risk_id)) continue;
      const first = variants.find((risk) => risk.base_id === entry.risk_id);
      if (!first || first.env === null) continue;
      never.push({ baseId: entry.risk_id, label: first.label, planes: planesOf(entry.risk_id) });
    }
  }
  const counts = new Map<string, number>();
  for (const p of [...rows.map((r) => r.planes), ...never.map((n) => n.planes)]) {
    for (const slug of p) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const ordered = planes ? planes.planes.filter((slug) => counts.has(slug)) : [];
  return {
    rows,
    never,
    planes: ordered.map((slug) => ({ slug, count: counts.get(slug) ?? 0 })),
  };
}

/** The lines of a macro-action as the modal starts with them: the card's, else none. */
export function customDraftOf(
  card: Pick<CardState, 'entries'>,
  view: CustomView,
): Record<RiskId, EntryState | null> {
  return Object.fromEntries(
    view.rows.map((row) => [row.risk.risk_id, card.entries[row.risk.risk_id] ?? null]),
  );
}

/** "Start from" a level: the lines it writes on the card, every other row left out. */
export function startFrom(
  account: IssuanceAccount,
  card: CardState,
  actionId: string,
  view: CustomView,
  level: TrustLevel,
): Record<RiskId, EntryState | null> {
  const written = levelEntries(account, card, actionId, level);
  return Object.fromEntries(
    view.rows.map((row) => [row.risk.risk_id, written[row.risk.risk_id] ?? null]),
  );
}

/** The level a modal's lines fall back on exactly, if any: Apply then lights it, not Custom. */
export function levelMatching(
  account: IssuanceAccount,
  card: CardState,
  actionId: string,
  lines: Readonly<Record<RiskId, EntryState | null>>,
  levels: readonly TrustLevel[],
): TrustLevel | null {
  const kept = Object.fromEntries(
    Object.entries(lines).filter((pair): pair is [RiskId, EntryState] => pair[1] !== null),
  );
  return (
    levels.find((level) => sameEntries(kept, levelEntries(account, card, actionId, level))) ?? null
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// "+ Add an account", step 2: the resources, grouped by environment
// ─────────────────────────────────────────────────────────────────────────────

export interface GroupResource {
  readonly resource: IssuanceResource;
  /** Held by another card of the mission: a resource is in one card only. */
  readonly elsewhere: boolean;
}

export interface ResourceGroup {
  /** The environment label, `null` for the resources without one. */
  readonly env: string | null;
  /** The resources listed: neither hidden from new missions nor stale nor the instance's own. */
  readonly resources: readonly GroupResource[];
  /**
   * The resources hidden from new missions (by the owner, or by discovery: a public GitHub
   * repository the token cannot act on), listed collapsed and never ticked by default — as
   * "every resource known" leaves them out (`preview.ts`). One a card holds stays tickable.
   */
  readonly hidden: readonly GroupResource[];
  /** Resources without a label do not enter a card where the provider needs labels. */
  readonly selectable: boolean;
  /** Another card of this account already takes the future resources of this environment. */
  readonly futureElsewhere: boolean;
}

/**
 * The resources of an account a card may pick, one group per environment (labelled
 * ones in the account's order, then the ones without a label), plus an empty group per
 * environment of the catalog no resource carries yet — a card of future resources only.
 * Stale resources and the instance's own never enter a mission and are not listed; hidden
 * ones are apart (`ResourceGroup.hidden`).
 */
export function resourceGroups(
  account: IssuanceAccount,
  state: Pick<FormState, 'cards'>,
  editingKey: string | null,
): ResourceGroup[] {
  const others = cardsOf(state, account.id).filter((card) => card.key !== editingKey);
  const held = new Set(others.flatMap((card) => card.resourceIds));
  const listedResources = account.resources.filter((r) => !r.stale && !r.self);
  const labelled = needsEnvLabel(account);
  const envs: (string | null)[] = [];
  for (const r of listedResources) if (r.env !== null && !envs.includes(r.env)) envs.push(r.env);
  if (labelled) {
    for (const risk of account.risks) {
      if (risk.env !== null && !envs.includes(risk.env)) envs.push(risk.env);
    }
  }
  if (listedResources.some((r) => r.env === null) || (!labelled && envs.length === 0)) {
    envs.push(null);
  }
  const of = (env: string | null, hidden: boolean) =>
    listedResources
      .filter((r) => r.env === env && r.hidden === hidden)
      .map((resource) => ({ resource, elsewhere: held.has(resource.id) }));
  return envs.map((env) => ({
    env,
    resources: of(env, false),
    hidden: of(env, true),
    selectable: env !== null || !labelled,
    futureElsewhere: others.some((card) => card.future && card.env === env),
  }));
}

/** "2 of 4 boards free": what another card of an account may still take. */
export function freeResources(
  account: IssuanceAccount,
  state: Pick<FormState, 'cards'>,
): { readonly free: number; readonly total: number } {
  const groups = resourceGroups(account, state, null);
  const all = groups.flatMap((g) => g.resources);
  return { free: all.filter((r) => !r.elsewhere).length, total: all.length };
}

/** The listed resources of a group no other card holds: what "Select all" ticks. */
export function freeIdsOf(group: ResourceGroup | undefined): string[] {
  return (group?.resources ?? []).filter((r) => !r.elsewhere).map((r) => r.resource.id);
}

/**
 * What choosing a group ticks by itself: its one free listed resource, else nothing — a
 * person ticks what the mission needs, or "Select all". Hidden ones are never ticked.
 */
export function defaultTicked(group: ResourceGroup | undefined): string[] {
  const free = freeIdsOf(group);
  return free.length === 1 ? free : [];
}

/** The account reached as itself: it lists no resource, and a card of it ticks none. */
export function reachesAccountItself(account: IssuanceAccount, card: CardState): boolean {
  return accountWithoutResources(account) && card.resourceIds.length === 0 && !card.future;
}

// ─────────────────────────────────────────────────────────────────────────────
// The mission page: today's use per macro-action
// ─────────────────────────────────────────────────────────────────────────────

/** One line's use in the current period. */
export interface LineUsage {
  readonly riskId: RiskId;
  readonly label: string;
  readonly used: number;
  readonly quota: number;
  readonly gate: Gate;
}

/**
 * The line a macro-action's gauge follows: the one closest to its limit (the highest
 * share used; the larger count on a tie), so that a near limit is never averaged away.
 * `null` without lines.
 */
export function gaugeOf(lines: readonly LineUsage[]): LineUsage | null {
  let best: LineUsage | null = null;
  let bestShare = -1;
  for (const line of lines) {
    const share = line.quota <= 0 ? 1 : line.used / line.quota;
    if (share > bestShare || (share === bestShare && best !== null && line.used > best.used)) {
      best = line;
      bestShare = share;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// The summary bar: what changed, before saving
// ─────────────────────────────────────────────────────────────────────────────

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function levelsOf(
  account: IssuanceAccount,
  card: CardState,
): ReadonlyMap<string, { readonly level: CardLevel | null; readonly lines: string }> {
  return new Map(
    actionRows(account, card).map((row) => [
      row.id,
      { level: row.level, lines: JSON.stringify(row.lines.map((l) => [l.risk.risk_id, l.entry])) },
    ]),
  );
}

/**
 * What changed between the screen as it opened and as it stands, one short phrase
 * each, at the level of the cards: "Draw Careful → Trusting", "Comment removed",
 * "Miro · Perso added". The confirmation lists every permission afterwards.
 */
export function changeSummary(
  context: readonly IssuanceAccount[],
  before: FormState,
  after: FormState,
  keptExpiry: { readonly before: string | null; readonly after: string | null },
): string[] {
  const phrases: string[] = [];
  if (before.name.trim() !== after.name.trim()) phrases.push('Name changed');
  if (keptExpiry.before !== keptExpiry.after) phrases.push('End date changed');
  const several = after.cards.length > 1 || before.cards.length > 1;
  const find = (id: string) => context.find((c) => c.id === id);
  const prefix = (account: IssuanceAccount) => (several ? `${account.provider_label} · ` : '');
  for (const card of before.cards) {
    const account = find(card.accountId);
    if (account && !after.cards.some((c) => c.key === card.key)) {
      phrases.push(`${accountLabel(account)} removed`);
    }
  }
  for (const card of after.cards) {
    const account = find(card.accountId);
    if (!account) continue;
    const old = before.cards.find((c) => c.key === card.key);
    if (!old) {
      phrases.push(`${accountLabel(account)} added`);
      continue;
    }
    if (!sameIds(old.resourceIds, card.resourceIds) || old.future !== card.future) {
      phrases.push(`${prefix(account)}${account.resource_noun.other} changed`);
    }
    const was = levelsOf(account, old);
    const now = levelsOf(account, card);
    for (const action of account.macro_actions) {
      const a = was.get(action.id);
      const b = now.get(action.id);
      if (!a || !b) continue;
      const name = `${prefix(account)}${action.label}`;
      if (a.level === null && b.level !== null) phrases.push(`${name} added`);
      else if (a.level !== null && b.level === null) phrases.push(`${name} removed`);
      else if (a.level !== null && b.level !== null && a.level !== b.level) {
        phrases.push(`${name} ${levelLabel(a.level)} → ${levelLabel(b.level)}`);
      } else if (a.lines !== b.lines) phrases.push(`${name} changed`);
    }
  }
  return phrases;
}
