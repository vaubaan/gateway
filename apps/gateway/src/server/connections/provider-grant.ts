/**
 * What a person is told about the grant at the provider when a connection is
 * revoked (spec §2.3 "Connection"): one wording for the confirmation dialog,
 * the notice that follows the act and the revoked connection's page.
 *
 * Pure: no IO. The facts come from the plugin (`canWithdraw`,
 * `manualRevocation`) and from the stored outcome (`ProviderGrantOutcome`).
 */
import type { ProviderGrantOutcome } from '../store/types';

/** When the plugin gives no sentence of its own. */
export const DEFAULT_BY_HAND = "Remove the access in the service's own settings.";

/** Said before the act: what revoking will do at the provider. */
export function providerGrantForecast(
  providerLabel: string,
  grant: { readonly withdrawnByGateway: boolean; readonly byHand: string | null },
): string {
  return grant.withdrawnByGateway
    ? `The gateway will also ask ${providerLabel} to withdraw the access it was granted, and will tell you whether ${providerLabel} confirmed.`
    : `The gateway cannot withdraw the access at ${providerLabel}: you remove it there yourself. ${grant.byHand ?? DEFAULT_BY_HAND}`;
}

export interface ProviderGrantReport {
  /** Whether something is left for the person to do at the provider. */
  readonly actionNeeded: boolean;
  readonly title: string;
  readonly text: string;
}

/**
 * Said after the act. `outcome` is `null` for a connection revoked before the
 * gateway asked providers anything: nothing is known, so it reads as "by hand".
 */
export function providerGrantReport(
  providerLabel: string,
  outcome: ProviderGrantOutcome | null,
  byHand: string | null,
): ProviderGrantReport {
  const how = byHand ?? DEFAULT_BY_HAND;
  switch (outcome) {
    case 'revoked':
      return {
        actionNeeded: false,
        title: `Access withdrawn at ${providerLabel}`,
        text: `${providerLabel} confirmed that the access granted to this account is withdrawn. Nothing is left to remove there.`,
      };
    case 'failed':
      return {
        actionNeeded: true,
        title: `Access NOT withdrawn at ${providerLabel}`,
        text: `The gateway asked ${providerLabel} to withdraw the access and ${providerLabel} did not confirm: it may still stand there. Remove it by hand. ${how}`,
      };
    case 'manual':
    case null:
      return {
        actionNeeded: true,
        title: `Remove the access at ${providerLabel} by hand`,
        text: `The gateway did not withdraw the access at ${providerLabel}: it still stands there until you remove it. ${how}`,
      };
  }
}
