/**
 * Credential-bearing paths, for the `ssh` command profiler : does a simple
 * command name — or possibly name — a file that holds a credential ?
 *
 * Spec     : docs/spec/gateway-risk-model.md §7.
 * Handbook : docs/handbook/services/ssh.md.
 *
 * Pure. Every word of a command and every redirection target is cut into
 * path candidates (on `=`, `:`, `,`, and an option glued to an absolute path)
 * and each candidate into segments. A segment that names a credential
 * anywhere (`.ssh`, `.env*`, a private key, `shadow`…), a rooted path that
 * reaches one (`/root`, a disk under `/dev`, `/proc/…/mem`,
 * `/etc/ssl/private`), a `..` and a word the classifier cannot see (an
 * expansion, a brace) all count : the marker fails closed.
 */

import {
  matchWildcard,
  wildcardLiteral,
  WILDCARD_ANY,
  WILDCARD_ONE,
  type WildcardToken,
} from '@vaubaan/plugin-sdk';

import { hasBrace, lexCommandLine, type SimpleCommand, type Word } from '../shell-lex.ts';

/**
 * Names that mark a credential wherever they sit in a path : the directory
 * (`.ssh`, `.aws`…) or the file (`.env*`, private keys, the account
 * databases). Matched per path segment, so `.ssh/id_ed25519`,
 * `/home/u//.ssh/x` and `cd /etc && cat shadow` are all caught.
 */
const SECRET_SEGMENT = new RegExp(
  `^(?:${[
    String.raw`\.(?:ssh|aws|gnupg|kube|docker|azure|vault-token)`,
    // Shell histories hold the secrets typed on a command line; Terraform states hold the
    // values of every resource they created.
    String.raw`\.\w*_?history`,
    String.raw`.+\.tfstate(?:\.backup)?`,
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
  '.azure',
  '.vault-token',
  '.bash_history',
  '.zsh_history',
  '.python_history',
  'terraform.tfstate',
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
    const ch = word.value.charAt(i);
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

/**
 * Rules that need the path from the root : `/root`, `/dev/<disk>`, `/proc/…/mem`,
 * `/etc/ssl/private`, `/run/secrets` and `/var/run/secrets` (Docker and Kubernetes mount
 * their secrets there).
 */
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
  if (first.text === 'run' && second?.text === 'secrets') return true;
  if (first.text === 'var' && second?.text === 'run' && third?.text === 'secrets') return true;
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

/** Does any word or redirection target of the command name a credential-bearing path ? */
export function commandReferencesSecret(command: SimpleCommand): boolean {
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
