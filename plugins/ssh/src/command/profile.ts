/**
 * Command-line analysis of the `ssh` service : decide read vs write for each
 * simple command of a shell line and detect the classes the catalog prices
 * apart (credential-file read, destructive, package, service, privilege).
 *
 * Spec     : docs/spec/gateway-risk-model.md §7 (classification is the
 *            plugin's responsibility ; a classification error is a security hole).
 * Handbook : docs/handbook/services/ssh.md.
 *
 * Pure : no IO, no `Date`. **Fail closed** :
 *   - the read allow-list (`policy.ts`) is the only way to be a read, and it
 *     matches a whole argument vector, never a prefix ;
 *   - a line the lexer (`shell-lex.ts`) cannot see through — substitution,
 *     `$'…'`, here-document, control character, broken quote — is **opaque** ;
 *   - so is a command whose word is not a literal name (`$X`, a glob, a
 *     brace), a command that runs code or another command the classifier does
 *     not parse (`bash -c`, `eval`, `python -c`, `awk`, `find -exec`, `ssh`,
 *     `docker exec`, `su`, `watch`…), a wrapper with an unknown option, and a
 *     tool that leaves the host (`systemctl -H`, `docker -H`) ;
 *   - an opaque line is never a read and carries **every** class : the
 *     credential-file marker and the four write markers. A mission that wants
 *     it holds all the risks ; a read-only or developer mission is refused ;
 *   - what is visible is normalised before the detectors run : quotes and
 *     backslashes removed, the path of the command word dropped (`/bin/rm`),
 *     grouping and keywords stripped (`(…)`, `{ …; }`, `then`, `do`), wrappers
 *     unwrapped (`env`, `command`, `exec`, `nohup`, `nice`, `time`, `timeout`,
 *     `stdbuf`, `setsid`, `xargs`, `sudo` / `doas` / `pkexec` with options).
 *
 * The concerns live next to this module : credential-bearing paths
 * (`secret-paths.ts`), normalisation and wrappers (`wrappers.ts`), commands
 * that cannot be seen through (`opaque.ts`), the class detectors
 * (`classes.ts`). This module puts them together, one simple command at a
 * time.
 *
 * What this does not do : follow a script file. `./deploy.sh`, `bash x.sh`,
 * `make`, `npm run build` are plain writes — "run a program on the host" is
 * what `exec-write` means, and the program may do anything its user can. The
 * class markers price the commands **written on the line** ; the host-side
 * boundary (login user, sudoers) is the last word.
 */

import { readMatchOf } from '../policy.ts';
import { hasBrace, lexCommandLine, type SimpleCommand } from '../shell-lex.ts';

import {
  destructiveArgv,
  NO_CLASS,
  packageArgv,
  serviceArgv,
  SERVICE_VERBS,
  worstCase,
  type Classes,
} from './classes.ts';
import { opaqueReason } from './opaque.ts';
import { commandReferencesSecret } from './secret-paths.ts';
import { resolveCommand, stripReserved } from './wrappers.ts';

/** The classes a line may carry on top of read / write. */
export interface CommandProfile {
  /** At least one simple command is a whitelisted read (never on an opaque line). */
  readonly read: boolean;
  /** At least one simple command is not a whitelisted read, or the line is opaque. */
  readonly write: boolean;
  /** A credential-bearing path is referenced, or a path cannot be seen. */
  readonly secretFile: boolean;
  /** Recursive / forced delete, disk tool, reboot, account deletion, firewall flush, Docker prune. */
  readonly destructive: boolean;
  /** Package manager in a mutating mode, global npm / pnpm / yarn / pipx install. */
  readonly packageInstall: boolean;
  /** Service or process lifecycle verb. */
  readonly serviceControl: boolean;
  /** `sudo` / `su` / `doas` / `pkexec` on a non-whitelisted command. */
  readonly privilege: boolean;
  /** Why the line cannot be seen through ; empty when it can. A non-empty list sets every class above but `read`. */
  readonly opaque: readonly string[];
}

/** Longest command line the plugin classifies ; longer lines are refused. */
export const MAX_CMD_LENGTH = 16 * 1024;

interface WriteProfile extends Classes {
  readonly privilege: boolean;
  /** The command reads paths the line does not show (`xargs cat`). */
  readonly unseenPaths: boolean;
  readonly opaque: string | null;
}

/** The classes of one simple command that is not a whitelisted read. */
function profileWrite(command: SimpleCommand): WriteProfile {
  const resolved = resolveCommand(command.words);
  const base = {
    ...NO_CLASS,
    privilege: resolved.privileged,
    unseenPaths: resolved.fedArguments,
  };
  if (resolved.opaque !== null) return { ...base, opaque: resolved.opaque };
  const reason = opaqueReason(resolved.name, resolved.args);
  if (reason !== null) return { ...base, opaque: reason };

  const argv = resolved.args.map((w) => w.value);
  // `/etc/init.d/nginx restart` : the script is the service.
  const initScript =
    /(?:^|\/)init\.d\/[^/]+$/.test(resolved.path) && argv.some((a) => SERVICE_VERBS.has(a));
  let classes: Classes = {
    destructive: destructiveArgv(resolved.name, argv),
    packageInstall: packageArgv(resolved.name, argv),
    serviceControl: initScript || serviceArgv(resolved.name, argv),
  };
  const unseenArguments =
    resolved.fedArguments || resolved.args.some((w) => w.expansion || hasBrace(w));
  if (unseenArguments) {
    const worst = worstCase(resolved.name);
    if (worst === 'opaque') return { ...base, opaque: 'unseen-arguments' };
    if (worst !== null) {
      classes = {
        destructive: classes.destructive || worst.destructive,
        packageInstall: classes.packageInstall || worst.packageInstall,
        serviceControl: classes.serviceControl || worst.serviceControl,
      };
    }
  }
  return { ...base, ...classes, opaque: null };
}

/** `fi`, `done`, `}`, `then` on their own : shell syntax, nothing runs. */
function isKeywordOnly(command: SimpleCommand): boolean {
  return (
    command.words.length > 0 &&
    command.redirects.length === 0 &&
    stripReserved(command.words).length === 0
  );
}

/**
 * Profile a whole command line. Returns `null` when the line holds no
 * command at all (operators, blanks, keywords or a comment only) ; the caller
 * refuses it.
 */
export function profileCommandLine(line: string): CommandProfile | null {
  const lexed = lexCommandLine(line);
  const commands = lexed.commands.filter((c) => !isKeywordOnly(c));
  if (commands.length === 0) return null;

  const opaque = new Set(lexed.opaque);
  let read = false;
  let write = false;
  let secretFile = false;
  let destructive = false;
  let packageInstall = false;
  let serviceControl = false;
  let privilege = false;

  for (const command of commands) {
    if (commandReferencesSecret(command)) secretFile = true;
    const asRead = readMatchOf({
      words: stripReserved(command.words),
      redirects: command.redirects,
    });
    if (asRead !== null) {
      read = true;
      secretFile = secretFile || asRead.secret;
      continue;
    }
    const classes = profileWrite(command);
    write = true;
    secretFile = secretFile || classes.unseenPaths;
    destructive = destructive || classes.destructive;
    packageInstall = packageInstall || classes.packageInstall;
    serviceControl = serviceControl || classes.serviceControl;
    privilege = privilege || classes.privilege;
    if (classes.opaque !== null) opaque.add(classes.opaque);
  }

  // What cannot be seen through is never a read and carries every class.
  if (opaque.size > 0) {
    return {
      read: false,
      write: true,
      secretFile: true,
      destructive: true,
      packageInstall: true,
      serviceControl: true,
      privilege: true,
      opaque: [...opaque],
    };
  }
  return {
    read,
    write,
    secretFile,
    destructive,
    packageInstall,
    serviceControl,
    privilege,
    opaque: [],
  };
}
