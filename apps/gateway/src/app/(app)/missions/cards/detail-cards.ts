/**
 * The cards of the mission page (spec §4.2 "On a mission"): the creation screen
 * frozen, one card per resource set, with what each line used this period. Pure, so
 * that the page and the screen cannot draw a mission differently.
 *
 * The rows of a card compare its lines with what each stored trust level writes. For
 * the creator they are read against their authority now, as the edit screen does; for
 * a teammate (or a creator who lost an account) against the lines the mission holds,
 * which is all a reader needs to tell a level from Custom.
 */
import type { RiskId } from '@vaubaan/shared';

import { knownTrustLevels } from '@/lib/missions/macro-actions';
import type { CatalogRisk, IssuanceAccount } from '@/lib/missions/model';
import type { MacroAction } from '@vaubaan/shared';
import type { MissionDetail } from '@/server/missions';

import { entriesOf, type CardState } from '../new/form-state';

/** A service's catalog as the cards read it. */
export interface CardCatalog {
  readonly risks: readonly CatalogRisk[];
  readonly macro_actions: readonly MacroAction[];
  readonly derives_env: boolean;
}

export interface DetailCard {
  readonly account: IssuanceAccount;
  readonly card: CardState;
  /** Calls used this period, per risk of the card. */
  readonly used: Readonly<Record<RiskId, number>>;
  /** Per risk whose gate is open for the period (spec §3.5): until when. */
  readonly openUntil: Readonly<Record<RiskId, string>>;
  readonly lastCheckedAt: string | null;
}

/** The account a card is drawn with: the creator's own, else one built from the mission. */
function accountOf(
  detailAccount: MissionDetail['accounts'][number],
  detail: Pick<MissionDetail, 'policy'>,
  own: IssuanceAccount | undefined,
  catalog: CardCatalog,
): IssuanceAccount {
  if (own) return own;
  const setIds = new Set(detailAccount.resource_sets.map((set) => set.id));
  const resources = new Map(
    [...detailAccount.resources, ...detailAccount.resource_sets.flatMap((s) => s.resources)].map(
      (r) => [r.id, r],
    ),
  );
  return {
    id: detailAccount.id,
    service: detailAccount.service,
    service_label: detailAccount.service_label,
    resource_noun: detailAccount.resource_noun,
    display_name: detailAccount.display_name,
    status: detailAccount.status,
    derives_env: catalog.derives_env,
    default_env: null,
    basis: 'share',
    resources: [...resources.values()],
    risks: catalog.risks,
    authority: detail.policy
      .filter((entry) => setIds.has(entry.resource_set_id ?? ''))
      .map((entry) => entry.risk_id),
    macro_actions: catalog.macro_actions,
  };
}

export function detailCards(
  detail: Pick<MissionDetail, 'accounts' | 'policy'>,
  /** The creator's issuance context; empty for anyone else. */
  context: readonly IssuanceAccount[],
  catalogOf: (service: string) => CardCatalog | null,
): DetailCard[] {
  return detail.accounts.flatMap((c) => {
    const catalog = catalogOf(c.service);
    if (!catalog) return [];
    const own = context.find((x) => x.id === c.id);
    const account = accountOf(c, detail, own, catalog);
    return c.resource_sets.map((set): DetailCard => {
      const lines = detail.policy.filter((entry) => entry.resource_set_id === set.id);
      return {
        account,
        card: {
          key: set.id,
          id: set.id,
          accountId: c.id,
          resourceIds: set.resources.map((r) => r.id),
          future: set.future,
          env: set.env,
          trustLevels: knownTrustLevels(account, set.trust_levels),
          entries: entriesOf(lines),
        },
        used: Object.fromEntries(
          lines.map((entry) => [
            entry.risk_id,
            entry.remaining === null ? 0 : Math.max(0, entry.quota - entry.remaining),
          ]),
        ),
        openUntil: Object.fromEntries(
          lines.flatMap((entry) =>
            entry.gate_open_until ? [[entry.risk_id, entry.gate_open_until] as const] : [],
          ),
        ),
        lastCheckedAt: c.last_checked_at,
      };
    });
  });
}
