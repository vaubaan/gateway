/**
 * SSH risk-based classifier (v4) — maps a concrete `(tool, args)` call to
 * the slice(s) it touches on the SSH `host` plane.
 *
 * Spec    : docs/spec/gateway-risk-model.md §7.
 * Source  : .vaubaan/research/providers/railway-ssh.md §2.3 + §2.4.
 *
 * Two responsibilities :
 *
 *   1. Decide R vs W via `isReadAllowed(cmd)` — the legacy regex
 *      whitelist (`policy.ts`) is reused unchanged ; it is the source
 *      of truth for "what counts as a benign read".
 *
 *   2. Detect a small set of "looks-like-reading-a-secret-file" shapes
 *      (`cat /etc/...`, `cat ~/.ssh/...`, `stat /root/...`, ...) and,
 *      when matched, emit an ADDITIONAL slice. The two slices are
 *      *identical* (`ssh.host[<slug>].command.R`) — what changes is the
 *      number of slices returned. The runtime intersects each slice
 *      with the catalog. Since `ssh.exec-read` AND
 *      `ssh.exec-read-secret-files` both match the same pattern, every
 *      read touches both risks ; the multi-slice emission is a
 *      *belt-and-braces* signal for the audit log (each slice gets its
 *      own row), and makes the "co-touch" intent explicit in the
 *      classifier output.
 *
 * IMPORTANT — co-touch by single slice :
 *   In the current matcher (`@vaubaan/policy-engine/risk-evaluator`),
 *   `risksTouchedBy(slice)` walks every catalog entry and returns ALL
 *   matching ids. So one slice `ssh.host[X].command.R` already touches
 *   both risks. The reason we still emit two slices on secret-file
 *   reads is :
 *     (a) audit clarity — `executed_slices` shows the duplication and
 *         the audit reviewer sees "this call was classified as a
 *         secret-file read".
 *     (b) future-proofing — if we ever refine the matcher to skip
 *         overlapping catalog entries, the explicit dual emission keeps
 *         the co-touch semantics intact.
 *
 * The host_slug is the env qualifier. We do NOT inject env into the
 * slice path beyond the `host_slug` identifier ; the `acceptable_in_envs`
 * gate on `exec-write` is checked at mint time by the runtime
 * (which compares `binding.host_slug ∈ acceptable_in_envs`).
 */

import type { ProviderBinding, Slice } from '@vaubaan/shared';
import { isReadAllowed } from './policy.ts';

export type ClassifyV4Result = { slices: Slice[] } | { denied: string };

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Build the canonical SSH slice : `ssh.host[<slug>].command.<R|W>`. */
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

/**
 * Heuristics — does the command look like a read of a potentially
 * sensitive system file ?
 *
 * Intentionally NARROW : we only flag a handful of well-known credential
 * locations. Anything wider would cause false-positives on benign reads
 * (`cat /etc/hostname` or `cat /etc/os-release` are not secrets but
 * would match a `^cat /etc/` rule alone). The risks_touched set already
 * includes `ssh.exec-read` always ; this heuristic adds the *secret*
 * risk only when the path SHAPE points at credentials/keys.
 *
 * Patterns (anchored on the cmd prefix, after `sudo` is stripped) :
 *   - `cat /etc/shadow`, `cat /etc/sudoers`, `cat /etc/passwd`
 *   - `cat /root/...`            (root home — typically `.env`, `.ssh/`)
 *   - `cat ~/.ssh/...`, `cat /home/<u>/.ssh/...`, `cat ~/.aws/...`
 *   - `stat /root/...`, `stat ~/.ssh/...`
 *   - `md5sum /etc/shadow`, `md5sum ~/.ssh/...`
 *
 * The first token (cat/stat/md5sum) must match an entry in the read
 * whitelist (else the cmd is already going to W and the heuristic is
 * moot).
 */
const SECRET_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  // /etc/<sensitive> — shadow, sudoers, passwd, gshadow.
  /^(?:sudo\s+)?(?:cat|stat|md5sum)\s+\/etc\/(?:shadow|sudoers|passwd|gshadow)(?:[\s.])?/,
  // /root — entire tree treated as sensitive (root-owned secrets).
  /^(?:sudo\s+)?(?:cat|stat|md5sum)\s+\/root(?:\/|$)/,
  // ~/.ssh, ~/.aws, ~/.gnupg.
  /^(?:sudo\s+)?(?:cat|stat|md5sum)\s+~\/\.(?:ssh|aws|gnupg|kube|docker)\//,
  // /home/<user>/.ssh/... and similar — explicit absolute path.
  /^(?:sudo\s+)?(?:cat|stat|md5sum)\s+\/home\/[^/\s]+\/\.(?:ssh|aws|gnupg|kube|docker)\//,
];

/** True iff `cmd` shapes like a sensitive-file read. */
export function looksLikeSecretFileRead(cmd: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(cmd));
}

/**
 * Classify an SSH call into the slice(s) it touches.
 *
 * Returns :
 *  - `{ denied }` if the tool is unknown or required args are missing.
 *  - `{ slices: [oneR] }` for a whitelisted benign read.
 *  - `{ slices: [oneR, oneR] }` (same slice twice) for a benign read
 *    that LOOKS LIKE a sensitive-file read — co-touch signal.
 *  - `{ slices: [oneW] }` for any non-whitelist command.
 *
 * The `bindings` parameter is part of the contract for consistency
 * with other providers' classifiers, but SSH does not consult it —
 * the host is resolved via `ssh_bindings` (a project-level table,
 * separate from `provider_bindings`) at execute time.
 */
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
      // Multi-slice emission : the second slice is structurally
      // identical to the first ; its purpose is to make the
      // co-touch explicit in the audit log and to keep the
      // secret-file detection visible at classifier output.
      return { slices: [baseR, commandSlice(host, 'R')] };
    }
    return { slices: [baseR] };
  }

  return { slices: [commandSlice(host, 'W')] };
}
