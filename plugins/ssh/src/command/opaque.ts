/**
 * Commands that cannot be seen through, for the `ssh` command profiler.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7.
 * Handbook : docs/handbook/services/ssh.md.
 *
 * Pure. A command that runs code or another command the classifier does not
 * parse (`bash -c`, `eval`, `python -c`, `awk`, `find -exec`, `ssh`,
 * `docker exec`, `su`, `watch`…) and a tool that leaves the host
 * (`systemctl -H`, `docker -H`) are opaque : the line they sit on is never a
 * read and carries every class. A shell or an interpreter given a script
 * file is a plain "run this program", priced as a write.
 *
 * The tool families (container, compose, cluster, JavaScript runners) are
 * declared here and shared with the class detectors (`classes.ts`).
 */

import { isDynamic, type Word } from '../shell-lex.ts';

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
export const JS_RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'npm', 'pnpm', 'yarn', 'bun']);
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

export const CONTAINER_TOOLS = new Set(['docker', 'podman', 'nerdctl']);
export const COMPOSE_TOOLS = new Set(['docker-compose', 'podman-compose']);
export const CLUSTER_TOOLS = new Set(['kubectl', 'oc']);
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
export function opaqueReason(name: string, args: readonly Word[]): string | null {
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
