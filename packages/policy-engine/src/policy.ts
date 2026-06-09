/**
 * Capability policy — the client-side decision: who gets to exercise *what*.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §5, §5.1.
 *
 * The plugin layer (classify) decides *which* capability a call requires.
 * The policy layer decides *how* a requested capability gets minted on a
 * token : autonomously, behind a human confirm, or refused outright. It is
 * consulted at **mint time** (decision (a), spec §8), not at the /mcp hot
 * path.
 *
 * Gate vocabulary (3 states) :
 *  - **`allow`**   : mint immediately, no human in the loop.
 *  - **`confirm`** : open an approval flow (Telegram ✅/❌ or UI).
 *  - **`deny`**    : refuse the mint, 403, no override possible.
 *
 * Semantics :
 *  - **Default-deny.** A capability with no matching rule falls back to
 *    `deny`. The rule database is an explicit allow-list — anything not
 *    granted is refused.
 *  - **Most-specific wins.** A rule's specificity = number of fields that
 *    aren't `*`. Ties broken by priority desc.
 *  - **Anti-pattern (enforced in SQL).** A blanket allow on writes
 *    (`action='write' ∧ env_pattern='*' ∧ gate='allow'`) is forbidden — it
 *    would silently authorize prod (spec §5.1 #2). The DB CHECK rejects.
 *  - **Env-less capabilities.** An env-less cap only matches `env_pattern='*'`
 *    rules (no specific env to match). The env-less *fan-out* write case
 *    (Vercel all-environments, spec §5.1 #3) is therefore covered by the
 *    seed `write @ * → confirm` — i.e. always pops up for human approval.
 */

import type { Capability } from '@vaubaan/shared';

export type PolicyGate = 'allow' | 'confirm' | 'deny';

export const POLICY_GATES = ['allow', 'confirm', 'deny'] as const satisfies readonly PolicyGate[];

export interface PolicyRule {
  id: string;
  project_id: string;
  provider: string; // exact slug or '*'
  plane: string;
  level: string;
  action: 'read' | 'write' | '*';
  env_pattern: string; // exact slug or '*'
  gate: PolicyGate;
  priority: number;
}

export interface PolicyDecisionPerCap {
  capability: Capability;
  /** The effective gate for this capability. */
  gate: PolicyGate;
  /** The rule that produced this decision, or null when no rule matched
   *  (default-deny → gate='deny'). */
  matchedRule: PolicyRule | null;
}

/** Evaluate a set of requested capabilities against the project's policy. */
export function evaluatePolicy(
  caps: readonly Capability[],
  rules: readonly PolicyRule[],
): PolicyDecisionPerCap[] {
  return caps.map((cap) => {
    const matching = rules.filter((r) => matchesRule(r, cap));
    if (matching.length === 0) {
      return { capability: cap, gate: 'deny', matchedRule: null };
    }
    matching.sort((a, b) => specificity(b) - specificity(a) || b.priority - a.priority);
    const winner = matching[0]!;
    return { capability: cap, gate: winner.gate, matchedRule: winner };
  });
}

/** Convenience : every requested capability resolved to `allow`. */
export function allCapsAllowed(decisions: readonly PolicyDecisionPerCap[]): boolean {
  return decisions.every((d) => d.gate === 'allow');
}

/** Subset of decisions that need a human confirm to mint. */
export function confirmDecisions(
  decisions: readonly PolicyDecisionPerCap[],
): PolicyDecisionPerCap[] {
  return decisions.filter((d) => d.gate === 'confirm');
}

/** Subset of decisions refused by policy (deny). Triggers a 403 at mint. */
export function denyDecisions(decisions: readonly PolicyDecisionPerCap[]): PolicyDecisionPerCap[] {
  return decisions.filter((d) => d.gate === 'deny');
}

function matchesRule(r: PolicyRule, c: Capability): boolean {
  return (
    (r.provider === '*' || r.provider === c.provider) &&
    (r.plane === '*' || r.plane === c.plane) &&
    (r.level === '*' || r.level === c.level) &&
    (r.action === '*' || r.action === c.action) &&
    envMatches(r.env_pattern, c.env)
  );
}

function envMatches(pattern: string, env: string | undefined): boolean {
  if (pattern === '*') return true;
  // An env-less cap (env === undefined) only matches `*` rules.
  return env !== undefined && pattern === env;
}

function specificity(r: PolicyRule): number {
  return (
    (r.provider === '*' ? 0 : 1) +
    (r.plane === '*' ? 0 : 1) +
    (r.level === '*' ? 0 : 1) +
    (r.action === '*' ? 0 : 1) +
    (r.env_pattern === '*' ? 0 : 1)
  );
}
