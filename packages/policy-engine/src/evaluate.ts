/**
 * Decision flow.
 *
 * Spec : docs/spec/mcp-proxy.md §6.2.
 *
 * Semantics :
 *   - default deny.
 *   - deny override allow.
 *   - between two deny: priority (default 100), higher wins.
 *   - between two allow: first matching wins (rules array order is stable).
 *   - target resolved via project's provider_bindings.
 *   - tool match via exact `tool` or glob `tool_matches`.
 *   - constraints evaluated via dot-paths into `{arguments: ...}` root.
 */

import { minimatch } from 'minimatch';
import type { Provider, ProviderBinding, Role, Rule } from '@vaubaan/shared';
import { evaluateConstraint, readPath } from './operators.ts';
import { callTargetMatches, resolveTarget } from './target.ts';

export interface PolicyCall {
  provider: Provider;
  tool: string;
  arguments: Record<string, unknown>;
}

export type PolicyDecision =
  | { decision: 'allowed'; roleMatched: string; rule: Rule }
  | { decision: 'denied'; reason: string; ruleSource?: string };

function toolMatchesRule(rule: Rule, toolName: string): boolean {
  if (rule.tool !== undefined && rule.tool === toolName) return true;
  if (rule.tool_matches) {
    return rule.tool_matches.some((p) => minimatch(toolName, p));
  }
  return false;
}

function targetMatchesRule(
  rule: Rule,
  provider: Provider,
  args: Record<string, unknown>,
  bindings: ProviderBinding[],
): boolean {
  const target = rule.target ?? '*';
  if (target === '*') return true;
  const resolved = resolveTarget(target, bindings);
  return callTargetMatches(provider, args, resolved);
}

function constraintsMatch(rule: Rule, args: Record<string, unknown>): boolean {
  if (!rule.constraints) return true;
  for (const [path, constraint] of Object.entries(rule.constraints)) {
    const value = readPath({ arguments: args }, path);
    if (!evaluateConstraint(constraint, value)) return false;
  }
  return true;
}

function buildDenialReason(call: PolicyCall, rule: Rule, roleName: string): string {
  // Find the first failed constraint so we can phrase a specific, actionable
  // message. Fall back to a generic message if none stands out.
  if (rule.constraints) {
    for (const [path, constraint] of Object.entries(rule.constraints)) {
      const value = readPath({ arguments: call.arguments }, path);
      if (!evaluateConstraint(constraint, value)) {
        const expectation = describeConstraint(constraint);
        const got = value === undefined ? '<missing>' : String(value);
        return `argument '${path.replace(/^arguments\./, '')}' = '${got}' is not allowed by role '${roleName}' (${expectation}).`;
      }
    }
  }
  return `tool '${call.tool}' is not allowed by role '${roleName}'.`;
}

function describeConstraint(c: { [k: string]: unknown }): string {
  if ('equals' in c) return `expected ${JSON.stringify(c.equals)}`;
  if ('in' in c) return `expected one of ${JSON.stringify(c.in)}`;
  if ('not_in' in c) return `expected not in ${JSON.stringify(c.not_in)}`;
  if ('match' in c) return `expected to match ${JSON.stringify(c.match)}`;
  if ('regex' in c) return `expected to match regex ${JSON.stringify(c.regex)}`;
  if ('starts_with' in c) return `expected to start with ${JSON.stringify(c.starts_with)}`;
  if ('not_starts_with' in c)
    return `expected not to start with ${JSON.stringify(c.not_starts_with)}`;
  return 'constraint failed';
}

/**
 * Evaluate a `(roles, call)` pair against the policy DSL.
 *
 * Roles are filtered to those whose `provider` matches `call.provider` before
 * evaluating their rules.
 */
export function evaluatePolicy(
  roles: Role[],
  bindings: ProviderBinding[],
  call: PolicyCall,
): PolicyDecision {
  const matchingRoles = roles.filter((r) => r.provider === call.provider);

  if (matchingRoles.length === 0) {
    return {
      decision: 'denied',
      reason: `no role attached to this bot covers provider '${call.provider}'.`,
    };
  }

  let bestAllow: { role: Role; rule: Rule } | null = null;
  let bestDeny: { role: Role; rule: Rule; priority: number; reason: string } | null = null;
  const failures: Array<{ role: Role; rule: Rule; reason: string }> = [];

  for (const role of matchingRoles) {
    for (const rule of role.permissions.rules) {
      if (!toolMatchesRule(rule, call.tool)) continue;
      const targetOk = targetMatchesRule(rule, call.provider, call.arguments, bindings);
      if (!targetOk) {
        failures.push({
          role,
          rule,
          reason: `role '${role.name}' rule targeting '${rule.target ?? '*'}' did not match call resource.`,
        });
        continue;
      }
      const consOk = constraintsMatch(rule, call.arguments);
      if (!consOk) {
        failures.push({ role, rule, reason: buildDenialReason(call, rule, role.name) });
        if (rule.effect === 'allow') continue;
      }
      if (rule.effect === 'deny') {
        const priority = rule.priority ?? 100;
        if (!bestDeny || priority > bestDeny.priority) {
          bestDeny = {
            role,
            rule,
            priority,
            reason: consOk
              ? `role '${role.name}' explicitly denies tool '${call.tool}'.`
              : buildDenialReason(call, rule, role.name),
          };
        }
        continue;
      }
      if (rule.effect === 'allow' && consOk) {
        if (!bestAllow) bestAllow = { role, rule };
      }
    }
  }

  if (bestDeny) {
    return {
      decision: 'denied',
      reason: bestDeny.reason + suggestionFor(call, bestDeny.rule),
      ruleSource: bestDeny.role.name,
    };
  }
  if (bestAllow) {
    return { decision: 'allowed', roleMatched: bestAllow.role.name, rule: bestAllow.rule };
  }

  if (failures.length > 0) {
    const first = failures[0]!;
    return {
      decision: 'denied',
      reason: first.reason + suggestionFor(call, first.rule),
    };
  }
  return {
    decision: 'denied',
    reason: `tool '${call.tool}' is not allowed by any role attached to this bot.`,
  };
}

/**
 * Build a `suggestion` hint appended to denial messages — makes the proxy
 * a trainer, not just a wall (cf. spec §6.3).
 */
function suggestionFor(call: PolicyCall, rule: Rule): string {
  if (!rule.constraints) return '';
  for (const [path, constraint] of Object.entries(rule.constraints)) {
    if (
      typeof constraint === 'object' &&
      constraint !== null &&
      'match' in constraint &&
      Array.isArray(constraint.match)
    ) {
      const patterns = constraint.match;
      const arg = path.replace(/^arguments\./, '');
      if (arg === 'branch' || arg === 'head') {
        const first = patterns[0]?.replace('*', '<name>') ?? 'feature/<name>';
        return ` Suggestion: rename the branch to match one of ${patterns.join(', ')} (e.g. '${first}').`;
      }
    }
  }
  return '';
}
