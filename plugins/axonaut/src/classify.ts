/**
 * Classifier of the `axonaut` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §3, §7 ; docs/spec/vaubaan-gateway.md
 *        §10 ("a classification error is a security hole").
 * Handbook : docs/handbook/providers/axonaut.md §2, §5.
 *
 * Pure : no IO, no credential, no `Date`. The work is done by `readCall`
 * (`call.ts`), the one reader `execute` sends from too: it resolves the
 * account (an explicit ref must be one of the mission's resources), reads
 * every declared argument by its kind and refuses a malformed one, and
 * returns the slices of the call. Unknown tool, malformed or missing argument,
 * account outside the mission: `denied`.
 *
 * Undeclared arguments are not refused: the executor builds every request
 * field by field from the declared arguments, so an argument the tool does not
 * declare is never read and never sent.
 */

import type { ClassifyOutcome, Resource } from '@vaubaan/plugin-sdk';

import { readCall } from './call.ts';

export function classifyAxonaut(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const call = readCall(tool, args, resources);
  return 'denied' in call ? { denied: call.denied } : { slices: call.slices };
}
