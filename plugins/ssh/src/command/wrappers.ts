/**
 * Normalising a simple command for the `ssh` command profiler : keywords,
 * assignments, wrappers.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7.
 * Handbook : docs/handbook/providers/ssh.md.
 *
 * Pure. Before the detectors run, the command that finally runs is found :
 * grouping and keywords stripped (`{ …; }`, `then`, `do`), assignments
 * dropped, the path of the command word dropped (`/bin/rm`), and wrappers
 * unwrapped (`env`, `command`, `exec`, `nohup`, `nice`, `time`, `timeout`,
 * `stdbuf`, `setsid`, `xargs`, `sudo` / `doas` / `pkexec` with options).
 * A wrapper with an option it does not list, a command word that is not a
 * literal name, or a chain of wrappers too deep leaves the command
 * unresolved — opaque, never guessed at.
 */

import { ASSIGNMENT, parseOptions, type OptionSpec } from '../policy.ts';
import { isDynamic, lexCommandLine, type Word } from '../shell-lex.ts';

/** Shell keywords and grouping tokens that precede — or stand for — a command. */
const RESERVED_PREFIX = new Set([
  '!',
  '{',
  '}',
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'do',
  'done',
  'esac',
]);

/** Strip the keywords in front of a command ; a quoted one (`'then' ls`) is a command name, not a keyword. */
export function stripReserved(words: readonly Word[]): readonly Word[] {
  return dropLeading(words, (w) => RESERVED_PREFIX.has(w.value) && w.bare.every(Boolean));
}

/**
 * The same, assignments included and quoting ignored : over-stripping can
 * only make the classes of the words that follow count, never hide them.
 */
function stripReservedAndAssignments(words: readonly Word[]): readonly Word[] {
  return dropLeading(words, (w) => RESERVED_PREFIX.has(w.value) || ASSIGNMENT.test(w.value));
}

/** The words after the leading run that `strip` matches. */
function dropLeading(words: readonly Word[], strip: (word: Word) => boolean): readonly Word[] {
  const first = words.findIndex((w) => !strip(w));
  return first === -1 ? [] : words.slice(first);
}

interface Wrapper {
  readonly options: OptionSpec;
  /** The wrapper runs the command as another user. */
  readonly privileged?: true;
  /** The wrapper appends arguments the line does not show (`xargs`). */
  readonly feedsArguments?: true;
  /** Operands the wrapper keeps for itself before the command (`timeout <duration>`). */
  readonly ownOperands?: number;
  /** A lone `-` is an option (`env -`). */
  readonly dashIsOption?: true;
}

/**
 * Commands that run the command they are given. Each lists **every** option
 * it may carry ; an unknown one makes the line opaque rather than guessed at.
 * Options that hand the command to a shell (`sudo -i`, `sudo -s`, `env -S`)
 * or to another host (`sudo -h`) are deliberately absent.
 */
const WRAPPERS: ReadonlyMap<string, Wrapper> = new Map<string, Wrapper>([
  [
    'sudo',
    {
      privileged: true,
      options: {
        flags: 'ABEHKNPSbknv',
        valued: 'CDRTUgprtu',
        longFlags: [
          'askpass',
          'background',
          'bell',
          'non-interactive',
          'no-update',
          'preserve-env',
          'preserve-groups',
          'remove-timestamp',
          'reset-timestamp',
          'set-home',
          'stdin',
          'validate',
        ],
        longValued: [
          'chdir',
          'chroot',
          'close-from',
          'command-timeout',
          'group',
          'other-user',
          'preserve-env',
          'prompt',
          'role',
          'type',
          'user',
        ],
      },
    },
  ],
  ['doas', { privileged: true, options: { flags: 'Ln', valued: 'Cu' } }],
  [
    'pkexec',
    {
      privileged: true,
      options: { longFlags: ['disable-internal-agent', 'keep-cwd'], longValued: ['user'] },
    },
  ],
  [
    'env',
    {
      dashIsOption: true,
      options: {
        flags: '0iv',
        valued: 'Cu',
        longFlags: ['debug', 'ignore-environment', 'null'],
        longValued: ['chdir', 'unset'],
      },
    },
  ],
  ['command', { options: { flags: 'Vpv' } }],
  ['builtin', { options: {} }],
  ['exec', { options: { flags: 'cl', valued: 'a' } }],
  ['nohup', { options: {} }],
  ['setsid', { options: { flags: 'cfw', longFlags: ['ctty', 'fork', 'wait'] } }],
  ['nice', { options: { valued: 'n', longValued: ['adjustment'], numeric: true } }],
  [
    'ionice',
    {
      options: {
        flags: 't',
        valued: 'cn',
        longFlags: ['ignore'],
        longValued: ['class', 'classdata'],
      },
    },
  ],
  ['time', { options: { flags: 'p' } }],
  [
    'timeout',
    {
      ownOperands: 1,
      options: {
        flags: 'v',
        valued: 'ks',
        longFlags: ['foreground', 'preserve-status', 'verbose'],
        longValued: ['kill-after', 'signal'],
      },
    },
  ],
  ['stdbuf', { options: { valued: 'eio', longValued: ['error', 'input', 'output'] } }],
  [
    'xargs',
    {
      feedsArguments: true,
      options: {
        flags: '0prtx',
        valued: 'EILPadns',
        longFlags: ['exit', 'interactive', 'no-run-if-empty', 'null', 'open-tty', 'verbose'],
        longValued: [
          'arg-file',
          'delimiter',
          'eof',
          'max-args',
          'max-chars',
          'max-lines',
          'max-procs',
          'replace',
        ],
      },
    },
  ],
]);

/** Deepest chain of wrappers followed (`sudo env nice timeout 5 …`) ; deeper is opaque. */
const MAX_WRAPPER_DEPTH = 12;

/** A command word the classifier accepts as a literal name or path. */
const LITERAL_COMMAND_WORD = /^[\w.+~/-]+$/;

/**
 * The name the shell looks up for this word : quotes are already removed,
 * the directory is dropped (`/bin/rm`, `./rm` → `rm`), case is folded.
 * `null` when the word is not a literal (`$X`, `r?`, `{rm,-rf}`), holds a
 * character no command name has, or starts with `-`.
 */
function commandName(word: Word): string | null {
  if (word.value === '[' || word.value === ':') return word.value;
  if (isDynamic(word)) return null;
  if (!LITERAL_COMMAND_WORD.test(word.value) || word.value.startsWith('-')) return null;
  const base = word.value.slice(word.value.lastIndexOf('/') + 1);
  return base === '' ? null : base.toLowerCase();
}

export interface ResolvedCommand {
  /** The command that finally runs, `''` when the simple command holds none (`X=1`, `fi`, `> file`). */
  readonly name: string;
  /** The command word as written, directory included (`/etc/init.d/nginx`). */
  readonly path: string;
  readonly args: readonly Word[];
  readonly privileged: boolean;
  readonly fedArguments: boolean;
  /** Why the command cannot be resolved ; `null` when it can. */
  readonly opaque: string | null;
}

/** Strip keywords and assignments, then unwrap wrappers until the command that runs is found. */
export function resolveCommand(words: readonly Word[]): ResolvedCommand {
  let rest = words;
  let privileged = false;
  let fedArguments = false;
  const unresolved = (opaque: string): ResolvedCommand => ({
    name: '',
    path: '',
    args: [],
    privileged,
    fedArguments,
    opaque,
  });

  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    rest = stripReservedAndAssignments(rest);
    const head = rest[0];
    if (head === undefined) {
      return { name: '', path: '', args: [], privileged, fedArguments, opaque: null };
    }
    const name = commandName(head);
    if (name === null) return unresolved('command-word');
    let args = rest.slice(1);
    const wrapper = WRAPPERS.get(name);
    if (wrapper === undefined) {
      return { name, path: head.value, args, privileged, fedArguments, opaque: null };
    }

    if (wrapper.privileged === true) privileged = true;
    if (wrapper.feedsArguments === true) fedArguments = true;
    if (wrapper.dashIsOption === true) {
      while (args[0]?.value === '-') args = args.slice(1);
    }
    const parsed = parseOptions(
      args.map((w) => w.value),
      wrapper.options,
      'leading',
    );
    if (parsed === null) return unresolved('wrapper-option');
    const optionCount = args.length - parsed.operands.length;
    if (args.slice(0, optionCount).some(isDynamic)) return unresolved('wrapper-option');
    rest = args.slice(optionCount + (wrapper.ownOperands ?? 0));
  }
  return unresolved('wrapper-depth');
}

/** Strip `sudo [options]`, `doas`, `pkexec` ; returns the inner command (quotes removed) and whether a prefix was there. */
export function stripPrivilegePrefix(cmd: string): { inner: string; privileged: boolean } {
  const command = lexCommandLine(cmd).commands[0];
  if (command === undefined) return { inner: cmd, privileged: false };
  let rest = stripReservedAndAssignments(command.words);
  let privileged = false;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH; depth += 1) {
    const head = rest[0];
    const name = head === undefined ? null : commandName(head);
    // `su` runs a shell or `-c <cmd>` : nothing reliable to classify inside.
    if (name === 'su' || name === 'runuser') return { inner: cmd, privileged: true };
    const wrapper = name === null ? undefined : WRAPPERS.get(name);
    if (wrapper?.privileged !== true) break;
    privileged = true;
    const args = rest.slice(1);
    const parsed = parseOptions(
      args.map((w) => w.value),
      wrapper.options,
      'leading',
    );
    if (parsed === null) return { inner: cmd, privileged: true };
    rest = stripReservedAndAssignments(args.slice(args.length - parsed.operands.length));
  }
  return privileged
    ? { inner: rest.map((w) => w.value).join(' '), privileged }
    : { inner: cmd, privileged };
}
