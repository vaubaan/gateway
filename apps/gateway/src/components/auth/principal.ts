/**
 * What the interface shows a principal, derived from who they are.
 */
import type { Principal } from '@/server/auth';

/**
 * Does this principal act as an operator: the bootstrap token (it configures the
 * instance), or a user the admin rule matches (spec §0 "Operator"). The interface's
 * one statement of it — the Administration link, the Audit page's sentence. The
 * server decides on its own (`Authenticator`, the audit scope); this only chooses
 * what is displayed.
 */
export function isOperatorPrincipal(principal: Principal): boolean {
  return principal.kind === 'bootstrap' || principal.isOperator;
}
