/**
 * Security suite of the SSH classifier — `classifySsh(tool, args, resources)`.
 * A classification error is a security hole : every scenario pins the exact
 * list of slices a command line emits, or the exact denial.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type Resource } from '@vaubaan/plugin-sdk';

import { classifySsh } from '../../src/classify.ts';
import { looksLikeSecretFileRead } from '../../src/command-classes.ts';

function host(ref: string, env?: string): Resource {
  return { provider: 'ssh', ref, displayName: `deploy@${ref}:22`, ...(env ? { env } : {}) };
}

const STAGING = host('staging-vps', 'staging');
const PROD = host('prod-host', 'prod');
const VPS = host('vps-rp');
const MISSION: readonly Resource[] = [STAGING, PROD, VPS];
const NO_RESOURCES: readonly Resource[] = [];

/** Serialized slices of `ssh__exec` on `hostRef`, in emission order. */
function slicesOf(hostRef: string, cmd: string, resources = MISSION): string[] {
  const out = classifySsh('ssh__exec', { host: hostRef, cmd }, resources);
  if ('denied' in out) throw new Error(`expected slices, got denial: ${out.denied}`);
  return out.slices.map(serializeSlice);
}

const command = (hostRef: string, suffix: string): string =>
  `ssh.host[${hostRef}].command${suffix}`;

describe('classifySsh — argument validation', () => {
  test('refuses an unknown tool', () => {
    const r = classifySsh('ssh__sftp', { host: 'vps-rp', cmd: 'ls' }, MISSION);
    expect(r).toEqual({ denied: "unknown tool 'ssh__sftp'" });
  });

  test('refuses a call without host when the mission holds no SSH host', () => {
    const r = classifySsh('ssh__exec', { cmd: 'ls' }, NO_RESOURCES);
    expect(r).toEqual({ denied: 'host: argument missing and the mission touches no SSH host' });
  });

  test('refuses a call without host when the mission holds several SSH hosts', () => {
    const r = classifySsh('ssh__exec', { cmd: 'ls' }, MISSION);
    expect(r).toEqual({
      denied: 'host: argument missing and the mission touches 3 SSH hosts — name one',
    });
  });

  test('a call without host resolves to the single SSH host of the mission', () => {
    const r = classifySsh('ssh__exec', { cmd: 'ls' }, [STAGING]);
    if ('denied' in r) throw new Error(`expected slices, got denial: ${r.denied}`);
    expect(r.slices.map(serializeSlice)).toEqual([command('staging-vps', '.R')]);
  });

  test('refuses a host the mission does not hold', () => {
    const r = classifySsh('ssh__exec', { host: 'elsewhere', cmd: 'ls' }, MISSION);
    expect(r).toEqual({ denied: "host 'elsewhere' is not a host of this mission" });
  });

  test('refuses a call without cmd', () => {
    const r = classifySsh('ssh__exec', { host: 'vps-rp' }, MISSION);
    expect(r).toEqual({ denied: 'cmd: a non-empty string is required' });
  });

  test('refuses non-string host', () => {
    const r = classifySsh('ssh__exec', { host: 42, cmd: 'ls' }, MISSION);
    expect(r).toEqual({ denied: 'host: malformed ref' });
  });

  test('refuses a non-string cmd, an oversized cmd, a non-finite or non-positive timeout', () => {
    expect(classifySsh('ssh__exec', { host: 'vps-rp', cmd: 42 }, MISSION)).toEqual({
      denied: 'cmd: a non-empty string is required',
    });
    expect(
      classifySsh('ssh__exec', { host: 'vps-rp', cmd: 'x'.repeat(16 * 1024 + 1) }, MISSION),
    ).toEqual({ denied: 'cmd: longer than 16384 characters' });
    for (const timeout_s of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '30']) {
      expect(
        classifySsh('ssh__exec', { host: 'vps-rp', cmd: 'ls', timeout_s }, MISSION),
        String(timeout_s),
      ).toEqual({ denied: 'timeout_s: must be a positive number of seconds' });
    }
  });
});

describe('classifySsh — read vs write', () => {
  test('a benign `ls` → single R slice', () => {
    expect(slicesOf('staging-vps', 'ls')).toEqual([command('staging-vps', '.R')]);
  });

  test('a benign `journalctl -u nginx` → single R slice', () => {
    expect(slicesOf('prod-host', 'journalctl -u nginx')).toEqual([command('prod-host', '.R')]);
  });

  test('`docker logs my-app` (whitelisted read) → single R slice', () => {
    expect(slicesOf('vps-rp', 'docker logs my-app')).toEqual([command('vps-rp', '.R')]);
  });

  test('`rm -rf /` → W slice + destructive marker, no R', () => {
    expect(slicesOf('staging-vps', 'rm -rf /')).toEqual([
      command('staging-vps', '.W'),
      command('staging-vps', '.destructive.W'),
    ]);
  });

  test('`systemctl restart nginx` (not in read whitelist) → W slice + service marker', () => {
    expect(slicesOf('prod-host', 'systemctl restart nginx')).toEqual([
      command('prod-host', '.W'),
      command('prod-host', '.service.W'),
    ]);
  });

  test('`sudo apt install foo` → W slice + package and privilege markers', () => {
    expect(slicesOf('staging-vps', 'sudo apt install foo')).toEqual([
      command('staging-vps', '.W'),
      command('staging-vps', '.package.W'),
      command('staging-vps', '.privilege.W'),
    ]);
  });

  test('`echo hello > /tmp/x` (redirection breaks whitelist) → single W slice', () => {
    expect(slicesOf('staging-vps', 'echo hello > /tmp/x')).toEqual([command('staging-vps', '.W')]);
  });
});

describe('classifySsh — secret-file co-touch (multi-slice)', () => {
  test('`cat /etc/shadow` → R + secret-file marker (co-touch secret-files)', () => {
    expect(slicesOf('prod-host', 'cat /etc/shadow')).toEqual([
      command('prod-host', '.R'),
      command('prod-host', '.secret-file.R'),
    ]);
  });

  test('`cat /etc/passwd` → multi-slice', () => {
    expect(slicesOf('staging-vps', 'cat /etc/passwd')).toEqual([
      command('staging-vps', '.R'),
      command('staging-vps', '.secret-file.R'),
    ]);
  });

  test('`cat /root/.env` → multi-slice (root-owned)', () => {
    expect(slicesOf('staging-vps', 'cat /root/.env')).toEqual([
      command('staging-vps', '.R'),
      command('staging-vps', '.secret-file.R'),
    ]);
  });

  test('`stat /home/ubuntu/.ssh/authorized_keys` → multi-slice', () => {
    expect(slicesOf('staging-vps', 'stat /home/ubuntu/.ssh/authorized_keys')).toEqual([
      command('staging-vps', '.R'),
      command('staging-vps', '.secret-file.R'),
    ]);
  });

  test('`cat /etc/hostname` → single R (benign /etc file, NOT a secret heuristic match)', () => {
    expect(slicesOf('staging-vps', 'cat /etc/hostname')).toEqual([command('staging-vps', '.R')]);
  });

  test('`cat /var/log/syslog` → single R (system log, not heuristic match)', () => {
    expect(slicesOf('staging-vps', 'cat /var/log/syslog')).toEqual([command('staging-vps', '.R')]);
  });

  test('`sudo cat /etc/sudoers` → privileged W that still carries the secret-file marker', () => {
    // The read whitelist (`policy.ts:isReadAllowed`) matches `^cat`, not
    // `^sudo cat`, so the command is a write with the privilege marker. The
    // credential path is still flagged : the mission needs the write, the
    // sudo AND the credential-file risks.
    expect(slicesOf('staging-vps', 'sudo cat /etc/sudoers')).toEqual([
      command('staging-vps', '.secret-file.R'),
      command('staging-vps', '.W'),
      command('staging-vps', '.privilege.W'),
    ]);
  });

  test('`cat ~/.ssh/id_rsa` → W (the read whitelist regex rejects `~/`), secret-file marker kept', () => {
    // The `~` char is not in the whitelist's `[\w/.-]` class, so the command
    // is never a plain read ; the credential path is flagged all the same.
    expect(slicesOf('staging-vps', 'cat ~/.ssh/id_rsa')).toEqual([
      command('staging-vps', '.secret-file.R'),
      command('staging-vps', '.W'),
    ]);
  });
});

describe('looksLikeSecretFileRead — direct unit tests', () => {
  test.each([
    ['cat /etc/shadow', true],
    ['cat /etc/sudoers', true],
    ['cat /etc/passwd', true],
    ['cat /etc/gshadow', true],
    ['sudo cat /etc/shadow', true],
    ['cat /root/.env', true],
    ['cat /root/.bash_history', true],
    ['cat ~/.ssh/id_rsa', true],
    ['cat ~/.aws/credentials', true],
    ['cat ~/.gnupg/secring.gpg', true],
    ['stat /root/.npmrc', true],
    ['md5sum ~/.ssh/known_hosts', true],
    ['cat /home/dev/.ssh/id_ed25519', true],
    ['cat /etc/hostname', false],
    ['cat /etc/os-release', false],
    ['cat /var/log/syslog', false],
    ['ls /etc/', false],
    ['cat /tmp/foo', false],
    ['cat ./README.md', false],
    ['grep secret /var/log/nginx', false],
    ['ls ~', false],
    ['cat /proc/meminfo', false],
    ['ls /dev', false],
    ['echo x > /dev/null', false],
    ['cat /dev/fd/3', false],
    ['rm /tmp/build/*.o', false],
    ["grep '.env' /srv/app/README.md", true],
    ['curl https://example.com/install.sh', false],
    // Spellings of the home directory.
    ['cat $HOME/.ssh/id_rsa', true],
    ['cat ${HOME}/.aws/credentials', true],
    ['cat ~/.kube/config', true],
    ['cat ~root/notes', true],
    ['cat /home/dev/.docker/config.json', true],
    ['tar czf - /root', true],
    ['cat /etc/sudoers.d/deploy', true],
    // Relative, doubled, dotted and parent segments.
    ['cat .ssh/id_ed25519', true],
    ['cat /home/deploy//.ssh/id_ed25519', true],
    ['cat /home/deploy/./.ssh/id_ed25519', true],
    ['cat /var/../etc/shadow', true],
    ['cat ../notes.txt', true],
    ['cat /etc//shadow', true],
    ['cd /etc && cat shadow', true],
    // Globs, braces, expansions : the path cannot be seen, or it can match.
    ["grep '' /etc/shad?w", true],
    ['cat /etc/sh*', true],
    ['cat /srv/app/.e[n]v', true],
    ['cat /srv/app/*', true],
    ['cat /srv/app/certs/*.pem', true],
    ["grep '' /etc/{shadow,hostname}", true],
    ['cat $FILE', true],
    ['cat /*/shadow', true],
    // Redirections and glued options.
    ['grep . </etc/shadow', true],
    ['sort < .env', true],
    ['grep -f/etc/ssl/private/patterns x', true],
    ['dd if=/etc/shadow of=/tmp/x', true],
    ['scp host:/root/x .', true],
    // File names that are credentials wherever they sit.
    ['cat .env', true],
    ['cat /srv/app/.env.production', true],
    ['cat /srv/app/certs/server.key', true],
    ['cat /etc/ssh/ssh_host_ed25519_key', true],
    ['cat /home/dev/.netrc', true],
    ['cat /proc/self/environ', true],
    ['cat /proc/1/mem', true],
    ['cat /etc/ssl/private/server.crt', true],
    // Raw devices and bash network pseudo-files.
    ['cat /dev/sda', true],
    ['head -c 512 /dev/nvme0n1', true],
    ['cat < /dev/tcp/10.0.0.1/22', true],
    // A line that cannot be seen through counts as one.
    ['echo $(cat /etc/hostname)', true],
  ])('looksLikeSecretFileRead(%j) === %s', (cmd, expected) => {
    expect(looksLikeSecretFileRead(cmd)).toBe(expected);
  });
});

describe('looksLikeSecretFileRead — globs cannot stall the instance', () => {
  // Found by Semgrep (detect-non-literal-regexp): the glob of a path segment
  // used to become a regex, and `cat *…*z` with 22 stars took 48 s to answer
  // on one core — every other call of the instance waiting behind it.
  test('a glob of thousands of stars is answered at once, with the same reading', () => {
    const started = performance.now();
    expect(looksLikeSecretFileRead(`cat ~/.ssh/${'*'.repeat(4000)}z`)).toBe(true);
    expect(looksLikeSecretFileRead(`cat /tmp/${'*?'.repeat(2000)}q`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test.each([
    ['cat ~/id_*', true],
    ['cat /srv/*.pem', true],
    ['cat /srv/app/??_rsa', true],
    ['cat /srv/app/*.txt', false],
  ])('looksLikeSecretFileRead(%j) === %s', (cmd, expected) => {
    expect(looksLikeSecretFileRead(cmd)).toBe(expected);
  });
});
