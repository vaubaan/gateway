/**
 * @deprecated legacy v4, deleted in P1.6.
 *
 * `classifySshV4(tool, args, bindings)` — the v4 entry point the gateway
 * pipeline still calls with `ProviderBinding[]` and a `host_slug` argument.
 * The v4 shape is kept verbatim (one `R` slice per whitelisted read, the same
 * slice twice on a credential-file read, one `W` slice otherwise) so the v4
 * suite and the v4 pipeline keep their contract until P1.6. The v5 classifier
 * is `classifySsh` in `classify.ts` ; the only shared code is the read
 * whitelist and the credential-file heuristic.
 */

import type { ProviderBinding, Slice } from '@vaubaan/shared';

import { looksLikeSecretFileRead } from './command-classes.ts';
import { isReadAllowed } from './policy.ts';

/** @deprecated legacy v4, deleted in P1.6 — use `ClassifyOutcome` from the SDK. */
export type ClassifyV4Result = { slices: Slice[] } | { denied: string };

export { looksLikeSecretFileRead };

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Build the v4 SSH slice : `ssh.host[<slug>].command.<R|W>`. */
function commandSlice(hostSlug: string, action: 'R' | 'W'): Slice {
  return {
    provider: 'ssh',
    path: [
      { kind: 'name', value: 'host' },
      { kind: 'ident', value: hostSlug },
      { kind: 'name', value: 'command' },
    ],
    action,
  };
}

/** @deprecated legacy v4, deleted in P1.6 — use `sshPlugin.classify(tool, args, resources)`. */
export function classifySshV4(
  tool: string,
  args: Record<string, unknown>,
  _bindings: ReadonlyArray<ProviderBinding>,
): ClassifyV4Result {
  if (tool !== 'ssh__exec') {
    return { denied: `unknown ssh tool '${tool}'.` };
  }
  const host = strArg(args, 'host_slug');
  const cmd = strArg(args, 'cmd');
  if (!host) return { denied: "ssh__exec requires a string 'host_slug'." };
  if (!cmd) return { denied: "ssh__exec requires a string 'cmd'." };

  if (isReadAllowed(cmd)) {
    const baseR = commandSlice(host, 'R');
    if (looksLikeSecretFileRead(cmd)) {
      return { slices: [baseR, commandSlice(host, 'R')] };
    }
    return { slices: [baseR] };
  }

  return { slices: [commandSlice(host, 'W')] };
}
