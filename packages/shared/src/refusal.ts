/**
 * Structured refusal codes — the closed set the execution surface returns.
 *
 * Spec : docs/spec/vaubaan-gateway.md §4.1 (structured refusals), §6
 *        (`wrong-credential-kind` : a token presented on the wrong door).
 *
 * The builders that attach the per-code fields and the agent-readable
 * `hint` live in `@vaubaan/gateway-core` ; this module only pins the codes
 * so the audit, the UI and the tests share one enumeration.
 */

export const REFUSAL_CODES = [
  /** Risks touched by the call that the mission did not accept. */
  'risk-not-accepted',
  /** Quota of an accepted risk at zero for the current period ; carries a claim URL. */
  'budget-exhausted',
  /** Risk gated `approval` ; carries an approval-request URL. */
  'approval-required',
  /** The arguments cite a resource outside the mission's selection. */
  'resource-not-in-mission',
  /** Sliding-window rate limit of a risk exceeded. */
  'rate-limited',
  /** The account is `expired`: its owner reconnects it. */
  'account-unavailable',
  /**
   * The account no longer serves this mission: it was revoked (for good), or the
   * creator's access to it was withdrawn. The mission still serves its other accounts.
   */
  'account-revoked',
  /** The mission is `expired`, `orphaned` or `revoked`. */
  'mission-inactive',
  /** A mission token on the management surface, or a delegated token on the execution surface. */
  'wrong-credential-kind',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export function isRefusalCode(raw: string): raw is RefusalCode {
  return (REFUSAL_CODES as readonly string[]).includes(raw);
}
