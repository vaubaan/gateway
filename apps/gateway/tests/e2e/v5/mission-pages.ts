/**
 * How a browser test drives the mission pages (the list, "New mission", one
 * mission, its activity): the steps several specs share, written once, with
 * the words and the structure of the interface.
 */
import { expect, type Locator, type Page } from '@playwright/test';

export const KEY = /vbn_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}/;

/** A trust level as the interface names it. */
export type TrustLevel = 'Careful' | 'Trusting' | 'Autonomous';

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** What step 2 of "+ Add an account" picks: a group, exactly these resources, future ones. */
export interface CardPick {
  /** The environment group to take (its radio), when the account has several. */
  readonly env?: string;
  /**
   * Exactly these resources (refs) are ticked; absent, every listed one of the group
   * ("Select all" when it has several: a group ticks only its one resource by itself).
   */
  readonly resources?: readonly string[];
  readonly future?: boolean;
}

/** Step 2 of "+ Add an account" (or "Change"): picks resources, then adds or applies. */
export async function pickResources(page: Page, pick: CardPick, done: string): Promise<void> {
  const step = page.getByTestId('resource-picker');
  await expect(step).toBeVisible();
  if (pick.env) await step.getByRole('radio', { name: `Environment ${pick.env}` }).check();
  if (!pick.resources) {
    const selectAll = pick.env
      ? step.getByTestId(`select-all-${pick.env}`)
      : step.getByRole('button', { name: /^Select all/ }).first();
    if ((await selectAll.count()) > 0) await selectAll.click();
  }
  if (pick.resources) {
    const boxes = step.getByRole('checkbox', { name: /^Resource / });
    for (const box of await boxes.all()) {
      const name = (await box.getAttribute('aria-label')) ?? '';
      const wanted = pick.resources.includes(name.replace(/^Resource /, ''));
      if (wanted && !(await box.isChecked())) await box.check();
      if (!wanted && (await box.isChecked()) && (await box.isEnabled())) await box.uncheck();
    }
  }
  if (pick.future) {
    await step
      .getByRole('checkbox', { name: new RegExp(`^\\+ future .* in ${escaped(pick.env ?? '')}`) })
      .first()
      .check();
  }
  await step.getByRole('button', { name: done, exact: true }).click();
  await expect(step).toBeHidden();
}

/**
 * "+ Add an account": the account (`GitHub · acme-org`), then its resources. Without a
 * pick, the group the account offers alone is taken with what it ticks by itself.
 */
export async function addAccount(page: Page, account: string, pick: CardPick = {}): Promise<void> {
  await page.getByTestId('add-account').click();
  await page
    .getByTestId('account-picker')
    .getByRole('button', { name: new RegExp(`^${escaped(account)}`) })
    .click();
  await pickResources(page, pick, 'Add card');
}

/**
 * Adds a card for an account and ticks macro-actions at a trust level, by their labels:
 * `{ Read: 'Trusting', Propose: 'Careful' }`. `card` names the card as its controls do:
 * the account, and its environment in brackets when the card shows one.
 */
export async function includeWithTrustLevels(
  page: Page,
  account: string,
  trustLevels: Readonly<Record<string, TrustLevel>>,
  pick: CardPick = {},
  card: string = account,
): Promise<void> {
  await addAccount(page, account, pick);
  for (const [action, trustLevel] of Object.entries(trustLevels))
    await pickTrustLevel(page, card, action, trustLevel);
}

/** One card of the screen or of the mission page, by the name its controls carry. */
export function cardOf(page: Page, card: string): Locator {
  return page.getByRole('region', { name: card, exact: true });
}

/** The radio of one segment of a macro-action's trust control on a card. */
export function trustLevelChoice(
  page: Page,
  card: string,
  action: string,
  trustLevel: TrustLevel | 'Custom',
): Locator {
  return page
    .getByRole('group', { name: `Trust level of ${action} on ${card}`, exact: true })
    .getByRole('radio', { name: trustLevel, exact: true });
}

/** Ticks a macro-action at a trust level (or moves it there). */
export async function pickTrustLevel(
  page: Page,
  card: string,
  action: string,
  trustLevel: TrustLevel,
): Promise<void> {
  await trustLevelChoice(page, card, action, trustLevel).check();
}

/** "Custom" on a macro-action: the modal of its permissions, one by one. */
export async function openCustom(page: Page, card: string, action: string): Promise<Locator> {
  await trustLevelChoice(page, card, action, 'Custom').click();
  const modal = page.getByTestId('custom-modal');
  await expect(modal).toBeVisible();
  return modal;
}

/**
 * Custom on a macro-action, then exactly these of its permissions run freely, the
 * others left out, and Apply.
 */
export async function allowOnly(
  page: Page,
  card: string,
  action: string,
  riskIds: readonly string[],
): Promise<void> {
  const modal = await openCustom(page, card, action);
  for (const riskId of riskIds) {
    await modal
      .getByRole('group', { name: `Behaviour of ${riskId}`, exact: true })
      .getByRole('radio', { name: 'Runs freely' })
      .check();
  }
  await modal.getByRole('button', { name: 'Apply' }).click();
  await expect(modal).toBeHidden();
}

/**
 * "Create mission" (no confirmation: spec §4.2), then the key shown once.
 * Returns the key.
 */
export async function createMission(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Create mission' }).click();
  await expect(page.getByTestId('created')).toBeVisible();
  return revealedKey(page);
}

/** The key a page or a dialog shows once, read from the box and checked against the kit. */
export async function revealedKey(page: Page): Promise<string> {
  const shown = (await page.getByTestId('revealed-key').innerText()).trim();
  const match = KEY.exec(shown);
  if (!match) throw new Error(`no key in the box: ${shown}`);
  // The first snippet of the kit carries the same key, and no other snippet does.
  await expect(page.getByTestId('kit-env')).toContainText(match[0]);
  return match[0];
}

/** After a creation: "Open the mission". */
export async function openCreatedMission(page: Page, name: string | RegExp): Promise<void> {
  await page.getByRole('link', { name: 'Open the mission' }).click();
  // The page that showed the key carries the same title: wait for the mission's own page.
  await page.waitForURL(/\/missions\/(?!new(?:[?#]|$))[^/?#]+$/);
  await expect(page.getByTestId('created')).toHaveCount(0);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

/** Closes the dialog that shows a key once. */
export async function savedKey(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'I saved the key' }).click();
  await expect(page.getByTestId('reveal-dialog')).toBeHidden();
}

/** Opens "···" on a mission page and chooses an item. */
export async function missionMenu(page: Page, item: string): Promise<void> {
  await page.getByTestId('mission-menu').click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

/** Unfolds "Permissions and usage" on the activity of a mission (remembered per mission afterwards). */
export async function showPermissions(page: Page): Promise<Locator> {
  const section = page.getByTestId('session-permissions');
  const table = section.getByTestId('permissions-table');
  if (!(await table.isVisible())) {
    await section.getByRole('button', { name: /^All \d+ permissions?/ }).click();
  }
  await expect(table).toBeVisible();
  return table;
}

/** The row of one permission, by the id the protocol gives it. */
export function permissionRow(scope: Page | Locator, riskId: string): Locator {
  return scope.locator(`[data-permission="${riskId}"]`);
}

/** The row of a key holder in "People and keys": `member:<email>` or `machine:<name>`. */
export function holderRow(page: Page, id: string): Locator {
  return page.getByTestId('team-table').locator(`tr[data-row="${id}"]`);
}

/** Types the phrase a destructive dialog asks for, then confirms with the button named after the act. */
export async function confirmByTyping(page: Page, phrase: string, act: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill(phrase);
  await dialog.getByRole('button', { name: act, exact: true }).click();
}
