/**
 * SSH read-vs-write classification — the read allow-list : "this whole
 * simple command is an inspection". Anything else is a write. Used by the
 * command profiler (`command-classes.ts`) to decide which side (`R` or `W`)
 * each simple command of an `ssh__exec` line falls on.
 *
 * Handbook : docs/handbook/providers/ssh.md, Invariants, "Reading the allow-list".
 *
 * A rule sees the **argument vector** the shell would build (quotes already
 * removed by `shell-lex.ts`) and must accept every argument : a known option,
 * a value of a known option, or an operand of the expected shape. There is no
 * prefix matching — `journalctl --vacuum-time=1s`, `systemctl status -H host`
 * and `pgrep --anything` are not reads because one argument is unknown.
 *
 * A command is eligible only when the shell passes it exactly what the line
 * says : the command word is the bare name (`ls`, not `/bin/ls` or `./ls`),
 * no word holds an expansion, a glob or a brace, no variable assignment
 * precedes it, and it redirects nothing to a file (`2>&1` and `< file` are
 * fine). `sudo` is admitted, without options, on `journalctl`, `systemctl`
 * and `ss` only.
 *
 * The list is intentionally narrow ; growing it adds R-side surface the
 * catalog then has to price. New entries go with a review of the SSH risk
 * catalog.
 */

import { isDynamic, lexCommandLine, type Redirect, type Word } from './shell-lex.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Option parsing
// ─────────────────────────────────────────────────────────────────────────────

export interface OptionSpec {
  /** Short options that take no value (`'lah'`). */
  readonly flags?: string;
  /** Short options that take a value, glued (`-n50`) or as the next argument (`-n 50`). */
  readonly valued?: string;
  /** Long options without a value (`'no-pager'` for `--no-pager`). */
  readonly longFlags?: readonly string[];
  /** Long options with a value, as `--name=value` or `--name value`. */
  readonly longValued?: readonly string[];
  /** Accept `-<digits>` (`head -20`, `journalctl -b -1`). */
  readonly numeric?: boolean;
}

export interface ParsedOptions {
  /** Short letters and long names of the options seen, in order. */
  readonly seen: readonly string[];
  /** The arguments that are not options nor option values. */
  readonly operands: readonly string[];
}

/**
 * Parse `args` against `spec`. Returns `null` as soon as one argument is an
 * option the spec does not know, or a valued option has no value.
 *
 * `leading` : options stop at the first operand, which starts the operands
 * (a wrapper such as `sudo` or `env` : what follows is another command).
 * `interleaved` : options and operands mix (GNU style). `--` ends the options
 * in both modes.
 */
export function parseOptions(
  args: readonly string[],
  spec: OptionSpec,
  mode: 'leading' | 'interleaved',
): ParsedOptions | null {
  const flags = spec.flags ?? '';
  const valued = spec.valued ?? '';
  const longFlags = spec.longFlags ?? [];
  const longValued = spec.longValued ?? [];
  const seen: string[] = [];
  const operands: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--') {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (eq === -1 && longFlags.includes(name)) {
        seen.push(name);
        continue;
      }
      if (!longValued.includes(name)) return null;
      if (eq === -1) {
        if (i + 1 >= args.length) return null;
        i += 1;
      }
      seen.push(name);
      continue;
    }
    if (arg.length > 1 && arg.startsWith('-')) {
      if (spec.numeric === true && /^-\d+$/.test(arg)) continue;
      for (let j = 1; j < arg.length; j += 1) {
        const letter = arg[j]!;
        if (flags.includes(letter)) {
          seen.push(letter);
          continue;
        }
        if (!valued.includes(letter)) return null;
        seen.push(letter);
        // The rest of the cluster is the value ; none left → the next argument is.
        if (j === arg.length - 1) {
          if (i + 1 >= args.length) return null;
          i += 1;
        }
        break;
      }
      continue;
    }
    if (mode === 'leading') {
      operands.push(...args.slice(i));
      break;
    }
    operands.push(arg);
  }
  return { seen, operands };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules
// ─────────────────────────────────────────────────────────────────────────────

/** A read the allow-list accepts. */
export interface ReadMatch {
  /**
   * The command reads content the classifier cannot bound to non-credential
   * files (`docker inspect` prints the container environment, a recursive
   * `grep` walks a tree) : the caller adds the `secret-file` marker.
   */
  readonly secret: boolean;
}

type ReadRule = (args: readonly string[]) => ReadMatch | null;

const PLAIN: ReadMatch = { secret: false };
const SECRET: ReadMatch = { secret: true };

/** A path of the historical allow-list : word characters, `/`, `.`, `-` ; never an option. */
const isPath = (arg: string): boolean => /^[\w/.-]+$/.test(arg) && !arg.startsWith('-');
const isShortCluster = (arg: string): boolean => /^-[A-Za-z0-9]+$/.test(arg);
const isOperand = (arg: string): boolean => arg.length > 0 && !arg.startsWith('-');
const when = (ok: boolean): ReadMatch | null => (ok ? PLAIN : null);

const JOURNALCTL: OptionSpec = {
  flags: 'abefklqrx',
  valued: 'cgnoptuSU',
  longFlags: [
    'all',
    'boot',
    'catalog',
    'dmesg',
    'follow',
    'full',
    'no-full',
    'no-hostname',
    'no-pager',
    'no-tail',
    'pager-end',
    'quiet',
    'reverse',
    'system',
    'user',
    'utc',
    'list-boots',
    'disk-usage',
  ],
  longValued: [
    'boot',
    'case-sensitive',
    'facility',
    'grep',
    'identifier',
    'lines',
    'output',
    'output-fields',
    'priority',
    'since',
    'unit',
    'until',
    'user-unit',
  ],
  numeric: true,
};

const GREP: OptionSpec = {
  flags: 'EFGPHILRTUZabchilnoqrsvwxz',
  valued: 'ABCDdefm',
  longFlags: [
    'basic-regexp',
    'byte-offset',
    'color',
    'colour',
    'count',
    'dereference-recursive',
    'extended-regexp',
    'files-with-matches',
    'files-without-match',
    'fixed-strings',
    'ignore-case',
    'initial-tab',
    'invert-match',
    'line-buffered',
    'line-number',
    'line-regexp',
    'no-filename',
    'no-messages',
    'null',
    'null-data',
    'only-matching',
    'perl-regexp',
    'quiet',
    'recursive',
    'silent',
    'text',
    'with-filename',
    'word-regexp',
  ],
  longValued: [
    'after-context',
    'before-context',
    'binary-files',
    'color',
    'colour',
    'context',
    'devices',
    'directories',
    'exclude',
    'exclude-dir',
    'exclude-from',
    'file',
    'include',
    'label',
    'max-count',
    'regexp',
  ],
  numeric: true,
};
const GREP_RECURSIVE = new Set([
  'r',
  'R',
  'd',
  'recursive',
  'dereference-recursive',
  'directories',
]);
const GREP_PATTERN_OPTIONS = new Set(['e', 'f', 'regexp', 'file']);
/** The one tree a recursive `grep` may walk and stay a plain read. */
const isLogPath = (arg: string): boolean =>
  // nosemgrep: detect-redos -- segments are joined by a literal `/` the segment class excludes: linear
  /^\/var\/log(?:\/[\w.@+-]+)*\/?$/.test(arg) && !arg.split('/').includes('..');

const PGREP: OptionSpec = {
  flags: 'Lacfilnovwx',
  valued: 'GPUdgstu',
  longFlags: [
    'count',
    'exact',
    'full',
    'ignore-case',
    'inverse',
    'lightweight',
    'list-full',
    'list-name',
    'newest',
    'oldest',
  ],
  longValued: ['delimiter', 'euid', 'group', 'parent', 'pgroup', 'session', 'terminal', 'uid'],
};

const DOCKER_PS: OptionSpec = {
  longFlags: ['all', 'latest', 'no-trunc', 'quiet', 'size'],
  longValued: ['filter', 'format', 'last'],
};
const DOCKER_LOGS: OptionSpec = {
  longFlags: ['details', 'follow', 'timestamps'],
  longValued: ['since', 'tail', 'until'],
};

const SYSTEMCTL_READ_VERBS = new Set(['is-active', 'status', 'list-units']);
const SYSTEMCTL: OptionSpec = {
  flags: 'alq',
  valued: 'not',
  longFlags: ['all', 'failed', 'full', 'no-legend', 'no-pager', 'plain', 'quiet', 'system', 'user'],
  longValued: ['lines', 'output', 'state', 'type'],
};

/** `tail` / `head` : option clusters, each optionally followed by a count, then exactly one file. */
function fileWithCounts(args: readonly string[]): ReadMatch | null {
  const operands: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!isShortCluster(arg)) {
      operands.push(arg);
      continue;
    }
    if (/^[+-]?\d+$/.test(args[i + 1] ?? '')) i += 1;
  }
  return when(operands.length === 1 && isPath(operands[0]!));
}

function grep(args: readonly string[]): ReadMatch | null {
  if (args.length === 0) return null;
  const parsed = parseOptions(args, GREP, 'interleaved');
  if (parsed === null) return null;
  const patternGiven = parsed.seen.some((o) => GREP_PATTERN_OPTIONS.has(o));
  const files = patternGiven ? parsed.operands : parsed.operands.slice(1);
  if (!parsed.seen.some((o) => GREP_RECURSIVE.has(o))) return PLAIN;
  // A recursive walk reads whatever the tree holds (`.env`, keys) : only the
  // log tree is a plain read ; no file operand means the current directory.
  return files.length > 0 && files.every(isLogPath) ? PLAIN : SECRET;
}

function systemctl(args: readonly string[]): ReadMatch | null {
  const [verb, ...rest] = args;
  if (verb === undefined || !SYSTEMCTL_READ_VERBS.has(verb)) return null;
  const parsed = parseOptions(rest, SYSTEMCTL, 'interleaved');
  return when(parsed !== null && parsed.operands.every((o) => /^[\w@.:*?-]+$/.test(o)));
}

function docker(args: readonly string[]): ReadMatch | null {
  const [verb, ...rest] = args;
  if (verb === 'ps') {
    const parsed = parseOptions(rest, DOCKER_PS, 'interleaved');
    return when(parsed !== null && parsed.operands.length === 0);
  }
  if (verb === 'logs') {
    const parsed = parseOptions(rest, DOCKER_LOGS, 'interleaved');
    return when(parsed !== null && parsed.operands.length === 1 && isOperand(parsed.operands[0]!));
  }
  // `docker inspect` prints the container configuration, environment included.
  if (verb === 'inspect') return rest.length === 1 && isOperand(rest[0]!) ? SECRET : null;
  return null;
}

const atMostOneCluster: ReadRule = (args) =>
  when(args.length === 0 || (args.length === 1 && isShortCluster(args[0]!)));
const noArgument: ReadRule = (args) => when(args.length === 0);
const oneOperand: ReadRule = (args) => when(args.length === 1 && isOperand(args[0]!));

const READ_RULES: ReadonlyMap<string, ReadRule> = new Map<string, ReadRule>([
  [
    'journalctl',
    (args) => {
      const parsed = parseOptions(args, JOURNALCTL, 'interleaved');
      // Operands are matches (`_SYSTEMD_UNIT=nginx.service`) or an executable path.
      return when(parsed !== null && parsed.operands.every((o) => /^[\w@.:=/+-]+$/.test(o)));
    },
  ],
  ['cat', (args) => when(args.length === 1 && isPath(args[0]!))],
  [
    'ls',
    (args) => {
      const paths = args.filter((a) => !isShortCluster(a));
      return when(paths.length <= 1 && paths.every(isPath));
    },
  ],
  ['tail', fileWithCounts],
  ['head', fileWithCounts],
  ['grep', grep],
  [
    'pgrep',
    (args) => {
      if (args.length === 0) return null;
      const parsed = parseOptions(args, PGREP, 'interleaved');
      return when(parsed !== null && parsed.operands.length <= 1);
    },
  ],
  ['ps', atMostOneCluster],
  ['docker', docker],
  ['systemctl', systemctl],
  ['df', atMostOneCluster],
  ['free', atMostOneCluster],
  ['uptime', noArgument],
  ['who', noArgument],
  ['ss', (args) => when(args.length === 1 && args[0] === '-tlnp')],
  ['md5sum', oneOperand],
  ['stat', oneOperand],
]);

/** The inspection commands the allow-list admits behind a bare `sudo`. */
const SUDO_READS = new Set(['journalctl', 'systemctl', 'ss']);

/** Match an argument vector (`['ls', '-la', '/srv']`) against the allow-list. */
export function matchRead(argv: readonly string[]): ReadMatch | null {
  const [first, second] = argv;
  if (first === undefined) return null;
  if (first === 'sudo') {
    if (second === undefined || !SUDO_READS.has(second)) return null;
    return READ_RULES.get(second)?.(argv.slice(2)) ?? null;
  }
  return READ_RULES.get(first)?.(argv.slice(1)) ?? null;
}

/** `NAME=value` or `NAME+=value` in front of a command. */
export const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * Is this simple command a read ? `null` when it is not eligible (a word the
 * shell rewrites, an assignment, an output redirection) or not on the list.
 */
export function readMatchOf(command: {
  readonly words: readonly Word[];
  readonly redirects: readonly Redirect[];
}): ReadMatch | null {
  if (command.redirects.some((r) => r.kind === 'out')) return null;
  if (command.words.some(isDynamic) || command.redirects.some((r) => isDynamic(r.target))) {
    return null;
  }
  const first = command.words[0];
  if (first === undefined || ASSIGNMENT.test(first.value)) return null;
  return matchRead(command.words.map((w) => w.value));
}

/** True iff `cmd` is exactly one simple command, fully visible, on the read allow-list. */
export function isReadAllowed(cmd: string): boolean {
  const lexed = lexCommandLine(cmd);
  const [only, ...others] = lexed.commands;
  if (only === undefined || others.length > 0 || lexed.opaque.length > 0) return false;
  return readMatchOf(only) !== null;
}
