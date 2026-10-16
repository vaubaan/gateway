/**
 * Command-line analysis of the `ssh` provider : decide read vs write for each
 * simple command of a shell line and detect the classes the catalog prices
 * apart (credential-file read, destructive, package, service, privilege).
 *
 * Spec     : docs/spec/gateway-risk-model.md §7 (classification is the
 *            plugin's responsibility ; a classification error is a security hole).
 * Handbook : docs/handbook/providers/ssh.md §3.
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
 * What this does not do : follow a script file. `./deploy.sh`, `bash x.sh`,
 * `make`, `npm run build` are plain writes — "run a program on the host" is
 * what `exec-write` means, and the program may do anything its user can. The
 * class markers price the commands **written on the line** ; the host-side
 * boundary (login user, sudoers) is the last word.
 */

import {
  matchWildcard,
  wildcardLiteral,
  WILDCARD_ANY,
  WILDCARD_ONE,
  type WildcardToken,
} from '@vaubaan/plugin-sdk';

import { ASSIGNMENT, parseOptions, readMatchOf, type OptionSpec } from './policy.ts';
import { hasBrace, isDynamic, lexCommandLine, type SimpleCommand, type Word } from './shell-lex.ts';

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

// ─────────────────────────────────────────────────────────────────────────────
// Splitting
// ─────────────────────────────────────────────────────────────────────────────

export interface SplitLine {
  /** Simple commands in order, trimmed, comments removed, empty ones dropped. */
  readonly commands: readonly string[];
  /** `$(`, backtick, `<(`, `>(` or `$[` seen outside single quotes. */
  readonly substitution: boolean;
  /** An output redirection (`>`, `>>`, `&>`, `>|`, `>&file`, `<>`) to a file seen outside quotes. */
  readonly redirection: boolean;
  /** A quote was left open, a backslash ends the line, or a redirection has no target. */
  readonly malformed: boolean;
  /** Why the line cannot be seen through (`shell-lex.ts`) ; empty when it can. */
  readonly opaque: readonly string[];
}

/**
 * Split a shell line into simple commands on `;`, `&&`, `||`, `|`, `&`,
 * newlines and the grouping parentheses, honouring quotes, backslash escapes
 * and comments. A view over `lexCommandLine` for callers that want text.
 */
export function splitCommandLine(line: string): SplitLine {
  const lexed = lexCommandLine(line);
  return {
    commands: lexed.commands.map((c) => c.text),
    substitution: lexed.substitution,
    redirection: lexed.redirection,
    malformed: lexed.malformed,
    opaque: lexed.opaque,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Credential-bearing paths
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Names that mark a credential wherever they sit in a path : the directory
 * (`.ssh`, `.aws`…) or the file (`.env*`, private keys, the account
 * databases). Matched per path segment, so `.ssh/id_ed25519`,
 * `/home/u//.ssh/x` and `cd /etc && cat shadow` are all caught.
 */
const SECRET_SEGMENT = new RegExp(
  `^(?:${[
    String.raw`\.(?:ssh|aws|gnupg|kube|docker)`,
    String.raw`\.env.*`,
    String.raw`\.(?:netrc|pgpass|npmrc|pypirc|git-credentials|htpasswd|my\.cnf)`,
    String.raw`id_(?:rsa|dsa|ecdsa|ed25519)[\w.-]*`,
    String.raw`.+\.(?:pem|key|p12|pfx|kdbx)`,
    String.raw`ssh_host_\w+_key`,
    String.raw`authorized_keys\d?`,
    String.raw`(?:shadow|gshadow|passwd|sudoers)(?:[.-].*)?`,
    String.raw`environ`,
    String.raw`~root`,
  ].join('|')})$`,
);

/** One name per family of `SECRET_SEGMENT` : what a glob is tried against. */
const SECRET_NAME_SAMPLES: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.env',
  '.env.local',
  '.netrc',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.git-credentials',
  '.htpasswd',
  '.my.cnf',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'server.pem',
  'server.key',
  'store.p12',
  'store.pfx',
  'vault.kdbx',
  'ssh_host_ed25519_key',
  'authorized_keys',
  'shadow',
  'gshadow',
  'passwd',
  'sudoers',
  'sudoers.d',
  'environ',
];

/** Device nodes that hold no data of the host. Anything else under `/dev` is a disk, memory or a socket. */
const HARMLESS_DEVICES = new Set([
  'null',
  'zero',
  'full',
  'random',
  'urandom',
  'stdin',
  'stdout',
  'stderr',
  'tty',
]);

interface Segment {
  readonly text: string;
  /** Holds a glob character the shell expands. */
  readonly glob: boolean;
  /** The segment as a wildcard pattern (literal when `glob` is false). */
  readonly pattern: readonly WildcardToken[];
}

/** Cut `word[from, to)` into path segments ; empty and `.` segments are dropped (`a//b`, `a/./b`). */
function segmentsOf(word: Word, from: number, to: number): Segment[] {
  const segments: Segment[] = [];
  let text = '';
  let pattern: WildcardToken[] = [];
  let glob = false;
  const flush = (): void => {
    if (text !== '' && text !== '.') segments.push({ text, glob, pattern });
    text = '';
    pattern = [];
    glob = false;
  };
  for (let i = from; i < to; i += 1) {
    const ch = word.value[i]!;
    if (ch === '/') {
      flush();
      continue;
    }
    text += ch;
    if (word.bare[i] === true && (ch === '*' || ch === '?' || ch === '[')) {
      glob = true;
      // A bracket expression is read as "any one character" : a superset.
      pattern.push(ch === '*' ? WILDCARD_ANY : WILDCARD_ONE);
      if (ch === '[') {
        const close = word.value.indexOf(']', i + 1);
        if (close !== -1 && close < to && !word.value.slice(i, close).includes('/')) {
          text += word.value.slice(i + 1, close + 1);
          i = close;
        }
      }
    } else {
      pattern.push(...wildcardLiteral(ch));
    }
  }
  flush();
  return segments;
}

function segmentIsSecret(segment: Segment): boolean {
  if (segment.text === '..') return true; // the target cannot be resolved without following symlinks
  if (!segment.glob) return SECRET_SEGMENT.test(segment.text);
  // Matched without a regex: a glob of an agent's command line turned into
  // one (`*******…z`) backtracks for seconds and blocks the instance.
  return (
    SECRET_NAME_SAMPLES.some((name) => matchWildcard(segment.pattern, name)) ||
    SECRET_SEGMENT.test(segment.text.replace(/[*?[\]]/g, ''))
  );
}

/** Rules that need the path from the root : `/root`, `/dev/<disk>`, `/proc/…/mem`, `/etc/ssl/private`. */
function rootedPathIsSecret(segments: readonly Segment[]): boolean {
  const [first, second, third] = segments;
  if (first === undefined) return false;
  if (first.glob) return true;
  if (first.text === 'root') return true;
  if (first.text === 'dev' && second !== undefined) {
    const harmless =
      (segments.length === 2 && !second.glob && HARMLESS_DEVICES.has(second.text)) ||
      (segments.length === 3 && second.text === 'fd' && /^\d+$/.test(third?.text ?? ''));
    return !harmless;
  }
  if (first.text === 'proc') {
    return segments.some(
      (s) => s.glob || s.text === 'mem' || s.text === 'kcore' || s.text === 'kmem',
    );
  }
  return first.text === 'etc' && second?.text === 'ssl' && third?.text === 'private';
}

/** One path candidate : `word[from, to)`. */
function pieceIsSecret(word: Word, from: number, to: number): boolean {
  const segments = segmentsOf(word, from, to);
  if (segments.some(segmentIsSecret)) return true;
  const firstSlash = word.value.indexOf('/', from);
  if (firstSlash === -1 || firstSlash >= to) return false;
  if (firstSlash === from) return rootedPathIsSecret(segments);
  // `-f/etc/ssl/private/x` : an option glued to an absolute path.
  if (word.value[from] === '-') return rootedPathIsSecret(segmentsOf(word, firstSlash, to));
  return false;
}

/**
 * Does the word name — or possibly name — a credential-bearing path ? A word
 * holding an expansion or a brace cannot be seen and counts as one. The word
 * is also cut on `=`, `:` and `,` so `--file=/etc/shadow`, `of=/root/x` and
 * `host:/etc/shadow` are examined as paths.
 */
function wordIsSecret(word: Word): boolean {
  if (word.expansion || hasBrace(word)) return true;
  let from = 0;
  for (let i = 0; i <= word.value.length; i += 1) {
    const ch = word.value[i];
    if (ch !== undefined && ch !== '=' && ch !== ':' && ch !== ',') continue;
    if (i > from && pieceIsSecret(word, from, i)) return true;
    from = i + 1;
  }
  return false;
}

function commandReferencesSecret(command: SimpleCommand): boolean {
  return command.words.some(wordIsSecret) || command.redirects.some((r) => wordIsSecret(r.target));
}

/**
 * True iff the line references a credential-bearing path, anywhere : as an
 * argument, as a redirection target (`< /etc/shadow`), glued to an option.
 * A line that cannot be seen through counts as one.
 */
export function looksLikeSecretFileRead(cmd: string): boolean {
  const lexed = lexCommandLine(cmd);
  return lexed.opaque.length > 0 || lexed.commands.some(commandReferencesSecret);
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalising a simple command : keywords, assignments, wrappers
// ─────────────────────────────────────────────────────────────────────────────

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
function stripReserved(words: readonly Word[]): readonly Word[] {
  let i = 0;
  while (
    i < words.length &&
    RESERVED_PREFIX.has(words[i]!.value) &&
    words[i]!.bare.every(Boolean)
  ) {
    i += 1;
  }
  return words.slice(i);
}

/**
 * The same, assignments included and quoting ignored : over-stripping can
 * only make the classes of the words that follow count, never hide them.
 */
function stripReservedAndAssignments(words: readonly Word[]): readonly Word[] {
  let i = 0;
  while (
    i < words.length &&
    (RESERVED_PREFIX.has(words[i]!.value) || ASSIGNMENT.test(words[i]!.value))
  ) {
    i += 1;
  }
  return words.slice(i);
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

interface ResolvedCommand {
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
function resolveCommand(words: readonly Word[]): ResolvedCommand {
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

// ─────────────────────────────────────────────────────────────────────────────
// Commands that cannot be seen through
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commands whose effect is decided by something the classifier does not read :
 * a string or a file evaluated by this shell, another user, another host,
 * another namespace or container, or a command passed behind options that are
 * not parsed here.
 */
const OPAQUE_COMMANDS = new Set([
  // shell code from a string, a file, or a later event
  'eval',
  'source',
  '.',
  '..',
  'trap',
  'alias',
  // compound commands that are not followed
  'for',
  'case',
  'select',
  'function',
  'coproc',
  // another user
  'su',
  'runuser',
  'sudoedit',
  'run0',
  'gosu',
  'su-exec',
  'setuidgid',
  'sg',
  'newgrp',
  // another host
  'ssh',
  'scp',
  'sftp',
  'rsh',
  'rlogin',
  'telnet',
  'mosh',
  'nc',
  'ncat',
  'netcat',
  'socat',
  // another root, namespace or container
  'chroot',
  'nsenter',
  'unshare',
  'machinectl',
  'systemd-nspawn',
  'systemd-run',
  'lxc',
  'lxc-attach',
  'bwrap',
  'firejail',
  'fakeroot',
  // run the command or the program text they are given
  'at',
  'awk',
  'batch',
  'busybox',
  'capsh',
  'catchsegv',
  'cgexec',
  'chpst',
  'chronic',
  'chrt',
  'daemon',
  'daemonize',
  'dbus-run-session',
  'dumb-init',
  'eatmydata',
  'envdir',
  'expect',
  'faketime',
  'flock',
  'gawk',
  'gdb',
  'linux32',
  'linux64',
  'logsave',
  'ltrace',
  'mawk',
  'nawk',
  'numactl',
  'parallel',
  'perf',
  'prlimit',
  'proxychains',
  'proxychains4',
  'rlwrap',
  'run-parts',
  'runcon',
  'screen',
  'script',
  'setarch',
  'setpriv',
  'softlimit',
  'ssh-agent',
  'sshpass',
  'start-stop-daemon',
  'strace',
  'systemd-inhibit',
  'taskset',
  'tini',
  'tmux',
  'torify',
  'torsocks',
  'toybox',
  'tsocks',
  'unbuffer',
  'valgrind',
  'watch',
  'xvfb-run',
]);

/** The dynamic loader run as a program executes the binary it is given (`ld-linux-x86-64.so.2 /bin/rm`). */
const DYNAMIC_LOADER = /^ld[-.].*\.so(?:\.\d+)*$/;
/** JavaScript runners whose `-c` / `--call` takes a shell string (`npx -c`, `npm exec -c`). */
const JS_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun']);
/** `tar` options that run a program : long names may be abbreviated, short ones clustered. */
const TAR_RUNS_PROGRAM = /^(?:--(?:to-c|checkpoint-|use|rsh|info-|new-)|-[A-Za-z]*[IF])/;

const SHELLS = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'mksh',
  'ash',
  'csh',
  'tcsh',
  'fish',
  'rbash',
]);
const INTERPRETER =
  /^(?:python|pypy|perl|ruby|irb|node|nodejs|deno|php|lua|luajit|tclsh|wish|rscript|julia|groovy|jshell|guile|racket|elixir|erl|ghci|osascript|pwsh|powershell)[\d.]*$/;

const CONTAINER_TOOLS = new Set(['docker', 'podman', 'nerdctl']);
const COMPOSE_TOOLS = new Set(['docker-compose', 'podman-compose']);
const CLUSTER_TOOLS = new Set(['kubectl', 'oc']);
const CONTAINER_EXEC_VERBS = new Set(['exec', 'run']);
const CLUSTER_EXEC_VERBS = new Set(['exec', 'run', 'debug', 'attach', 'cp']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/**
 * A shell or an interpreter is a plain "run this program" only when its first
 * argument is a script file ; with an option (`-c`, `-e`, `-m`, `-s`), with no
 * argument (the program comes from stdin : `curl … | sh`) or with a
 * pseudo-file (`/dev/stdin`), the code that runs is not on the line.
 */
function runsScriptFile(args: readonly Word[]): boolean {
  const first = args[0];
  if (first === undefined || isDynamic(first) || first.value.startsWith('-')) return false;
  return !/^\/+(?:dev|proc)(?:\/|$)/.test(first.value);
}

/** Why `name args…` cannot be seen through, or `null`. */
function opaqueReason(name: string, args: readonly Word[]): string | null {
  // nosemgrep: detect-redos -- one `.*` then literal `.so` and `\.\d+` groups: polynomial at worst, on a command name the lexer caps
  if (OPAQUE_COMMANDS.has(name) || DYNAMIC_LOADER.test(name)) return 'indirect-command';
  if (SHELLS.has(name) || INTERPRETER.test(name)) {
    return runsScriptFile(args) ? null : 'inline-code';
  }
  const argv = args.map((w) => w.value);
  if (name === 'systemctl') {
    // `-H` / `-M` in a cluster, or any long option that may abbreviate
    // `--host`, `--machine`, `--root`, `--image` (getopt accepts a prefix).
    const leavesHost = argv.some((a) => /^(?:-[A-Za-z]*[HM]|--(?:h|m|ro|im))/.test(a));
    return leavesHost ? 'another-host' : null;
  }
  if (JS_RUNNERS.has(name)) {
    return argv.some((a) => a === '-c' || a.startsWith('--call')) ? 'inline-code' : null;
  }
  if (name === 'tar') {
    // Old-style bundled options need no dash : `tar cIf zstd a.tar`.
    const bundled = /^[A-Za-z]*[IF][A-Za-z]*$/.test(argv[0] ?? '');
    return bundled || argv.some((a) => TAR_RUNS_PROGRAM.test(a)) ? 'inline-code' : null;
  }
  if (name === 'ip') return argv.includes('exec') ? 'indirect-command' : null;
  if (CONTAINER_TOOLS.has(name)) {
    const [verb, sub] = argv;
    // A global option before the verb may point the client at another daemon (`-H`, `--context`).
    if (verb?.startsWith('-') === true) return 'another-host';
    if (verb !== undefined && CONTAINER_EXEC_VERBS.has(verb)) return 'container-exec';
    if (verb === 'container' && sub !== undefined && CONTAINER_EXEC_VERBS.has(sub)) {
      return 'container-exec';
    }
    if (verb === 'compose' && argv.some((a) => CONTAINER_EXEC_VERBS.has(a)))
      return 'container-exec';
    return null;
  }
  if (COMPOSE_TOOLS.has(name)) {
    return argv.some((a) => CONTAINER_EXEC_VERBS.has(a)) ? 'container-exec' : null;
  }
  if (CLUSTER_TOOLS.has(name)) {
    return argv.some((a) => CLUSTER_EXEC_VERBS.has(a)) ? 'container-exec' : null;
  }
  if (name === 'find') return argv.some((a) => FIND_EXEC.has(a)) ? 'inline-code' : null;
  if (name === 'rsync') {
    const remoteShell = argv.some((a) =>
      /^(?:-[A-Za-z]*e.*|--(?:rsh|rsync-path)(?:=.*)?)$/.test(a),
    );
    return remoteShell ? 'another-host' : null;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Class detectors — on a resolved command name and its argument values
// ─────────────────────────────────────────────────────────────────────────────

const DESTRUCTIVE_BINARIES = new Set([
  'mkfs',
  'mke2fs',
  'mkswap',
  'dd',
  'shred',
  'wipefs',
  'blkdiscard',
  'fdisk',
  'sfdisk',
  'sgdisk',
  'parted',
  'lvremove',
  'vgremove',
  'pvremove',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'kexec',
  'userdel',
  'deluser',
  'groupdel',
  'delgroup',
  'truncate',
]);
/** `systemctl` verbs that stop or restart the machine. */
const SYSTEMCTL_POWER_VERBS = new Set([
  'poweroff',
  'reboot',
  'soft-reboot',
  'halt',
  'kexec',
  'suspend',
  'hibernate',
  'hybrid-sleep',
  'suspend-then-hibernate',
  'emergency',
  'rescue',
  'exit',
]);
/** `docker <group> <verb>` : the management groups of the container tools. */
const CONTAINER_GROUPS = new Set([
  'builder',
  'buildx',
  'config',
  'container',
  'image',
  'network',
  'node',
  'secret',
  'service',
  'stack',
  'swarm',
  'system',
  'volume',
]);
const CONTAINER_REMOVE_VERBS = new Set(['rm', 'rmi', 'prune']);

function destructiveArgv(name: string, args: readonly string[]): boolean {
  if (name === 'rm') {
    // `-r`, `-R`, `-f` in a cluster ; `--recursive` / `--force`, which GNU `rm` accepts abbreviated (`--rec`).
    return args.some((a) => /^(?:-[a-zA-Z]*[rRf]|--[rf])/.test(a));
  }
  if (DESTRUCTIVE_BINARIES.has(name) || name.startsWith('mkfs.')) return true;
  if ((name === 'init' || name === 'telinit') && (args[0] === '0' || args[0] === '6')) return true;
  if (name === 'crontab') return args.some((a) => /^-[a-z]*r/.test(a));
  if (name === 'iptables' || name === 'ip6tables' || name === 'nft') {
    return args.some((a) => /^(?:-[A-Za-z]*F|--fl[a-z]*|flush)$/.test(a));
  }
  if (name === 'ufw') return args.includes('disable') || args.includes('reset');
  if (CONTAINER_TOOLS.has(name)) {
    const [verb, sub] = args;
    if (verb === 'rm' || verb === 'rmi') return true;
    if (verb !== undefined && CONTAINER_GROUPS.has(verb)) {
      return sub !== undefined && CONTAINER_REMOVE_VERBS.has(sub);
    }
    if (verb === 'compose') return composeRemoves(args.slice(1));
    return false;
  }
  if (COMPOSE_TOOLS.has(name)) return composeRemoves(args);
  if (name === 'kill' || name === 'pkill') return args.includes('-1');
  if (name === 'systemctl') return args.some((a) => SYSTEMCTL_POWER_VERBS.has(a));
  if (name === 'journalctl') return args.some((a) => a.startsWith('--vacuum'));
  if (name === 'find') return args.includes('-delete');
  if (name === 'rsync') return args.some((a) => /^--(?:del|delete.*|remove-source-files)$/.test(a));
  return false;
}

/** `compose rm`, or `compose down` taking the volumes or the images with it. */
function composeRemoves(args: readonly string[]): boolean {
  if (args.includes('rm')) return true;
  return (
    args.includes('down') &&
    args.some((a) => /^(?:-[a-z]*v[a-z]*|--volumes|--rmi(?:=.*)?)$/.test(a))
  );
}

const APT_VERBS = new Set([
  'install',
  'remove',
  'purge',
  'upgrade',
  'dist-upgrade',
  'full-upgrade',
  'autoremove',
  'reinstall',
]);
const YUM_VERBS = new Set([
  'install',
  'remove',
  'erase',
  'update',
  'upgrade',
  'downgrade',
  'reinstall',
  'autoremove',
  'groupinstall',
  'groupremove',
]);
const ZYPPER_VERBS = new Set(['in', 'install', 'rm', 'remove', 'up', 'update', 'dup', 'patch']);
const APK_VERBS = new Set(['add', 'del', 'upgrade']);
const SNAP_VERBS = new Set(['install', 'remove', 'refresh', 'revert']);
const BREW_VERBS = new Set(['install', 'uninstall', 'upgrade', 'reinstall']);
const FLATPAK_VERBS = new Set(['install', 'uninstall', 'update']);
const PIPX_VERBS = new Set(['install', 'uninstall', 'upgrade']);
const JS_VERBS = new Set([
  'install',
  'i',
  'add',
  'remove',
  'rm',
  'uninstall',
  'un',
  'update',
  'up',
]);

/**
 * Package managers whose verb may follow options (`apt-get -qq -y install`,
 * `apt-get -o Dpkg::Options::=--force-confold install`) : the verb is looked
 * for among all the arguments, which can only over-flag.
 */
const PACKAGE_VERBS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['apt', APT_VERBS],
  ['apt-get', APT_VERBS],
  ['aptitude', APT_VERBS],
  ['yum', YUM_VERBS],
  ['dnf', YUM_VERBS],
  ['microdnf', YUM_VERBS],
  ['zypper', ZYPPER_VERBS],
  ['apk', APK_VERBS],
  ['snap', SNAP_VERBS],
  ['brew', BREW_VERBS],
  ['flatpak', FLATPAK_VERBS],
  ['pipx', PIPX_VERBS],
]);
const JS_PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

function packageArgv(name: string, args: readonly string[]): boolean {
  const verbs = PACKAGE_VERBS.get(name);
  if (verbs !== undefined) return args.some((a) => verbs.has(a));
  if (name === 'dpkg') {
    return args.some((a) =>
      /^(-i|--install|-r|--remove|-P|--purge|--configure|--unpack|--triggers-only)$/.test(a),
    );
  }
  if (name === 'pacman') return args.some((a) => /^-[SRU]/.test(a));
  if (name === 'rpm') return args.some((a) => /^(-[iUe]\w*|--install|--upgrade|--erase)$/.test(a));
  if (JS_PACKAGE_MANAGERS.has(name)) {
    const verb = args.some((a) => JS_VERBS.has(a));
    return verb && args.some((a) => a === '-g' || a === '--global' || a === 'global');
  }
  return false;
}

const SYSTEMCTL_VERBS = new Set([
  'start',
  'stop',
  'restart',
  'reload',
  'reload-or-restart',
  'try-restart',
  'try-reload-or-restart',
  'enable',
  'disable',
  'mask',
  'unmask',
  'kill',
  'daemon-reload',
  'daemon-reexec',
  'isolate',
  'set-default',
]);
const SERVICE_VERBS = new Set(['start', 'stop', 'restart', 'reload', 'force-reload']);
const DOCKER_VERBS = new Set(['start', 'stop', 'restart', 'kill', 'pause', 'unpause', 'run']);
const COMPOSE_VERBS = new Set(['up', 'down', 'restart', 'stop', 'start', 'kill', 'rm']);
const SWARM_VERBS = new Set([
  'create',
  'deploy',
  'demote',
  'init',
  'join',
  'leave',
  'promote',
  'rm',
  'rollback',
  'scale',
  'update',
]);
const SWARM_GROUPS = new Set(['service', 'stack', 'swarm', 'node']);
const PM2_VERBS = new Set(['start', 'stop', 'restart', 'reload', 'delete', 'kill']);
const SUPERVISOR_VERBS = new Set(['start', 'stop', 'restart', 'reload', 'shutdown']);

function serviceArgv(name: string, args: readonly string[]): boolean {
  const [verb, sub] = args;
  if (name === 'systemctl') return args.some((a) => SYSTEMCTL_VERBS.has(a));
  if (name === 'service') return args.slice(1).some((a) => SERVICE_VERBS.has(a));
  if (CONTAINER_TOOLS.has(name)) {
    if (verb === 'compose') return args.slice(1).some((a) => COMPOSE_VERBS.has(a));
    if (verb === 'container') return sub !== undefined && DOCKER_VERBS.has(sub);
    if (verb !== undefined && SWARM_GROUPS.has(verb))
      return sub !== undefined && SWARM_VERBS.has(sub);
    return verb !== undefined && DOCKER_VERBS.has(verb);
  }
  if (COMPOSE_TOOLS.has(name)) return args.some((a) => COMPOSE_VERBS.has(a));
  if (name === 'pm2') return args.some((a) => PM2_VERBS.has(a));
  if (name === 'supervisorctl') return args.some((a) => SUPERVISOR_VERBS.has(a));
  if (name === 'nginx') return args.some((a) => a.startsWith('-s'));
  return name === 'kill' || name === 'pkill' || name === 'killall';
}

interface Classes {
  readonly destructive: boolean;
  readonly packageInstall: boolean;
  readonly serviceControl: boolean;
}

const NO_CLASS: Classes = { destructive: false, packageInstall: false, serviceControl: false };

/**
 * What a command may do when its arguments are not on the line (an
 * expansion, a brace, arguments fed by `xargs`) : the classes its detector
 * could report for some argument, or `'opaque'` when an argument could take
 * it out of the classifier's sight (`docker … exec`, `systemctl -H`).
 * `null` : the arguments do not change the class of this command.
 */
function worstCase(name: string): Classes | 'opaque' | null {
  if (
    name === 'systemctl' ||
    name === 'find' ||
    name === 'rsync' ||
    name === 'tar' ||
    name === 'ip' ||
    JS_RUNNERS.has(name) ||
    CONTAINER_TOOLS.has(name) ||
    COMPOSE_TOOLS.has(name) ||
    CLUSTER_TOOLS.has(name)
  ) {
    return 'opaque';
  }
  if (name === 'kill' || name === 'pkill')
    return { ...NO_CLASS, destructive: true, serviceControl: true };
  if (
    name === 'rm' ||
    name === 'journalctl' ||
    name === 'crontab' ||
    name === 'init' ||
    name === 'telinit' ||
    name === 'iptables' ||
    name === 'ip6tables' ||
    name === 'nft' ||
    name === 'ufw'
  ) {
    return { ...NO_CLASS, destructive: true };
  }
  if (
    PACKAGE_VERBS.has(name) ||
    JS_PACKAGE_MANAGERS.has(name) ||
    name === 'dpkg' ||
    name === 'pacman' ||
    name === 'rpm'
  ) {
    return { ...NO_CLASS, packageInstall: true };
  }
  if (name === 'service' || name === 'pm2' || name === 'supervisorctl' || name === 'nginx') {
    return { ...NO_CLASS, serviceControl: true };
  }
  return null;
}

/** Run a detector on the first simple command of `cmd` ; a command that cannot be resolved counts as a hit. */
function detect(
  cmd: string,
  detector: (name: string, args: readonly string[]) => boolean,
): boolean {
  const command = lexCommandLine(cmd).commands[0];
  if (command === undefined) return false;
  const resolved = resolveCommand(command.words);
  if (resolved.opaque !== null) return true;
  return detector(
    resolved.name,
    resolved.args.map((w) => w.value),
  );
}

/** Destructive : recursive / forced delete, disk tools, power, accounts, firewall flush, Docker prune. */
export function isDestructive(cmd: string): boolean {
  return detect(cmd, destructiveArgv);
}

/** Package : a package manager in a mutating mode. */
export function isPackageInstall(cmd: string): boolean {
  return detect(cmd, packageArgv);
}

/** Service : lifecycle of a service or process. */
export function isServiceControl(cmd: string): boolean {
  return detect(cmd, serviceArgv);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

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
