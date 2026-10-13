/**
 * Classifier of the `ssh` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10.
 * Handbook : docs/handbook/providers/ssh.md §2.
 *
 * Pure. The host is a mission resource : named by `host`, or the mission's
 * single SSH host when the argument is absent ; a host the mission does not
 * hold, an ambiguous or malformed one, is `denied`. The command line is
 * profiled by `command-classes.ts` and becomes :
 *
 *   ssh.host[<ref>].command.R                 a whitelisted read is present
 *   ssh.host[<ref>].command.secret-file.R     a credential-bearing path is read
 *   ssh.host[<ref>].command.W                 a non-whitelisted command, a redirection or a substitution
 *   ssh.host[<ref>].command.destructive.W     + one marker per detected class
 *   ssh.host[<ref>].command.package.W
 *   ssh.host[<ref>].command.service.W
 *   ssh.host[<ref>].command.privilege.W
 *
 * The runtime intersects each slice with the catalog ; a `rm -rf` on a prod
 * host touches `ssh[prod].exec-write` and `ssh[prod].exec-destructive`, both
 * of which the mission must have accepted.
 */

import { parseSlice, type ClassifyOutcome, type Resource, type Slice } from '@vaubaan/plugin-sdk';

import { MAX_CMD_LENGTH, profileCommandLine } from './command-classes.ts';
import { SSH_EXEC } from './tools.ts';

export const PROVIDER = 'ssh';

/** Identifier chars a slice segment accepts ; a host ref outside it is refused, never escaped. */
const SAFE_IDENT = /^[a-zA-Z0-9_./~-]+$/;

export interface ExecArgs {
  readonly host: string;
  readonly cmd: string;
  readonly timeoutS: number | undefined;
}

/**
 * Validate the arguments of `ssh__exec` against the mission's resources.
 * Shared by `classify` and `execute`, so what runs is exactly what was
 * classified.
 */
export function resolveExecArgs(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ExecArgs | { denied: string } {
  const host = resolveHost(args, resources);
  if ('denied' in host) return host;
  const cmd = args.cmd;
  if (typeof cmd !== 'string' || cmd.trim().length === 0) {
    return { denied: 'cmd: a non-empty string is required' };
  }
  if (cmd.length > MAX_CMD_LENGTH) {
    return { denied: `cmd: longer than ${MAX_CMD_LENGTH} characters` };
  }
  const timeout = args.timeout_s;
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0)
  ) {
    return { denied: 'timeout_s: must be a positive number of seconds' };
  }
  return { host: host.ref, cmd, timeoutS: typeof timeout === 'number' ? timeout : undefined };
}

export function classifySsh(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  if (tool !== SSH_EXEC) return { denied: `unknown tool '${tool}'` };
  const exec = resolveExecArgs(args, resources);
  if ('denied' in exec) return exec;

  const profile = profileCommandLine(exec.cmd);
  if (profile === null) return { denied: 'cmd: no command found on the line' };

  const slices: Slice[] = [];
  const emit = (suffix: string): void => {
    slices.push(parseSlice(`${PROVIDER}.host[${exec.host}].command${suffix}`));
  };
  if (profile.read) emit('.R');
  if (profile.secretFile) emit('.secret-file.R');
  if (profile.write) emit('.W');
  if (profile.destructive) emit('.destructive.W');
  if (profile.packageInstall) emit('.package.W');
  if (profile.serviceControl) emit('.service.W');
  if (profile.privilege) emit('.privilege.W');
  return { slices };
}

function resolveHost(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): { ref: string } | { denied: string } {
  const own = resources.filter((r) => r.provider === PROVIDER);
  const explicit = args.host;
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !SAFE_IDENT.test(explicit)) {
      return { denied: 'host: malformed ref' };
    }
    if (!own.some((r) => r.ref === explicit)) {
      return { denied: `host '${explicit}' is not a host of this mission` };
    }
    return { ref: explicit };
  }
  if (own.length === 1) return { ref: own[0]!.ref };
  return {
    denied:
      own.length === 0
        ? 'host: argument missing and the mission touches no SSH host'
        : `host: argument missing and the mission touches ${own.length} SSH hosts — name one`,
  };
}
