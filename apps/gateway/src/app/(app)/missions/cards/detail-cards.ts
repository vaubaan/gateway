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
import type { CatalogRisk, IssuanceConnection } from '@/lib/missions/model';
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
  readonly connection: IssuanceConnection;
  readonly card: CardState;
  /** Calls used this period, per risk of the card. */
  readonly used: Readonly<Record<RiskId, number>>;
  /** Per risk whose gate is open for the period (spec §3.5): until when. */
  readonly openUntil: Readonly<Record<RiskId, string>>;
  readonly lastCheckedAt: string | null;
}

/** The connection a card is drawn with: the creator's own, else one built from the mission. */
function connectionOf(
  detailConnection: MissionDetail['connections'][number],
  detail: Pick<MissionDetail, 'policy'>,
  own: IssuanceConnection | undefined,
  catalog: CardCatalog,
): IssuanceConnection {
  if (own) return own;
  const setIds = new Set(detailConnection.resource_sets.map((set) => set.id));
  const resources = new Map(
    [
      ...detailConnection.resources,
      ...detailConnection.resource_sets.flatMap((s) => s.resources),
    ].map((r) => [r.id, r]),
  );
  return {
    id: detailConnection.id,
    provider: detailConnection.provider,
    provider_label: detailConnection.provider_label,
    resource_noun: detailConnection.resource_noun,
    display_name: detailConnection.display_name,
    status: detailConnection.status,
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
  detail: Pick<MissionDetail, 'connections' | 'policy'>,
  /** The creator's issuance context; empty for anyone else. */
  context: readonly IssuanceConnection[],
  catalogOf: (provider: string) => CardCatalog | null,
): DetailCard[] {
  return detail.connections.flatMap((c) => {
    const catalog = catalogOf(c.provider);
    if (!catalog) return [];
    const own = context.find((x) => x.id === c.id);
    const connection = connectionOf(c, detail, own, catalog);
    return c.resource_sets.map((set): DetailCard => {
      const lines = detail.policy.filter((entry) => entry.resource_set_id === set.id);
      return {
        connection,
        card: {
          key: set.id,
          id: set.id,
          connectionId: c.id,
          resourceIds: set.resources.map((r) => r.id),
          future: set.future,
          env: set.env,
          trustLevels: knownTrustLevels(connection, set.trust_levels),
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
