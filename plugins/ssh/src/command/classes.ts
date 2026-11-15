/**
 * Class detectors of the `ssh` command profiler — on a resolved command name
 * and its argument values : destructive, package, service.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7.
 * Handbook : docs/handbook/services/ssh.md.
 *
 * Pure. Each detector is a table of command names and verbs ; a verb may be
 * looked for among all the arguments, which can only over-flag. When the
 * arguments are not on the line (an expansion, a brace, `xargs`),
 * `worstCase` says what the command could do.
 */

import { lexCommandLine } from '../shell-lex.ts';

import { CLUSTER_TOOLS, COMPOSE_TOOLS, CONTAINER_TOOLS, JS_RUNNERS } from './opaque.ts';
import { resolveCommand } from './wrappers.ts';

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

export function destructiveArgv(name: string, args: readonly string[]): boolean {
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

export function packageArgv(name: string, args: readonly string[]): boolean {
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
export const SERVICE_VERBS = new Set(['start', 'stop', 'restart', 'reload', 'force-reload']);
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

export function serviceArgv(name: string, args: readonly string[]): boolean {
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

export interface Classes {
  readonly destructive: boolean;
  readonly packageInstall: boolean;
  readonly serviceControl: boolean;
}

export const NO_CLASS: Classes = {
  destructive: false,
  packageInstall: false,
  serviceControl: false,
};

/**
 * What a command may do when its arguments are not on the line (an
 * expansion, a brace, arguments fed by `xargs`) : the classes its detector
 * could report for some argument, or `'opaque'` when an argument could take
 * it out of the classifier's sight (`docker … exec`, `systemctl -H`).
 * `null` : the arguments do not change the class of this command.
 */
export function worstCase(name: string): Classes | 'opaque' | null {
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
