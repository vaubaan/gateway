/**
 * SSH classifier — maps a concrete (tool, args) call to the capability it
 * requires, in SSH-native semantics.
 *
 * Spec : docs/spec/gateway-capability-model.draft.md §3, §6.
 *
 * SSH exposes the `host` plane with a single level `shell`. The `cmd` is a
 * shell string ; we use `isReadAllowed(cmd)` (regex whitelist) to decide
 * read vs write. `env` = the host slug — each registered ssh_binding is an
 * env. So `ssh:host/shell:read@vps-rp` lets the token run whitelisted
 * commands on `vps-rp` ; `ssh:host/shell:write@vps-rp` lets the token run
 * anything (including destructive commands) on that host.
 */

import type { Capability, ProviderBinding } from '@vaubaan/shared';
import { isReadAllowed } from './policy.ts';

export type ClassifyResult = { capability: Capability } | { denied: string };

function cap(action: 'read' | 'write', env: string): Capability {
  return { provider: 'ssh', plane: 'host', level: 'shell', action, env };
}

/** Env-less capability surface of a tool — used by the static tools/list filter. */
export function sshToolCapabilities(tool: string): readonly Capability[] {
  if (tool === 'ssh__exec') {
    return [
      { provider: 'ssh', plane: 'host', level: 'shell', action: 'read' },
      { provider: 'ssh', plane: 'host', level: 'shell', action: 'write' },
    ];
  }
  return [];
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function classifySsh(
  tool: string,
  args: Record<string, unknown>,
  _bindings: ReadonlyArray<ProviderBinding>,
): ClassifyResult {
  if (tool !== 'ssh__exec') {
    return { denied: `unknown ssh tool '${tool}'.` };
  }
  const host = strArg(args, 'host_slug');
  const cmd = strArg(args, 'cmd');
  if (!host) return { denied: "ssh__exec requires a string 'host_slug'." };
  if (!cmd) return { denied: "ssh__exec requires a string 'cmd'." };
  // Note : the binding check happens at executeCall time when the host is
  // resolved against ssh_bindings (per-project credential lookup, not part
  // of provider_bindings). The classifier only cares about (action, env).
  return { capability: cap(isReadAllowed(cmd) ? 'read' : 'write', host) };
}
