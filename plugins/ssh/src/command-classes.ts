/**
 * Command-line analysis of the `ssh` provider : split a shell line into
 * simple commands, decide read vs write for each, and detect the classes the
 * catalog prices apart (credential-file read, destructive, package, service,
 * privilege).
 *
 * Spec     : docs/spec/gateway-risk-model.md §7 (classification is the
 *            plugin's responsibility ; a classification error is a security hole).
 * Handbook : docs/handbook/providers/ssh.md §2.
 *
 * Pure : no IO, no `Date`. Conservative by construction :
 *   - the read whitelist (`policy.ts`) is the only way to be a read ;
 *   - a command substitution (`$(…)`, backticks, `<(…)`, `>(…)`) or an output
 *     redirection makes the whole line a write, because what runs or what is
 *     written cannot be seen ;
 *   - quotes are honoured when splitting, so `grep "a;b" f` is one command ;
 *     a malformed quote makes the whole line a write ;
 *   - class detection is a regex on the simple command after the `sudo`
 *     prefix is stripped : a heuristic that errs towards flagging, never a
 *     sandbox. The host-side boundary (login user, sudoers) is the last word.
 */

import { isReadAllowed } from './policy.ts';

/** The classes a line may carry on top of read / write. */
export interface CommandProfile {
  /** At least one simple command is a whitelisted read. */
  readonly read: boolean;
  /** At least one simple command is not a whitelisted read, or the line redirects / substitutes. */
  readonly write: boolean;
  /** At least one simple command reads a credential-bearing path. */
  readonly secretFile: boolean;
  /** Recursive / forced delete, disk tool, reboot, account deletion, firewall flush, Docker prune. */
  readonly destructive: boolean;
  /** Package manager in a mutating mode, global npm / pnpm / yarn / pipx install. */
  readonly packageInstall: boolean;
  /** Service or process lifecycle verb. */
  readonly serviceControl: boolean;
  /** `sudo` / `su` / `doas` / `pkexec` on a non-whitelisted command. */
  readonly privilege: boolean;
}

/** Longest command line the plugin classifies ; longer lines are refused. */
export const MAX_CMD_LENGTH = 16 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// Splitting
// ─────────────────────────────────────────────────────────────────────────────

export interface SplitLine {
  /** Simple commands in order, trimmed, empty ones dropped. */
  readonly commands: readonly string[];
  /** `$(`, backtick, `<(` or `>(` seen outside quotes. */
  readonly substitution: boolean;
  /** An output redirection (`>`, `>>`, `&>`, `>|`) to a file seen outside quotes. */
  readonly redirection: boolean;
  /** A quote was left open. */
  readonly malformed: boolean;
}

/**
 * Split a shell line on the control operators `;`, `&&`, `||`, `|`, `&` and
 * newlines, honouring single quotes, double quotes and backslash escapes.
 * Does not interpret anything else : no expansion, no here-doc handling
 * (`<<` is simply not an output redirection, and the body lines become
 * commands of their own — which are then writes, as they should be).
 */
export function splitCommandLine(line: string): SplitLine {
  const commands: string[] = [];
  let current = '';
  let substitution = false;
  let redirection = false;
  let quote: "'" | '"' | null = null;
  let i = 0;

  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed.length > 0) commands.push(trimmed);
    current = '';
  };

  while (i < line.length) {
    const ch = line[i]!;
    const next = line[i + 1];

    if (quote === "'") {
      if (ch === "'") quote = null;
      current += ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && next !== undefined) {
        current += ch + next;
        i += 2;
        continue;
      }
      if (ch === '`' || (ch === '$' && next === '(')) substitution = true;
      if (ch === '"') quote = null;
      current += ch;
      i += 1;
      continue;
    }

    // Outside quotes.
    if (ch === '\\' && next !== undefined) {
      current += ch + next;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (
      ch === '`' ||
      (ch === '$' && next === '(') ||
      ((ch === '<' || ch === '>') && next === '(')
    ) {
      substitution = true;
      current += ch;
      i += 1;
      continue;
    }
    if ((ch === '>' || ch === '<') && next === '&' && /[0-9-]/.test(line[i + 2] ?? '')) {
      // `2>&1`, `<&3`, `>&-` : fd duplication, no file written. Consumed as a
      // unit so the `&` is not read as a background operator.
      current += ch + next;
      i += 2;
      continue;
    }
    if (ch === '>') {
      // `> f`, `>> f`, `>| f` write a file.
      redirection = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '&' && next === '>') {
      redirection = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      flush();
      i += 1;
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      flush();
      i += 2;
      continue;
    }
    if (ch === '|' || ch === '&') {
      flush();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  flush();

  return { commands, substitution, redirection, malformed: quote !== null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Credential-bearing paths. Matched **anywhere** in the simple command, not
 * only after a reader : `echo $(cat /etc/shadow)` or `tar czf - /root/.ssh`
 * reference the secret as surely as `cat /etc/shadow` does. Intentionally
 * narrow on the path side : `/etc/hostname` or `/etc/os-release` are not
 * secrets, nor is `/var/log/syslog`. A path must start a word (line start,
 * whitespace, quote, `=` or `(`).
 */
const PATH_START = String.raw`(?:^|[\s"'=(])`;
const SECRET_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  // /etc/<sensitive> — shadow, sudoers, passwd, gshadow (and sudoers.d/…).
  new RegExp(PATH_START + String.raw`/etc/(?:shadow|sudoers|passwd|gshadow)(?:[\s"'.)/]|$)`),
  // /root — the whole tree is root-owned secrets.
  new RegExp(PATH_START + String.raw`/root(?:/|[\s"')]|$)`),
  // ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker — also spelled $HOME/… .
  new RegExp(
    PATH_START + String.raw`(?:~|\$HOME|\$\{HOME\})/\.(?:ssh|aws|gnupg|kube|docker)(?:/|[\s"')]|$)`,
  ),
  // /home/<user>/.ssh/… and similar — explicit absolute path.
  new RegExp(
    PATH_START + String.raw`/home/[^/\s"']+/\.(?:ssh|aws|gnupg|kube|docker)(?:/|[\s"')]|$)`,
  ),
];

/** True iff the simple command references a credential-bearing path. */
export function looksLikeSecretFileRead(cmd: string): boolean {
  return SECRET_FILE_PATTERNS.some((re) => re.test(cmd));
}

const PRIVILEGE_PREFIX = /^(?:sudo|doas|pkexec)(?:\s+-\S+(?:\s+\S+)?)*\s+|^su\b/;

/** Strip `sudo [options]`, `doas`, `pkexec` ; returns the inner command and whether a prefix was there. */
export function stripPrivilegePrefix(cmd: string): { inner: string; privileged: boolean } {
  const m = PRIVILEGE_PREFIX.exec(cmd);
  if (!m) return { inner: cmd, privileged: false };
  // `su` runs a shell or `-c <cmd>` : nothing reliable to classify inside.
  if (m[0] === 'su') return { inner: cmd, privileged: true };
  return { inner: cmd.slice(m[0].length).trim(), privileged: true };
}

/** First whitespace-separated token, env assignments (`FOO=bar cmd`) skipped. */
function tokens(cmd: string): string[] {
  const parts = cmd.split(/\s+/).filter(Boolean);
  while (parts.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0]!)) parts.shift();
  return parts;
}

const DESTRUCTIVE_BINARIES = new Set([
  'mkfs',
  'dd',
  'shred',
  'wipefs',
  'fdisk',
  'sfdisk',
  'sgdisk',
  'parted',
  'reboot',
  'shutdown',
  'halt',
  'poweroff',
  'userdel',
  'groupdel',
  'truncate',
]);

/** Destructive : recursive / forced delete, disk tools, power, accounts, firewall flush, Docker prune. */
export function isDestructive(cmd: string): boolean {
  const t = tokens(cmd);
  const bin = t[0] ?? '';
  if (bin === 'rm') {
    return t
      .slice(1)
      .some((a) => /^-[a-zA-Z]*[rRf]/.test(a) || a === '--recursive' || a === '--force');
  }
  if (DESTRUCTIVE_BINARIES.has(bin) || bin.startsWith('mkfs.')) return true;
  if (bin === 'init' && (t[1] === '0' || t[1] === '6')) return true;
  if (bin === 'crontab' && t.includes('-r')) return true;
  if (
    (bin === 'iptables' || bin === 'ip6tables' || bin === 'nft') &&
    t.some((a) => /^(-F|--flush|flush)$/.test(a))
  )
    return true;
  if (bin === 'ufw' && (t[1] === 'disable' || t[1] === 'reset')) return true;
  if (bin === 'docker') {
    const sub = t[1] ?? '';
    if (sub === 'rm' || sub === 'rmi') return true;
    if (
      (sub === 'system' || sub === 'volume' || sub === 'image' || sub === 'container') &&
      t[2] === 'prune'
    )
      return true;
    if (sub === 'volume' && t[2] === 'rm') return true;
  }
  if ((bin === 'kill' || bin === 'pkill') && t.includes('-1')) return true;
  return false;
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

/** Package : a package manager in a mutating mode. */
export function isPackageInstall(cmd: string): boolean {
  const t = tokens(cmd);
  const bin = t[0] ?? '';
  const sub = t[1] ?? '';
  switch (bin) {
    case 'apt':
    case 'apt-get':
    case 'aptitude':
      return APT_VERBS.has(sub) || (t.includes('-y') && APT_VERBS.has(t[2] ?? ''));
    case 'dpkg':
      return t.some((a) => /^(-i|--install|-r|--remove|-P|--purge)$/.test(a));
    case 'yum':
    case 'dnf':
    case 'microdnf':
      return YUM_VERBS.has(sub) || (sub.startsWith('-') && YUM_VERBS.has(t[2] ?? ''));
    case 'zypper':
      return ZYPPER_VERBS.has(sub) || (sub.startsWith('-') && ZYPPER_VERBS.has(t[2] ?? ''));
    case 'apk':
      return APK_VERBS.has(sub);
    case 'pacman':
      return /^-[SRU]/.test(sub);
    case 'rpm':
      return t.some((a) => /^(-[iUe]\w*|--install|--upgrade|--erase)$/.test(a));
    case 'snap':
      return SNAP_VERBS.has(sub);
    case 'brew':
      return BREW_VERBS.has(sub);
    case 'flatpak':
      return FLATPAK_VERBS.has(sub);
    case 'pipx':
      return sub === 'install' || sub === 'uninstall' || sub === 'upgrade';
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return (
        (JS_VERBS.has(sub) && t.some((a) => a === '-g' || a === '--global')) ||
        (sub === 'global' && JS_VERBS.has(t[2] ?? ''))
      );
    default:
      return false;
  }
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
const PM2_VERBS = new Set(['start', 'stop', 'restart', 'reload', 'delete', 'kill']);
const SUPERVISOR_VERBS = new Set(['start', 'stop', 'restart', 'reload', 'shutdown']);

/** Service : lifecycle of a service or process. */
export function isServiceControl(cmd: string): boolean {
  const t = tokens(cmd);
  const bin = t[0] ?? '';
  const sub = t[1] ?? '';
  switch (bin) {
    case 'systemctl':
      return t.slice(1).some((a) => SYSTEMCTL_VERBS.has(a));
    case 'service':
      return t.slice(2).some((a) => SERVICE_VERBS.has(a));
    case 'docker':
      if (sub === 'compose') return COMPOSE_VERBS.has(t[2] ?? '');
      return DOCKER_VERBS.has(sub);
    case 'docker-compose':
    case 'podman-compose':
      return t.slice(1).some((a) => COMPOSE_VERBS.has(a));
    case 'podman':
      return DOCKER_VERBS.has(sub);
    case 'pm2':
      return PM2_VERBS.has(sub);
    case 'supervisorctl':
      return SUPERVISOR_VERBS.has(sub);
    case 'nginx':
      return sub === '-s';
    case 'kill':
    case 'pkill':
    case 'killall':
      return true;
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_PROFILE: CommandProfile = {
  read: false,
  write: false,
  secretFile: false,
  destructive: false,
  packageInstall: false,
  serviceControl: false,
  privilege: false,
};

/**
 * Profile a whole command line. Returns `null` when the line holds no
 * command at all (operators or whitespace only) ; the caller refuses it.
 */
export function profileCommandLine(line: string): CommandProfile | null {
  const split = splitCommandLine(line);
  if (split.commands.length === 0) return null;

  let profile: CommandProfile = { ...EMPTY_PROFILE };
  const opaque = split.substitution || split.redirection || split.malformed;

  for (const simple of split.commands) {
    const secretFile = looksLikeSecretFileRead(simple);
    if (!opaque && isReadAllowed(simple)) {
      profile = { ...profile, read: true, secretFile: profile.secretFile || secretFile };
      continue;
    }
    const { inner, privileged } = stripPrivilegePrefix(simple);
    profile = {
      ...profile,
      write: true,
      secretFile: profile.secretFile || secretFile,
      privilege: profile.privilege || privileged,
      destructive: profile.destructive || isDestructive(inner),
      packageInstall: profile.packageInstall || isPackageInstall(inner),
      serviceControl: profile.serviceControl || isServiceControl(inner),
    };
  }
  // An opaque line (substitution, redirection, broken quote) is a write even
  // when every visible simple command is a read.
  if (opaque) profile = { ...profile, write: true };
  return profile;
}
