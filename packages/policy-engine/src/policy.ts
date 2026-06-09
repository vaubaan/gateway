/**
 * Capability policy — the client-side decision: who gets to exercise *what*.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §5, §5.1.
 *
 * The plugin layer (classify) decides *which* capability a call requires.
 * The policy layer decides *who is allowed to be granted* that capability —
 * AI-autonomously or behind a human approval. It is consulted at **mint
 * time** (decision (a), spec §8), not at the /mcp hot path.
 *
 * Semantics:
 *  - **Default-deny.** A capability with no matching `ai` rule falls back to
 *    `human` (the rule database is an allow-list).
 *  - **Most-specific wins.** A rule's specificity = number of fields that
 *    aren't `*`. Ties broken by priority desc.
 *  - **Anti-pattern (enforced in SQL).** A blanket ai-allow on writes
 *    (`action='write' ∧ env_pattern='*' ∧ gate='ai'`) is forbidden — it would
 *    silently authorize prod (spec §5.1 #2). The DB CHECK constraint rejects
 *    such rules.
 *  - **Env-less capabilities.** An env-less cap only matches `env_pattern='*'`
 *    rules (no specific env to match). NB the env-less case can still be a
 *    *fan-out* write (e.g. Vercel's all-environments env var, spec §5.1 #3) :
 *    the policy should gate it as the strictest covered env. Until `@all` is
 *    modeled, env-less writes are effectively human-gated by the default-deny
 *    on `write @ *`.
 */

import type { Capability } from '@vaubaan/shared';

export type PolicyGate = 'ai' | 'human';

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
   *  (default-deny → gate='human'). */
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
      return { capability: cap, gate: 'human', matchedRule: null };
    }
    matching.sort((a, b) => specificity(b) - specificity(a) || b.priority - a.priority);
    const winner = matching[0]!;
    return { capability: cap, gate: winner.gate, matchedRule: winner };
  });
}

/**
 * Convenience : are *all* requested capabilities ai-allowed by the policy ?
 * If true, the mint may proceed without human approval. If false, the caller
 * collects the human-gated decisions to open approval requests (Phase 4).
 */
export function allCapsAiAllowed(decisions: readonly PolicyDecisionPerCap[]): boolean {
  return decisions.every((d) => d.gate === 'ai');
}

/** Subset of decisions that need a human approval to mint. */
export function humanGatedDecisions(
  decisions: readonly PolicyDecisionPerCap[],
): PolicyDecisionPerCap[] {
  return decisions.filter((d) => d.gate === 'human');
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
