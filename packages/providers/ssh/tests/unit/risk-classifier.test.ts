import { describe, expect, test } from 'vitest';
import type { ProviderBinding, Slice } from '@vaubaan/shared';

import { classifySshV4, looksLikeSecretFileRead } from '../../src/risk-classifier.ts';

const NO_BINDINGS: ReadonlyArray<ProviderBinding> = [];

function commandSlice(hostSlug: string, action: 'R' | 'W'): Slice {
  return {
    provider: 'ssh',
    path: [
      { kind: 'name', value: 'host' },
      { kind: 'ident', value: hostSlug },
      { kind: 'name', value: 'command' },
    ],
    action,
  };
}

describe('classifySshV4 — argument validation', () => {
  test('refuses an unknown tool', () => {
    const r = classifySshV4('ssh__sftp', { host_slug: 'vps', cmd: 'ls' }, NO_BINDINGS);
    expect(r).toEqual({ denied: "unknown ssh tool 'ssh__sftp'." });
  });

  test('refuses a call without host_slug', () => {
    const r = classifySshV4('ssh__exec', { cmd: 'ls' }, NO_BINDINGS);
    expect(r).toEqual({ denied: "ssh__exec requires a string 'host_slug'." });
  });

  test('refuses a call without cmd', () => {
    const r = classifySshV4('ssh__exec', { host_slug: 'vps' }, NO_BINDINGS);
    expect(r).toEqual({ denied: "ssh__exec requires a string 'cmd'." });
  });

  test('refuses non-string host_slug', () => {
    const r = classifySshV4('ssh__exec', { host_slug: 42, cmd: 'ls' }, NO_BINDINGS);
    expect(r).toEqual({ denied: "ssh__exec requires a string 'host_slug'." });
  });
});

describe('classifySshV4 — read vs write', () => {
  test('a benign `ls` → single R slice', () => {
    const r = classifySshV4('ssh__exec', { host_slug: 'staging-vps', cmd: 'ls' }, NO_BINDINGS);
    expect(r).toEqual({ slices: [commandSlice('staging-vps', 'R')] });
  });

  test('a benign `journalctl -u nginx` → single R slice', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'prod-host', cmd: 'journalctl -u nginx' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('prod-host', 'R')] });
  });

  test('`docker logs my-app` (whitelisted read) → single R slice', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'vps-rp', cmd: 'docker logs my-app' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('vps-rp', 'R')] });
  });

  test('`rm -rf /` → single W slice', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'rm -rf /' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('staging-vps', 'W')] });
  });

  test('`systemctl restart nginx` (not in read whitelist) → W slice', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'prod-host', cmd: 'systemctl restart nginx' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('prod-host', 'W')] });
  });

  test('`sudo apt install foo` → W slice', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'sudo apt install foo' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('staging-vps', 'W')] });
  });

  test('`echo hello > /tmp/x` (redirection breaks whitelist) → W slice', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'echo hello > /tmp/x' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('staging-vps', 'W')] });
  });
});

describe('classifySshV4 — secret-file co-touch (multi-slice)', () => {
  test('`cat /etc/shadow` → TWO identical R slices (co-touch secret-files)', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'prod-host', cmd: 'cat /etc/shadow' },
      NO_BINDINGS,
    );
    expect(r).toEqual({
      slices: [commandSlice('prod-host', 'R'), commandSlice('prod-host', 'R')],
    });
  });

  test('`cat /etc/passwd` → multi-slice', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'cat /etc/passwd' },
      NO_BINDINGS,
    );
    expect(r).toEqual({
      slices: [commandSlice('staging-vps', 'R'), commandSlice('staging-vps', 'R')],
    });
  });

  test('`cat /root/.env` → multi-slice (root-owned)', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'cat /root/.env' },
      NO_BINDINGS,
    );
    if ('slices' in r) {
      expect(r.slices).toHaveLength(2);
    } else {
      throw new Error('expected slices, got denial');
    }
  });

  test('`stat /home/ubuntu/.ssh/authorized_keys` → multi-slice', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'stat /home/ubuntu/.ssh/authorized_keys' },
      NO_BINDINGS,
    );
    if ('slices' in r) {
      expect(r.slices).toHaveLength(2);
    } else {
      throw new Error('expected slices, got denial');
    }
  });

  test('`cat /etc/hostname` → single R (benign /etc file, NOT a secret heuristic match)', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'cat /etc/hostname' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('staging-vps', 'R')] });
  });

  test('`cat /var/log/syslog` → single R (system log, not heuristic match)', () => {
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'cat /var/log/syslog' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('staging-vps', 'R')] });
  });

  test('`sudo cat /etc/sudoers` → W (the read whitelist refuses `sudo cat`; covered by write gates)', () => {
    // Documents an existing limitation of `policy.ts:isReadAllowed`
    // — the regex matches `^cat` not `^sudo cat`. The classifier
    // doesn't pre-strip `sudo`, so the call lands in W. The intent
    // (read of a sensitive file) is still covered by the exec-write
    // gate ; the secret-files heuristic is only
    // relevant on the R branch.
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'sudo cat /etc/sudoers' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('staging-vps', 'W')] });
  });

  test('`cat ~/.ssh/id_rsa` → W (the read whitelist regex rejects `~/`)', () => {
    // Same limitation : the `~` char is not in the whitelist's
    // `[\w/.-]` class. Use absolute paths (e.g. `/home/user/.ssh/...`)
    // for the secret-files heuristic to fire.
    const r = classifySshV4(
      'ssh__exec',
      { host_slug: 'staging-vps', cmd: 'cat ~/.ssh/id_rsa' },
      NO_BINDINGS,
    );
    expect(r).toEqual({ slices: [commandSlice('staging-vps', 'W')] });
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
  ])('looksLikeSecretFileRead(%j) === %s', (cmd, expected) => {
    expect(looksLikeSecretFileRead(cmd)).toBe(expected);
  });
});
