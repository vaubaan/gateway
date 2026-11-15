/**
 * What a person is told about the grant at the service when an account is
 * revoked (spec §2.3 "Account"): one wording for the confirmation dialog,
 * the notice that follows the act and the revoked account's page.
 *
 * Pure: no IO. The facts come from the plugin (`canWithdraw`,
 * `manualRevocation`) and from the stored outcome (`ServiceGrantOutcome`).
 */
import type { ServiceGrantOutcome } from '../store/types';

/** When the plugin gives no sentence of its own. */
export const DEFAULT_BY_HAND = "Remove the access in the service's own settings.";

/** Said before the act: what revoking will do at the service. */
export function serviceGrantForecast(
  serviceLabel: string,
  grant: { readonly withdrawnByGateway: boolean; readonly byHand: string | null },
): string {
  return grant.withdrawnByGateway
    ? `The gateway will also ask ${serviceLabel} to withdraw the access it was granted, and will tell you whether ${serviceLabel} confirmed.`
    : `The gateway cannot withdraw the access at ${serviceLabel}: you remove it there yourself. ${grant.byHand ?? DEFAULT_BY_HAND}`;
}

export interface ServiceGrantReport {
  /** Whether something is left for the person to do at the service. */
  readonly actionNeeded: boolean;
  readonly title: string;
  readonly text: string;
}

/**
 * Said after the act. `outcome` is `null` for an account revoked before the
 * gateway asked services anything: nothing is known, so it reads as "by hand".
 */
export function serviceGrantReport(
  serviceLabel: string,
  outcome: ServiceGrantOutcome | null,
  byHand: string | null,
): ServiceGrantReport {
  const how = byHand ?? DEFAULT_BY_HAND;
  switch (outcome) {
    case 'revoked':
      return {
        actionNeeded: false,
        title: `Access withdrawn at ${serviceLabel}`,
        text: `${serviceLabel} confirmed that the access granted to this account is withdrawn. Nothing is left to remove there.`,
      };
    case 'failed':
      return {
        actionNeeded: true,
        title: `Access NOT withdrawn at ${serviceLabel}`,
        // What to do is said once, by the plugin's own sentence.
        text: `The gateway asked ${serviceLabel} to withdraw the access and ${serviceLabel} did not confirm: it may still stand there. ${how}`,
      };
    case 'manual':
    case null:
      return {
        actionNeeded: true,
        title: `Still granted at ${serviceLabel}`,
        text: `The gateway did not withdraw the access at ${serviceLabel}. ${how}`,
      };
  }
}
