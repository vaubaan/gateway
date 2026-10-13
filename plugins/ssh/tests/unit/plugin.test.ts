/**
 * Mandatory suite of the SSH plugin : the SDK kit, the v5 classifier (host
 * resolution, read / write, command classes, opaque lines), the command-line
 * splitter, the credential spec and the host key pin, `execute` and
 * `discoverResources` over a fake transport. No socket is ever opened : the
 * real `ssh2` transport is replaced through `createSshPlugin({ transport })`.
 * The v4 classifier cases live unchanged in `risk-classifier.test.ts`.
 */
import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  parseSlice,
  serializeSlice,
  type ConnectionContext,
  type ExecuteContext,
  type Resource,
} from '@vaubaan/plugin-sdk';
import {
  assertCatalogCoverage,
  assertNoWildcard,
  assertPluginWellFormed,
  assertPresetsValid,
} from '@vaubaan/plugin-sdk/testing';
import { evaluateCall, indexCatalog, resourceEnvResolver } from '@vaubaan/policy-engine';

import {
  classifySsh,
  createSshPlugin,
  DISCOVERY_PROBE,
  fingerprintOf,
  hostKeyMatches,
  isDestructive,
  isPackageInstall,
  isServiceControl,
  MAX_CMD_LENGTH,
  normalizeFingerprint,
  profileCommandLine,
  splitCommandLine,
  sshPlugin,
  sshTarget,
  type ExecResult,
  type SshTarget,
  type SshTransport,
} from '../../src/index.ts';

// ─── fixtures ────────────────────────────────────────────────────────────────

const HOST = 'vps-1.example.com';
const OTHER = '10.0.0.7';
const FINGERPRINT = 'SHA256:' + 'A'.repeat(43);

const staging: Resource = {
  provider: 'ssh',
  ref: HOST,
  env: 'staging',
  displayName: `deploy@${HOST}:22`,
};
const prod: Resource = { provider: 'ssh', ref: OTHER, env: 'prod', displayName: `ops@${OTHER}:22` };
const unlabelled: Resource = { provider: 'ssh', ref: HOST, displayName: HOST };

const credential = {
  kind: 'ssh-key' as const,
  privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
  publicKey: 'ssh-ed25519 AAAA vaubaan-gateway',
  fields: { host: HOST, port: '2222', user: 'deploy', host_key_fingerprint: FINGERPRINT },
  metadata: {},
};

interface RecordedExec {
  readonly target: SshTarget;
  readonly cmd: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}

/** A transport that records calls and answers from a script. */
function fakeTransport(
  respond: (cmd: string) => ExecResult | Error = () => ok('done\n'),
): SshTransport & { calls: RecordedExec[] } {
  const calls: RecordedExec[] = [];
  return {
    calls,
    exec(target, cmd, options) {
      calls.push({ target, cmd, timeoutMs: options.timeoutMs, signal: options.signal });
      const out = respond(cmd);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    },
  };
}

function ok(stdout: string, exit_code = 0, stderr = ''): ExecResult {
  return { stdout, stderr, exit_code, duration_ms: 12, truncated: false };
}

const execCtx = (
  resources: readonly Resource[] = [staging],
  signal?: AbortSignal,
): ExecuteContext => ({
  credential,
  appConfig: {},
  fetch: () => Promise.reject(new Error('ssh plugin must not use fetch')),
  resources,
  ...(signal ? { signal } : {}),
});
const connCtx = (): ConnectionContext => ({
  credential,
  appConfig: {},
  fetch: () => Promise.reject(new Error('ssh plugin must not use fetch')),
});

const slices = (
  args: Record<string, unknown>,
  resources: readonly Resource[] = [staging],
): string[] => {
  const out = classifySsh('ssh__exec', args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
};
const denied = (args: Record<string, unknown>, resources: readonly Resource[] = [staging]) => {
  const out = classifySsh('ssh__exec', args, resources);
  return 'denied' in out ? out.denied : null;
};

// ─── kit ─────────────────────────────────────────────────────────────────────

describe('ssh plugin — structural kit', () => {
  test('well-formed, presets valid, no wildcard', () => {
    assertPluginWellFormed(sshPlugin);
    assertPresetsValid(sshPlugin);
    assertNoWildcard(sshPlugin);
  });

  test('the single tool classifies to slices every catalog risk covers', () => {
    const report = assertCatalogCoverage(
      sshPlugin,
      {
        ssh__exec: [
          { args: { cmd: 'uptime' } },
          { args: { host: HOST, cmd: 'cat /etc/shadow' } },
          { args: { cmd: 'touch /tmp/x' } },
          { args: { cmd: 'rm -rf /srv/app/releases/old' } },
          { args: { cmd: 'sudo apt-get install -y nginx' } },
          { args: { cmd: 'systemctl restart nginx' } },
          { args: { host: OTHER, cmd: 'ls' }, resources: [staging], expectDenied: true },
        ],
      },
      { resources: [staging] },
    );
    expect(report.toolsChecked).toBe(1);
    expect(report.risksUntouched).toEqual([]);
  });

  test('ships read-only, developer and operator ; developer never touches prod, packages, destructive or sudo ; no preset references the fallback', () => {
    const presets = sshPlugin.catalog.presets ?? [];
    expect(presets.map((p) => p.id)).toEqual(['read-only', 'developer', 'operator']);
    for (const p of presets) {
      expect(p.entries.map((e) => e.risk_id)).not.toContain('ssh.uncategorized-write');
    }
    const ro = presets.find((p) => p.id === 'read-only')!;
    expect(ro.entries.map((e) => e.risk_id)).toEqual(['ssh.exec-read']);

    const dev = presets.find((p) => p.id === 'developer')!;
    const devIds = dev.entries.map((e) => e.risk_id);
    expect(devIds.some((id) => id.includes('[prod]'))).toBe(false);
    expect(
      devIds.some((id) => /exec-(destructive|package-install|sudo)|secret-files/.test(id)),
    ).toBe(false);
    expect(dev.entries.find((e) => e.risk_id === 'ssh[staging].exec-service-control')?.gate).toBe(
      'approval',
    );

    const op = presets.find((p) => p.id === 'operator')!;
    const approval = op.entries.filter((e) => e.gate === 'approval').map((e) => e.risk_id);
    expect(approval).toContain('ssh.exec-read-secret-files');
    for (const cls of [
      'exec-write',
      'exec-destructive',
      'exec-package-install',
      'exec-service-control',
      'exec-sudo',
    ]) {
      expect(approval).toContain(`ssh[prod].${cls}`);
    }
    expect(op.entries.find((e) => e.risk_id === 'ssh[dev].exec-write')?.gate).toBe('auto');
  });
});

// ─── classifier ──────────────────────────────────────────────────────────────

describe('classifySsh — host resolution against mission resources', () => {
  test('host defaults to the single SSH resource of the mission', () => {
    expect(slices({ cmd: 'uptime' })).toEqual([`ssh.host[${HOST}].command.R`]);
  });

  test('an explicit host picks among several resources', () => {
    expect(slices({ host: OTHER, cmd: 'uptime' }, [staging, prod])).toEqual([
      `ssh.host[${OTHER}].command.R`,
    ]);
  });

  test('refuses a host the mission does not hold, an ambiguous or absent one, a malformed ref', () => {
    expect(denied({ host: OTHER, cmd: 'ls' })).toBe(
      `host '${OTHER}' is not a host of this mission`,
    );
    expect(denied({ cmd: 'ls' }, [staging, prod])).toMatch(/touches 2 SSH hosts/);
    expect(denied({ cmd: 'ls' }, [])).toMatch(/touches no SSH host/);
    expect(denied({ host: 'a b', cmd: 'ls' })).toBe('host: malformed ref');
    expect(denied({ host: 42, cmd: 'ls' })).toBe('host: malformed ref');
  });

  test('refuses a missing, empty, oversized or non-string cmd, a bad timeout, an unknown tool', () => {
    expect(denied({})).toBe('cmd: a non-empty string is required');
    expect(denied({ cmd: '   ' })).toBe('cmd: a non-empty string is required');
    expect(denied({ cmd: 'x'.repeat(MAX_CMD_LENGTH + 1) })).toMatch(/longer than/);
    expect(denied({ cmd: ';;' })).toBe('cmd: no command found on the line');
    expect(denied({ cmd: 'ls', timeout_s: -1 })).toMatch(/timeout_s/);
    expect(denied({ cmd: 'ls', timeout_s: 'soon' })).toMatch(/timeout_s/);
    expect(classifySsh('ssh__sftp_put', { cmd: 'x' }, [staging])).toEqual({
      denied: "unknown tool 'ssh__sftp_put'",
    });
  });
});

describe('classifySsh — read, write and command classes', () => {
  const H = `ssh.host[${HOST}].command`;

  test('a whitelisted read is one R slice ; piped reads stay reads', () => {
    expect(slices({ cmd: 'journalctl -u nginx' })).toEqual([`${H}.R`]);
    expect(slices({ cmd: 'ls -la /srv | grep app' })).toEqual([`${H}.R`]);
    expect(slices({ cmd: 'df -h && free -m' })).toEqual([`${H}.R`]);
  });

  test('a credential-bearing read adds the secret-file marker', () => {
    expect(slices({ cmd: 'cat /etc/shadow' })).toEqual([`${H}.R`, `${H}.secret-file.R`]);
    expect(slices({ cmd: 'stat /home/ubuntu/.ssh/authorized_keys' })).toEqual([
      `${H}.R`,
      `${H}.secret-file.R`,
    ]);
    expect(slices({ cmd: 'cat /etc/hostname' })).toEqual([`${H}.R`]);
  });

  test('a plain write is one W slice', () => {
    expect(slices({ cmd: 'touch /tmp/x' })).toEqual([`${H}.W`]);
    expect(slices({ cmd: 'git pull --ff-only' })).toEqual([`${H}.W`]);
  });

  test('destructive, package, service and privilege markers ride next to the W slice', () => {
    expect(slices({ cmd: 'rm -rf /srv/old' })).toEqual([`${H}.W`, `${H}.destructive.W`]);
    expect(slices({ cmd: 'apt-get install -y nginx' })).toEqual([`${H}.W`, `${H}.package.W`]);
    expect(slices({ cmd: 'systemctl restart nginx' })).toEqual([`${H}.W`, `${H}.service.W`]);
    expect(slices({ cmd: 'sudo systemctl restart nginx' })).toEqual([
      `${H}.W`,
      `${H}.service.W`,
      `${H}.privilege.W`,
    ]);
    expect(slices({ cmd: 'sudo -u postgres psql -c "select 1"' })).toEqual([
      `${H}.W`,
      `${H}.privilege.W`,
    ]);
  });

  test('sudo on a whitelisted inspection verb stays a read ; sudo cat on a secret is a privileged write that still flags the secret', () => {
    expect(slices({ cmd: 'sudo journalctl -u nginx' })).toEqual([`${H}.R`]);
    expect(slices({ cmd: 'sudo systemctl status nginx' })).toEqual([`${H}.R`]);
    expect(slices({ cmd: 'sudo cat /etc/shadow' })).toEqual([
      `${H}.secret-file.R`,
      `${H}.W`,
      `${H}.privilege.W`,
    ]);
  });

  test('a mixed line touches both sides : reads and writes with their classes', () => {
    expect(slices({ cmd: 'ls /srv; rm -rf /srv/old' })).toEqual([
      `${H}.R`,
      `${H}.W`,
      `${H}.destructive.W`,
    ]);
  });

  test('redirections and substitutions make the whole line a write, fd duplication does not', () => {
    expect(slices({ cmd: 'ls > /tmp/listing' })).toEqual([`${H}.W`]);
    expect(slices({ cmd: 'echo $(cat /etc/shadow)' })).toEqual([`${H}.secret-file.R`, `${H}.W`]);
    expect(slices({ cmd: 'uptime `whoami`' })).toEqual([`${H}.W`]);
    expect(slices({ cmd: 'journalctl -u nginx 2>&1 | grep -c error' })).toEqual([`${H}.R`]);
  });

  test('quotes are honoured when splitting ; a broken quote is a write', () => {
    expect(slices({ cmd: 'grep "a;b" /var/log/syslog' })).toEqual([`${H}.R`]);
    expect(slices({ cmd: "grep 'oops /var/log/syslog" })).toEqual([`${H}.W`]);
  });

  test('emitted slices parse back (round-trip)', () => {
    for (const s of slices({ cmd: 'sudo apt-get install -y nginx; cat /etc/shadow' })) {
      expect(serializeSlice(parseSlice(s))).toBe(s);
    }
  });
});

describe('classifySsh — the runtime qualifies write risks from the host label', () => {
  const indexed = indexCatalog(sshPlugin.catalog);

  test('a destructive write on a prod-labelled host needs ssh[prod].exec-write and ssh[prod].exec-destructive', () => {
    const out = classifySsh('ssh__exec', { cmd: 'rm -rf /srv/old' }, [prod]);
    if ('denied' in out) throw new Error(out.denied);
    const decision = evaluateCall({
      executed_slices: out.slices,
      token_accepted_risks: new Set(['ssh[prod].exec-write']),
      catalog: indexed,
      envResolver: resourceEnvResolver([prod]),
    });
    expect(decision.outcome).toBe('denied');
    if (decision.outcome === 'denied') {
      expect(decision.missing_risks).toContain('ssh[prod].exec-destructive');
    }
  });

  test('a read needs only ssh.exec-read, whatever the label', () => {
    const out = classifySsh('ssh__exec', { cmd: 'uptime' }, [prod]);
    if ('denied' in out) throw new Error(out.denied);
    const decision = evaluateCall({
      executed_slices: out.slices,
      token_accepted_risks: new Set(['ssh.exec-read']),
      catalog: indexed,
      envResolver: resourceEnvResolver([prod]),
    });
    expect(decision.outcome).toBe('allowed');
  });

  test('an unlabelled host never qualifies a write risk — the owner must label it', () => {
    const out = classifySsh('ssh__exec', { cmd: 'touch /tmp/x' }, [unlabelled]);
    if ('denied' in out) throw new Error(out.denied);
    const decision = evaluateCall({
      executed_slices: out.slices,
      token_accepted_risks: new Set(['ssh[staging].exec-write', 'ssh[prod].exec-write']),
      catalog: indexed,
      envResolver: resourceEnvResolver([unlabelled]),
    });
    expect(decision.outcome).toBe('denied');
  });
});

// ─── command-line analysis ───────────────────────────────────────────────────

describe('splitCommandLine', () => {
  test('splits on control operators and newlines, drops empties', () => {
    expect(splitCommandLine('a; b && c || d | e & f\ng').commands).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      'g',
    ]);
    expect(splitCommandLine(' ; ;; ').commands).toEqual([]);
  });

  test('keeps operators inside quotes, handles escapes', () => {
    expect(splitCommandLine(`echo "a;b" 'c|d' e\\;f`).commands).toEqual([`echo "a;b" 'c|d' e\\;f`]);
    expect(splitCommandLine(`echo 'it''s'`).malformed).toBe(false);
    expect(splitCommandLine(`echo "unterminated`).malformed).toBe(true);
  });

  test('flags substitutions and file redirections, not fd duplication', () => {
    expect(splitCommandLine('echo $(id)').substitution).toBe(true);
    expect(splitCommandLine('echo `id`').substitution).toBe(true);
    expect(splitCommandLine('diff <(ls a) <(ls b)').substitution).toBe(true);
    expect(splitCommandLine('echo "$(id)"').substitution).toBe(true);
    expect(splitCommandLine('ls > f').redirection).toBe(true);
    expect(splitCommandLine('ls >> f').redirection).toBe(true);
    expect(splitCommandLine('ls &> f').redirection).toBe(true);
    expect(splitCommandLine('ls 2>&1').redirection).toBe(false);
    expect(splitCommandLine('ls 2>&-').redirection).toBe(false);
    expect(splitCommandLine('ls < f').redirection).toBe(false);
  });
});

describe('command classes', () => {
  test.each([
    ['rm -rf /tmp/x', true],
    ['rm -r dir', true],
    ['rm --force f', true],
    ['rm file.txt', false],
    ['mkfs.ext4 /dev/sdb1', true],
    ['dd if=/dev/zero of=/dev/sda', true],
    ['shutdown -h now', true],
    ['init 6', true],
    ['init 3', false],
    ['iptables -F', true],
    ['ufw disable', true],
    ['docker system prune -af', true],
    ['docker rm -f web', true],
    ['docker volume rm data', true],
    ['crontab -r', true],
    ['crontab -l', false],
    ['FOO=1 rm -rf x', true],
    ['touch x', false],
  ])('isDestructive(%j) === %s', (cmd, expected) => {
    expect(isDestructive(cmd)).toBe(expected);
  });

  test.each([
    ['apt-get install -y nginx', true],
    ['apt install nginx', true],
    ['apt-get -y install nginx', true],
    ['apt list --installed', false],
    ['dpkg -i pkg.deb', true],
    ['dpkg -l', false],
    ['dnf install httpd', true],
    ['yum -y update', true],
    ['zypper in vim', true],
    ['apk add curl', true],
    ['pacman -Syu', true],
    ['pacman -Q', false],
    ['rpm -ivh x.rpm', true],
    ['rpm -qa', false],
    ['snap install core', true],
    ['brew install jq', true],
    ['flatpak install org.x', true],
    ['pipx install black', true],
    ['npm install -g pm2', true],
    ['npm i --global pm2', true],
    ['yarn global add serve', true],
    ['npm install', false],
    ['pip install requests', false],
  ])('isPackageInstall(%j) === %s', (cmd, expected) => {
    expect(isPackageInstall(cmd)).toBe(expected);
  });

  test.each([
    ['systemctl restart nginx', true],
    ['systemctl --no-block stop nginx', true],
    ['systemctl daemon-reload', true],
    ['systemctl status nginx', false],
    ['systemctl is-active nginx', false],
    ['service nginx restart', true],
    ['service nginx status', false],
    ['docker restart web', true],
    ['docker run -d nginx', true],
    ['docker compose up -d', true],
    ['docker-compose down', true],
    ['docker ps', false],
    ['docker exec web ls', false],
    ['pm2 restart all', true],
    ['supervisorctl restart app', true],
    ['nginx -s reload', true],
    ['nginx -t', false],
    ['kill 1234', true],
    ['pkill -f node', true],
  ])('isServiceControl(%j) === %s', (cmd, expected) => {
    expect(isServiceControl(cmd)).toBe(expected);
  });

  test('profileCommandLine unions the classes of every simple command', () => {
    expect(profileCommandLine('ls; sudo apt-get install -y x && systemctl restart x')).toEqual({
      read: true,
      write: true,
      secretFile: false,
      destructive: false,
      packageInstall: true,
      serviceControl: true,
      privilege: true,
    });
    expect(profileCommandLine(';')).toBeNull();
  });
});

// ─── credential ──────────────────────────────────────────────────────────────

describe('ssh credential spec and host key pin', () => {
  test('ssh-key, ed25519, four non-secret fields with patterns ; port optional', () => {
    const spec = sshPlugin.credential;
    expect(spec.kind).toBe('ssh-key');
    if (spec.kind !== 'ssh-key') return;
    expect(spec.algorithm).toBe('ed25519');
    expect(spec.fields.map((f) => f.name)).toEqual([
      'host',
      'port',
      'user',
      'host_key_fingerprint',
    ]);
    expect(spec.fields.every((f) => f.secret === false)).toBe(true);
    expect(spec.fields.find((f) => f.name === 'port')?.required).toBe(false);
    const host = spec.fields.find((f) => f.name === 'host')!;
    expect(new RegExp(host.pattern!).test('vps-1.example.com')).toBe(true);
    expect(new RegExp(host.pattern!).test('10.0.0.7')).toBe(true);
    expect(new RegExp(host.pattern!).test('[::1]')).toBe(false);
    expect(new RegExp(host.pattern!).test('user@host')).toBe(false);
    const fp = spec.fields.find((f) => f.name === 'host_key_fingerprint')!;
    expect(new RegExp(fp.pattern!).test(FINGERPRINT)).toBe(true);
    expect(new RegExp(fp.pattern!).test(`${FINGERPRINT}=`)).toBe(true);
    expect(new RegExp(fp.pattern!).test('MD5:aa:bb')).toBe(false);
  });

  test('sshTarget narrows the secret, defaults the port, normalises the fingerprint', () => {
    expect(sshTarget(credential)).toEqual({
      host: HOST,
      port: 2222,
      user: 'deploy',
      privateKeyPem: credential.privateKeyPem,
      hostKeyFingerprint: FINGERPRINT,
    });
    const noPort = { ...credential, fields: { ...credential.fields, port: '' } };
    expect(sshTarget(noPort).port).toBe(22);
    const padded = {
      ...credential,
      fields: { ...credential.fields, host_key_fingerprint: `${FINGERPRINT}=` },
    };
    expect(sshTarget(padded).hostKeyFingerprint).toBe(FINGERPRINT);
  });

  test('sshTarget refuses the wrong kind, a missing or malformed field', () => {
    expect(() =>
      sshTarget({ kind: 'api-key', fields: { api_key: 'k' }, metadata: {} }),
    ).toThrowError(/expects a 'ssh-key' credential/);
    expect(() =>
      sshTarget({ ...credential, fields: { ...credential.fields, host: 'bad host' } }),
    ).toThrowError(/'host'/);
    expect(() =>
      sshTarget({ ...credential, fields: { ...credential.fields, user: 'Root' } }),
    ).toThrowError(/'user'/);
    expect(() =>
      sshTarget({ ...credential, fields: { ...credential.fields, port: '70000' } }),
    ).toThrowError(/'port'/);
    expect(() =>
      sshTarget({ ...credential, fields: { ...credential.fields, host_key_fingerprint: 'nope' } }),
    ).toThrowError(/'host_key_fingerprint'/);
    expect(() => sshTarget({ ...credential, privateKeyPem: '' })).toThrowError(/private key/);
  });

  test('fingerprintOf is the OpenSSH SHA256 form ; hostKeyMatches compares pinned and presented', () => {
    const key = Buffer.from('ssh-ed25519 test key blob');
    const expected = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
    expect(fingerprintOf(key)).toBe(expected);
    expect(hostKeyMatches(expected, key)).toBe(true);
    expect(hostKeyMatches(`${expected}=`, key)).toBe(true);
    expect(hostKeyMatches(FINGERPRINT, key)).toBe(false);
    expect(hostKeyMatches('garbage', key)).toBe(false);
    expect(normalizeFingerprint(` ${FINGERPRINT}= `)).toBe(FINGERPRINT);
    expect(normalizeFingerprint(42)).toBeNull();
  });
});

// ─── execute / discover ──────────────────────────────────────────────────────

describe('execute over an injected transport', () => {
  test('runs the command on the credential host with the default timeout, returns stdout, stderr and the exit code', async () => {
    const transport = fakeTransport(() => ok('ok\n', 0, 'warn\n'));
    const plugin = createSshPlugin({ transport });
    const result = await plugin.execute(execCtx(), 'ssh__exec', { cmd: 'uptime' });
    expect(result.isError).toBeUndefined();
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.cmd).toBe('uptime');
    expect(transport.calls[0]!.timeoutMs).toBe(30_000);
    expect(transport.calls[0]!.target).toMatchObject({ host: HOST, port: 2222, user: 'deploy' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('ok\n');
    expect(text).toContain('[stderr]\nwarn');
    expect(text).toMatch(/\[exit 0 · 12 ms\]/);
    expect(result.structuredContent).toMatchObject({ exit_code: 0, stdout: 'ok\n' });
  });

  test('clamps the timeout to the ceiling and passes the abort signal through', async () => {
    const transport = fakeTransport();
    const plugin = createSshPlugin({ transport });
    const controller = new AbortController();
    await plugin.execute(execCtx([staging], controller.signal), 'ssh__exec', {
      cmd: 'sleep 1',
      timeout_s: 9999,
    });
    expect(transport.calls[0]!.timeoutMs).toBe(300_000);
    expect(transport.calls[0]!.signal).toBe(controller.signal);
  });

  test('a non-zero exit is a normal result, not an error', async () => {
    const plugin = createSshPlugin({ transport: fakeTransport(() => ok('', 2, 'no such file')) });
    const result = await plugin.execute(execCtx(), 'ssh__exec', { cmd: 'ls /nope' });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ exit_code: 2 });
  });

  test('refuses before any connection : bad arguments, a host that is not this connection, an unknown tool', async () => {
    const transport = fakeTransport();
    const plugin = createSshPlugin({ transport });
    const missing = await plugin.execute(execCtx(), 'ssh__exec', {});
    expect(missing.isError).toBe(true);
    const foreign = await plugin.execute(execCtx([staging, prod]), 'ssh__exec', {
      host: OTHER,
      cmd: 'ls',
    });
    expect(foreign.isError).toBe(true);
    expect((foreign.content[0] as { text: string }).text).toMatch(
      /not the host of this connection/,
    );
    const unknown = await plugin.execute(execCtx(), 'ssh__nope', { cmd: 'ls' });
    expect(unknown.isError).toBe(true);
    expect(transport.calls).toHaveLength(0);
  });

  test('transport failures propagate : auth, host key mismatch, timeout', async () => {
    const { UpstreamAuthError } = await import('@vaubaan/plugin-sdk');
    const { SshHostKeyMismatchError } = await import('../../src/index.ts');
    const auth = createSshPlugin({
      transport: fakeTransport(() => new UpstreamAuthError('authentication failed', 401)),
    });
    await expect(auth.execute(execCtx(), 'ssh__exec', { cmd: 'ls' })).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
    const pin = createSshPlugin({
      transport: fakeTransport(
        () => new SshHostKeyMismatchError(HOST, FINGERPRINT, 'SHA256:other'),
      ),
    });
    await expect(pin.execute(execCtx(), 'ssh__exec', { cmd: 'ls' })).rejects.toMatchObject({
      name: 'SshHostKeyMismatchError',
      expected: FINGERPRINT,
    });
    const slow = createSshPlugin({ transport: fakeTransport(() => new Error('timed out')) });
    await expect(slow.execute(execCtx(), 'ssh__exec', { cmd: 'ls' })).rejects.toThrow(/timed out/);
  });

  test('refuses a credential of another kind', async () => {
    const plugin = createSshPlugin({ transport: fakeTransport() });
    await expect(
      plugin.execute(
        { ...execCtx(), credential: { kind: 'api-key', fields: { api_key: 'k' }, metadata: {} } },
        'ssh__exec',
        { cmd: 'ls' },
      ),
    ).rejects.toMatchObject({ name: 'CredentialKindMismatch' });
  });
});

describe('discoverResources over an injected transport', () => {
  test('connects once with the probe and returns the host as the single resource', async () => {
    const transport = fakeTransport(() => ok('vps-1 Linux 6.8.0-45-generic x86_64\n'));
    const plugin = createSshPlugin({ transport });
    const resources = await plugin.discoverResources(connCtx());
    expect(transport.calls.map((c) => c.cmd)).toEqual([DISCOVERY_PROBE]);
    expect(resources).toEqual([
      {
        provider: 'ssh',
        ref: HOST,
        displayName: `deploy@${HOST}:2222`,
        metadata: {
          user: 'deploy',
          port: 2222,
          host_key_fingerprint: FINGERPRINT,
          hostname: 'vps-1',
          kernel: 'Linux 6.8.0-45-generic',
          machine: 'x86_64',
        },
      },
    ]);
  });

  test('a failing probe still yields the resource, without the uname facts', async () => {
    const plugin = createSshPlugin({
      transport: fakeTransport(() => ok('', 127, 'uname: not found')),
    });
    const [host] = await plugin.discoverResources(connCtx());
    expect(host!.ref).toBe(HOST);
    expect(host!.metadata).toEqual({
      user: 'deploy',
      port: 2222,
      host_key_fingerprint: FINGERPRINT,
    });
  });

  test('a rejected key or a wrong host key fails discovery with the typed error', async () => {
    const { UpstreamAuthError } = await import('@vaubaan/plugin-sdk');
    const plugin = createSshPlugin({
      transport: fakeTransport(() => new UpstreamAuthError('authentication failed', 401)),
    });
    await expect(plugin.discoverResources(connCtx())).rejects.toMatchObject({
      name: 'UpstreamAuthError',
    });
  });
});
