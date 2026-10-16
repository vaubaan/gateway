/**
 * CatalogIndex — "does this RiskId exist in the loaded catalogs?"
 *
 * The store checks every risk id it is asked to persist in `share_restrictions` and
 * `mission_policy` against this index at write time, so that no unknown id, and
 * therefore no wildcard or sentinel, ever reaches a row (spec §10, structural test
 * "every persisted restriction is an enumerated list"). The catalogs themselves are
 * loaded from the plugin registry by the application; the store depends only on
 * this interface.
 */

import type { RiskId } from '@vaubaan/shared';
import { UnknownRiskIdError } from './errors.ts';

export interface CatalogIndex {
  has(riskId: RiskId): boolean;
}

/** Index over an explicit set of ids — the composition root builds one from the registry. */
export class SetCatalogIndex implements CatalogIndex {
  private readonly ids: ReadonlySet<RiskId>;

  constructor(riskIds: Iterable<RiskId>) {
    this.ids = new Set(riskIds);
  }

  has(riskId: RiskId): boolean {
    return this.ids.has(riskId);
  }
}

/** Throws `UnknownRiskIdError` listing every id the catalog does not know. */
export function assertKnownRiskIds(catalog: CatalogIndex, riskIds: readonly RiskId[]): void {
  const unknown = riskIds.filter((id) => !catalog.has(id));
  if (unknown.length > 0) throw new UnknownRiskIdError(unknown);
}
