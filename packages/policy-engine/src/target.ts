/**
 * Resolve abstract targets (`project.repos`, `project.vercel`, `project.supabase`)
 * to concrete `resource_ref` strings from `provider_bindings`.
 *
 * Spec : docs/spec/vaubaan-gateway.md §6.4.
 */

import type { AbstractTarget, ProviderBinding } from '@vaubaan/shared';

export function resolveTarget(target: AbstractTarget, bindings: ProviderBinding[]): string[] {
  if (target === '*') return ['*'];
  const provider = target.slice('project.'.length);
  // Map abstract `project.repos` → provider 'github' resource_refs.
  const providerMap: Record<string, string> = {
    repos: 'github',
    vercel: 'vercel',
    supabase: 'supabase',
    railway: 'railway',
  };
  const want = providerMap[provider];
  if (!want) return [];
  return bindings.filter((b) => b.provider === want).map((b) => b.resource_ref);
}

/**
 * Given a call's arguments and the resolved targets, check whether the call's
 * implicit target is in the allowed list.
 *
 * GitHub : we build `<owner>/<repo>` from `arguments.owner` + `arguments.repo`.
 * Vercel : `arguments.project_id` (or `projectId`).
 * Supabase : `arguments.project_ref`.
 * Railway : `arguments.projectId`.
 * Wildcard `*` always matches.
 */
export function callTargetMatches(
  provider: 'github' | 'vercel' | 'supabase' | 'railway' | 'vps-ssh',
  args: Record<string, unknown>,
  resolvedTargets: string[],
): boolean {
  if (resolvedTargets.includes('*')) return true;
  if (resolvedTargets.length === 0) return false;
  const callRef = extractCallRef(provider, args);
  if (callRef === null) return false;
  return resolvedTargets.includes(callRef);
}

export function extractCallRef(
  provider: 'github' | 'vercel' | 'supabase' | 'railway' | 'vps-ssh',
  args: Record<string, unknown>,
): string | null {
  if (provider === 'github') {
    const owner = args.owner;
    const repo = args.repo;
    if (typeof owner !== 'string' || typeof repo !== 'string') return null;
    return `${owner}/${repo}`;
  }
  if (provider === 'vercel') {
    const projectId = args.project_id ?? args.projectId;
    return typeof projectId === 'string' ? projectId : null;
  }
  if (provider === 'supabase') {
    const ref = args.project_ref ?? args.projectRef;
    return typeof ref === 'string' ? ref : null;
  }
  if (provider === 'railway') {
    const projectId = args.projectId ?? args.project_id;
    return typeof projectId === 'string' ? projectId : null;
  }
  return null;
}
