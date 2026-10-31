/**
 * Mandatory suite of the SSH plugin : the SDK kit, the v5 classifier (host
 * resolution, read / write, command classes, opaque lines), missions written
 * from macro-actions at trust crans evaluated through the policy engine, the command-line splitter, the
 * credential spec and the pin helpers, `execute` and `discoverResources` over
 * a fake transport. No socket is opened here : the real `ssh2` transport is
 * replaced through `createSshPlugin({ transport })` ; it is exercised, host
 * key verification included, by `host-key-pinning.test.ts`. The classifier's
 * scenario-by-scenario suites are `classify.test.ts` and `adversarial.test.ts`.
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
  assertIdentifiersRefused,
  assertNoWildcard,
  assertPluginWellFormed,
  assertSlicesOnDataModel,
  evaluateCall,
  indexCatalog,
  type MacroActionCranChoice,
  type MissionPolicyEntry,
  policyFromMacroActions,
  resourceEnvResolver,
  risksTouchedBy,
  type ToolSamples,
} from '@vaubaan/plugin-sdk/testing';

import {
  classifySsh,
  createSshPlugin,
  DISCOVERY_PROBE,
  fingerprintOf,
  hostKeyMatches,
  isDestructive,
  isPackageInstall,
  isReadAllowed,
  isServiceControl,
  lexCommandLine,
  hasBrace,
  hasGlob,
  MAX_CMD_LENGTH,
  normalizeFingerprint,
  parseOptions,
  profileCommandLine,
  splitCommandLine,
  SshHostKeyMismatchError,
  sshPlugin,
  sshTarget,
  stripPrivilegePrefix,
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
const dev: Resource = { provider: 'ssh', ref: HOST, env: 'dev', displayName: `deploy@${HOST}:22` };
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
  fetch: () => Promise.reject(new Error('ssh plugin must not use fetch')),
  resources,
  ...(signal ? { signal } : {}),
});
const connCtx = (): ConnectionContext => ({
  credential,
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
  test('well-formed, no wildcard', () => {
    assertPluginWellFormed(sshPlugin);
    assertNoWildcard(sshPlugin);
  });

  // One table for the catalog coverage and for the identifier proof.
  const SAMPLES: ToolSamples = {
    ssh__exec: [
      { args: { cmd: 'uptime' } },
      { args: { host: HOST, cmd: 'cat /etc/shadow' } },
      { args: { cmd: 'touch /tmp/x' } },
      { args: { cmd: 'rm -rf /srv/app/releases/old' } },
      { args: { cmd: 'sudo apt-get install -y nginx' } },
      { args: { cmd: 'systemctl restart nginx' } },
      { args: { host: OTHER, cmd: 'ls' }, resources: [staging], expectDenied: true },
    ],
  };

  test('the single tool classifies to slices every catalog risk covers', () => {
    const report = assertCatalogCoverage(sshPlugin, SAMPLES, { resources: [staging] });
    assertSlicesOnDataModel(sshPlugin, SAMPLES, { resources: [staging] });
    expect(report.toolsChecked).toBe(1);
    expect(report.risksUntouched).toEqual([]);
    expect(report.fallbackHits).toEqual([]);
    expect(report.risksTouched).toEqual([
      'ssh.exec-read',
      'ssh.exec-read-secret-files',
      'ssh.exec-write',
      'ssh.exec-destructive',
      'ssh.exec-package-install',
      'ssh.exec-service-control',
      'ssh.exec-sudo',
    ]);
  });

  // What is executed is what was classified (SDK kit) : every string argument of
  // every sample above is fed the hostile identifiers, through `classify` and
  // through `execute`. The finer cases are in this plugin's identifier tests.
  test('hostile identifiers are refused by classify and by execute, or named exactly', async () => {
    // The upstream is SSH : what `execute` sends is read from the transport.
    const transport = fakeTransport();
    const report = await assertIdentifiersRefused(createSshPlugin({ transport }), SAMPLES, {
      resources: [staging],
      context: (_fetch, resources) => execCtx(resources),
      elsewhere: {
        reset: () => transport.calls.splice(0),
        sent: () => transport.calls.map(() => ({ method: 'SSH', url: 'ssh:' })),
      },
      pathIdentifiers: { none: 'the upstream is an SSH command, not an HTTP request' },
    });
    expect(report.toolsChecked).toBe(1);
    // Found by running the samples : the arguments that are a segment of a request path.
    expect([...new Set(report.pathIdentifiers.map((p) => p.argument))].sort()).toEqual([]);
    // Whatever classify refused, execute sent nothing for.
    expect(report.refusedByClassify).toBeGreaterThan(0);
    expect(report.nothingSent).toBeGreaterThanOrEqual(report.refusedByClassify);
  });

  test('the fallback covers a write slice no dedicated risk matches, and only that', () => {
    const indexed = indexCatalog(sshPlugin.catalog);
    expect(risksTouchedBy(parseSlice('ssh.host[h].sftp.W'), indexed)).toEqual([
      'ssh.uncategorized-write',
    ]);
    expect(risksTouchedBy(parseSlice('ssh.host[h].command.W'), indexed)).toEqual([
      'ssh.exec-write',
    ]);
  });

  test('macro-actions : look, fix, install ; the fallback in none ; the reads apart from the writes', () => {
    const actions = sshPlugin.catalog.macro_actions ?? [];
    const ids = (id: string) =>
      actions.find((a) => a.id === id)?.entries.map((e) => e.risk_id) ?? [];
    expect(actions.map((a) => a.id)).toEqual(['look', 'fix', 'install']);
    expect(actions.flatMap((a) => a.entries.map((e) => e.risk_id))).not.toContain(
      'ssh.uncategorized-write',
    );
    expect(ids('look')).toEqual(['ssh.exec-read', 'ssh.exec-read-secret-files']);
    expect(ids('install')).toEqual(['ssh.exec-package-install', 'ssh.exec-sudo']);
  });

  test('at Prudent, a credential-file read asks first and a destructive line is left out everywhere', () => {
    const policy = policyFromMacroActions(
      sshPlugin,
      { look: 'prudent', fix: 'prudent' },
      { envs: ['dev', 'staging', 'prod'] },
    );
    const gate = (id: string) => policy.find((line) => line.risk_id === id)?.gate;
    expect(gate('ssh.exec-read')).toBe('auto');
    expect(gate('ssh.exec-read-secret-files')).toBe('approval');
    expect(
      policy.map((line) => line.risk_id).filter((id) => id.includes('exec-destructive')),
    ).toEqual([]);
    // A write on prod is irreversible (vector_overrides) : left out at Prudent.
    expect(gate('ssh[prod].exec-write')).toBeUndefined();
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
    expect(denied({ cmd: 'ls' }, [staging, prod])).toBe(
      'host: argument missing and the mission touches 2 SSH hosts — name one',
    );
    expect(denied({ cmd: 'ls' }, [])).toBe(
      'host: argument missing and the mission touches no SSH host',
    );
    expect(denied({ host: 'a b', cmd: 'ls' })).toBe('host: malformed ref');
    expect(denied({ host: 42, cmd: 'ls' })).toBe('host: malformed ref');
  });

  test('refuses a missing, empty, oversized or non-string cmd, a bad timeout, an unknown tool', () => {
    expect(denied({})).toBe('cmd: a non-empty string is required');
    expect(denied({ cmd: '   ' })).toBe('cmd: a non-empty string is required');
    expect(denied({ cmd: 42 })).toBe('cmd: a non-empty string is required');
    expect(denied({ cmd: ['ls'] })).toBe('cmd: a non-empty string is required');
    expect(denied({ cmd: 'x'.repeat(MAX_CMD_LENGTH + 1) })).toBe(
      'cmd: longer than 16384 characters',
    );
    expect(denied({ cmd: ';;' })).toBe('cmd: no command found on the line');
    expect(denied({ cmd: '# only a comment' })).toBe('cmd: no command found on the line');
    for (const timeout_s of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'soon', null]) {
      expect(denied({ cmd: 'ls', timeout_s }), String(timeout_s)).toBe(
        'timeout_s: must be a positive number of seconds',
      );
    }
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

  /** What a line the classifier cannot see through emits : every class, no read. */
  const OPAQUE = [
    `${H}.secret-file.R`,
    `${H}.W`,
    `${H}.destructive.W`,
    `${H}.package.W`,
    `${H}.service.W`,
    `${H}.privilege.W`,
  ];

  test('a redirection to a file makes the line a write ; a descriptor duplication does not', () => {
    expect(slices({ cmd: 'ls > /tmp/listing' })).toEqual([`${H}.W`]);
    expect(slices({ cmd: 'ls >> /tmp/listing' })).toEqual([`${H}.W`]);
    expect(slices({ cmd: 'ls 2>&1' })).toEqual([`${H}.R`]);
    expect(slices({ cmd: 'journalctl -u nginx 2>&1 | grep -c error' })).toEqual([`${H}.R`]);
    expect(slices({ cmd: 'ls >&listing' })).toEqual([`${H}.W`]);
    // `>&2file` is not a duplication (bash writes the file `2file`), and after
    // `>&` a `-` is a token of its own (`rm >&--rf x` runs `rm -rf x`) : opaque.
    expect(slices({ cmd: 'ls >&2file' })).toEqual(OPAQUE);
    expect(slices({ cmd: 'rm >&--rf /srv/old' })).toEqual(OPAQUE);
  });

  test('a line that cannot be seen through carries every class and is never a read', () => {
    expect(slices({ cmd: 'echo $(cat /etc/shadow)' })).toEqual(OPAQUE);
    expect(slices({ cmd: 'uptime `whoami`' })).toEqual(OPAQUE);
    expect(slices({ cmd: "bash -c 'uptime'" })).toEqual(OPAQUE);
    expect(slices({ cmd: 'uptime; cat <<EOF\nx\nEOF' })).toEqual(OPAQUE);
    expect(slices({ cmd: "grep 'oops /var/log/syslog" })).toEqual(OPAQUE);
    expect(profileCommandLine('uptime `whoami`')?.opaque).toEqual(['substitution']);
    expect(profileCommandLine("bash -c 'uptime'")?.opaque).toEqual(['inline-code']);
    expect(profileCommandLine("grep $'a' f")?.opaque).toEqual(['ansi-c-quoting']);
    expect(profileCommandLine('$CMD x')?.opaque).toEqual(['command-word']);
    expect(profileCommandLine('sudo -i')?.opaque).toEqual(['wrapper-option']);
    expect(profileCommandLine('ssh other uptime')?.opaque).toEqual(['indirect-command']);
    expect(profileCommandLine('systemctl -H other status x')?.opaque).toEqual(['another-host']);
    expect(profileCommandLine('docker exec web ls')?.opaque).toEqual(['container-exec']);
    expect(profileCommandLine('xargs systemctl')?.opaque).toEqual(['unseen-arguments']);
  });

  test('quotes and comments are read the way the shell reads them', () => {
    expect(slices({ cmd: 'grep "a;b" /var/log/syslog' })).toEqual([`${H}.R`]);
    expect(slices({ cmd: "grep 'a|b' /var/log/syslog" })).toEqual([`${H}.R`]);
    expect(slices({ cmd: 'uptime # how long' })).toEqual([`${H}.R`]);
    // The quote sits inside a comment : the shell runs `touch` on the next line.
    expect(slices({ cmd: "uptime #'\ntouch /tmp/x #'" })).toEqual([`${H}.R`, `${H}.W`]);
    // `a#b` is one word, not a comment.
    expect(slices({ cmd: 'grep a#b /var/log/syslog; rm -rf /srv/old' })).toEqual([
      `${H}.R`,
      `${H}.W`,
      `${H}.destructive.W`,
    ]);
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
    expect(decision).toMatchObject({
      outcome: 'denied',
      code: 'risk-not-accepted',
      missing_risks: ['ssh[prod].exec-destructive'],
      covered_risks: ['ssh[prod].exec-write'],
    });
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

  test.each([
    ['unlabelled', unlabelled, 'ssh.exec-write'],
    ['labelled outside dev / staging / prod', { ...unlabelled, env: 'qa' }, 'ssh[qa].exec-write'],
  ])(
    'a write on a host that is %s is refused whatever the mission accepts — the owner must label it',
    (_label, host, refused) => {
      const out = classifySsh('ssh__exec', { cmd: 'touch /tmp/x' }, [host]);
      if ('denied' in out) throw new Error(out.denied);
      const decision = evaluateCall({
        executed_slices: out.slices,
        token_accepted_risks: new Set([
          'ssh.exec-write',
          'ssh[dev].exec-write',
          'ssh[staging].exec-write',
          'ssh[prod].exec-write',
          'ssh[qa].exec-write',
          'ssh.uncategorized-write',
        ]),
        catalog: indexed,
        envResolver: resourceEnvResolver([host]),
      });
      expect(decision).toMatchObject({
        outcome: 'denied',
        code: 'risk-not-accepted',
        missing_risks: [refused],
        covered_risks: [],
      });
      // A read is not env-scoped : the same host can still be inspected.
      const read = classifySsh('ssh__exec', { cmd: 'uptime' }, [host]);
      if ('denied' in read) throw new Error(read.denied);
      expect(
        evaluateCall({
          executed_slices: read.slices,
          token_accepted_risks: new Set(['ssh.exec-read']),
          catalog: indexed,
          envResolver: resourceEnvResolver([host]),
        }).outcome,
      ).toBe('allowed');
    },
  );
});

// ─── missions from macro-actions, evaluated ──────────────────────────────────

describe('missions from macro-actions — evaluated through the policy engine, not just listed', () => {
  const indexed = indexCatalog(sshPlugin.catalog);
  type Verdict = 'auto' | 'approval' | 'denied';
  const ENVS = ['dev', 'staging', 'prod'];

  /** A mission holding exactly these lines. */
  const linesOf = (crans: MacroActionCranChoice): MissionPolicyEntry[] =>
    policyFromMacroActions(sshPlugin, crans, { envs: ENVS });
  /** Only the plain read : the narrowest mission. */
  const READ_ONLY: MissionPolicyEntry[] = [
    {
      risk_id: 'ssh.exec-read',
      quota: 2000,
      rate_limit: { max: 120, window_seconds: 60 },
      gate: 'auto',
    },
  ];

  /** What a mission holding exactly `policy` does with `cmd` on `host`. */
  const verdict = (policy: readonly MissionPolicyEntry[], cmd: string, host: Resource): Verdict => {
    const out = classifySsh('ssh__exec', { cmd }, [host]);
    if ('denied' in out) return 'denied';
    const decision = evaluateCall({
      executed_slices: out.slices,
      token_accepted_risks: new Set(policy.map((e) => e.risk_id)),
      catalog: indexed,
      envResolver: resourceEnvResolver([host]),
    });
    if (decision.outcome === 'denied') return 'denied';
    const gates = decision.risks_touched.map((id) => policy.find((e) => e.risk_id === id)?.gate);
    return gates.includes('approval') ? 'approval' : 'auto';
  };

  const HOSTS: readonly Resource[] = [dev, staging, prod, unlabelled];

  const INSPECTION = [
    'uptime',
    'journalctl -u nginx -n 50 --no-pager',
    'sudo systemctl status nginx',
    'ls -la /srv | grep app',
    'cat /etc/hostname',
    'docker ps',
    'docker logs --tail 100 web',
    'grep -rn error /var/log/nginx',
    'df -h && free -m',
  ];

  const NEVER_A_READ = [
    'touch /tmp/x',
    'ls > /tmp/listing',
    'rm -rf /srv/old',
    'sudo ls /srv',
    'cat /etc/shadow',
    'cat .ssh/id_ed25519',
    'cat .env',
    'docker inspect web',
    'grep -r token /srv/app',
    'grep . </etc/shadow',
    'journalctl --vacuum-time=1s',
    'sudo journalctl --rotate --vacuum-size=1',
    "grep x /etc/hostname #'\ntouch /tmp/pwned #'",
    "grep $'a\\'' ; touch /tmp/pwned #'",
    'grep -c root /etc/hostname >&2file',
    'sudo systemctl status -H root@other-host nginx',
    'echo $(id)',
    "bash -c 'uptime'",
    '/bin/ls',
  ];

  test.each(INSPECTION)('look, at any cran, runs the inspection %j freely on every host', (cmd) => {
    for (const cran of ['prudent', 'confiant', 'autonome'] as const) {
      for (const host of HOSTS) {
        expect(
          verdict(linesOf({ look: cran }), cmd, host),
          `${cran} on ${host.env ?? 'unlabelled'}`,
        ).toBe('auto');
      }
    }
  });

  test.each(NEVER_A_READ)(
    'the plain read refuses %j on every host ; look at Prudent never runs it freely',
    (cmd) => {
      for (const host of HOSTS) {
        expect(verdict(READ_ONLY, cmd, host), host.env ?? 'unlabelled').toBe('denied');
        expect(verdict(linesOf({ look: 'prudent' }), cmd, host), host.env ?? 'unlabelled').not.toBe(
          'auto',
        );
      }
    },
  );

  test('fix at Prudent : plain writes ask first on dev and staging, nothing on prod ; service control runs freely', () => {
    const policy = linesOf({ look: 'prudent', fix: 'prudent' });
    for (const cmd of ['touch /tmp/x', 'git pull --ff-only', './deploy.sh', 'bash deploy.sh']) {
      expect(verdict(policy, cmd, dev), cmd).toBe('approval');
      expect(verdict(policy, cmd, staging), cmd).toBe('approval');
      expect(verdict(policy, cmd, prod), cmd).toBe('denied');
      expect(verdict(policy, cmd, unlabelled), cmd).toBe('denied');
    }
  });

  test('fix at Autonome : plain writes and service control run freely off prod and ask first on prod', () => {
    const policy = linesOf({ look: 'prudent', fix: 'autonome' });
    for (const cmd of [
      'touch /tmp/x',
      'git pull --ff-only',
      'systemctl restart app',
      'kill 1234',
    ]) {
      expect(verdict(policy, cmd, dev), cmd).toBe('auto');
      expect(verdict(policy, cmd, staging), cmd).toBe('auto');
      expect(verdict(policy, cmd, prod), cmd).toBe('approval');
    }
  });

  test.each([
    'rm -rf /srv/old',
    '/bin/rm -rf /srv/old',
    '(rm -rf /srv/old)',
    '{ rm -rf /srv/old; }',
    'env rm -rf /srv/old',
    'command rm -rf /srv/old',
    'nohup rm -rf /srv/old &',
    "bash -c 'rm -rf /srv/old'",
    'echo $(rm -rf /srv/old)',
    'ls | xargs rm -rf',
    'find /srv -delete',
    'find /srv -exec rm {} +',
    'sudo ls /root',
    '/usr/bin/sudo ls /srv',
    'sudo -n rm -rf /srv/old',
    'apt-get install -y nginx',
    '/usr/bin/apt-get install -y nginx',
    'apt-get --yes install nginx',
    'npm install -g pm2',
    'cat .ssh/id_ed25519',
    'cat /etc/shadow',
    'docker exec web sh',
    'ssh other-host uptime',
    'systemctl poweroff',
    "python3 -c 'print(1)'",
  ])('fix at Prudent, without look or install, refuses %j on dev and on staging', (cmd) => {
    const policy = linesOf({ fix: 'prudent' });
    expect(verdict(policy, cmd, dev)).toBe('denied');
    expect(verdict(policy, cmd, staging)).toBe('denied');
  });

  test('everything at Autonome : the classes that hurt and every prod write still ask first', () => {
    const policy = linesOf({ look: 'prudent', fix: 'autonome', install: 'autonome' });
    const table: ReadonlyArray<readonly [string, Verdict, Verdict, Verdict]> = [
      ['touch /tmp/x', 'auto', 'auto', 'approval'],
      // Irreversible : asked first at every cran.
      ['rm -rf /srv/old', 'approval', 'approval', 'approval'],
      ['/bin/rm -rf /srv/old', 'approval', 'approval', 'approval'],
      ['apt-get --yes install nginx', 'auto', 'auto', 'approval'],
      ['/usr/bin/apt-get install -y nginx', 'auto', 'auto', 'approval'],
      ['systemctl restart app', 'auto', 'auto', 'approval'],
      ['sudo systemctl restart app', 'auto', 'auto', 'approval'],
      ['sudo -n true', 'auto', 'auto', 'approval'],
      // A credential-file read asks first at Prudent.
      ['cat /etc/shadow', 'approval', 'approval', 'approval'],
      ['cat .env', 'approval', 'approval', 'approval'],
      // An opaque line carries the credential-file marker too.
      ["bash -c 'make build'", 'approval', 'approval', 'approval'],
      ['echo $(date)', 'approval', 'approval', 'approval'],
    ];
    for (const [cmd, onDev, onStaging, onProd] of table) {
      expect(verdict(policy, cmd, dev), `${cmd} on dev`).toBe(onDev);
      expect(verdict(policy, cmd, staging), `${cmd} on staging`).toBe(onStaging);
      expect(verdict(policy, cmd, prod), `${cmd} on prod`).toBe(onProd);
    }
    // On an unlabelled host no write risk qualifies ; a credential-file read is not a write.
    for (const [cmd] of table) {
      const readOnly = cmd === 'cat /etc/shadow' || cmd === 'cat .env';
      expect(verdict(policy, cmd, unlabelled), `${cmd} on an unlabelled host`).toBe(
        readOnly ? 'approval' : 'denied',
      );
    }
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

  test('every spelling of an output redirection ; a duplication only when the descriptor is the whole word', () => {
    for (const line of ['ls >| f', 'ls <> f', 'ls >& f', 'ls >&f', 'ls >&2file', 'ls &>> f']) {
      expect(splitCommandLine(line).redirection, line).toBe(true);
    }
    for (const line of ['ls <&3', 'ls 2>&1;', 'ls >&2|cat', 'ls 3>&-']) {
      expect(splitCommandLine(line).redirection, line).toBe(false);
      expect(splitCommandLine(line).opaque, line).toEqual([]);
    }
    expect(splitCommandLine('tee >(cat)').substitution).toBe(true);
    expect(splitCommandLine('ls >').malformed).toBe(true);
    expect(splitCommandLine('ls > > f').malformed).toBe(true);
  });

  test('comments, continuations, grouping, escapes inside double quotes', () => {
    expect(splitCommandLine('a # b; c\nd').commands).toEqual(['a', 'd']);
    expect(splitCommandLine('a#b; c').commands).toEqual(['a#b', 'c']);
    expect(splitCommandLine('a \\\n b').commands).toEqual(['a \\\n b']);
    expect(splitCommandLine('(a; b) && { c; }').commands).toEqual(['a', 'b', '{ c', '}']);
    expect(splitCommandLine('echo "a\\"b;c"').commands).toEqual(['echo "a\\"b;c"']);
    expect(splitCommandLine('echo "a\\"b;c"').malformed).toBe(false);
    expect(splitCommandLine('echo a\\').malformed).toBe(true);
  });

  test('names what it cannot see through', () => {
    expect(splitCommandLine('ls').opaque).toEqual([]);
    expect(splitCommandLine('ls <<EOF').opaque).toEqual(['here-document']);
    expect(splitCommandLine('ls <<< x').opaque).toEqual(['here-document']);
    expect(splitCommandLine('cat <&word').opaque).toEqual(['redirection']);
    expect(splitCommandLine('ls >&2file').opaque).toEqual(['redirection']);
    expect(splitCommandLine('ls >&2-').opaque).toEqual(['redirection']);
    expect(splitCommandLine('rm >&--rf x').opaque).toEqual(['redirection']);
    expect(splitCommandLine('rm >& -rf x').opaque).toEqual(['redirection']);
    expect(splitCommandLine('ls >&file').opaque).toEqual([]);
    expect(splitCommandLine("echo $'x'").opaque).toEqual(['ansi-c-quoting']);
    expect(splitCommandLine('echo $"x"').opaque).toEqual(['ansi-c-quoting']);
    expect(splitCommandLine('echo "$"').opaque).toEqual([]);
    expect(splitCommandLine('echo ${x:-y} ${x%.*} $x $? "$1"').opaque).toEqual([]);
    expect(splitCommandLine('echo ${x:-y z}').opaque).toEqual(['parameter-expansion']);
    expect(splitCommandLine('echo ${x:-"}"; rm -rf / #}').opaque).toContain('parameter-expansion');
    expect(splitCommandLine('echo ${x').opaque).toEqual(['malformed']);
    expect(splitCommandLine('echo $[1+1]').opaque).toEqual(['substitution']);
    expect(splitCommandLine('ls\u0000').opaque).toEqual(['control-character']);
    expect(splitCommandLine('ls\r').opaque).toEqual(['control-character']);
    expect(splitCommandLine('ls\t-la').opaque).toEqual([]);
  });

  test('a backslash-newline is transparent after a blank, opaque when glued to a token', () => {
    // The shell deletes it before reading tokens, so `$\<newline>'…'` is ANSI-C quoting.
    expect(splitCommandLine('docker ps \\\n --all').opaque).toEqual([]);
    expect(splitCommandLine('ls &&\\\nuptime').opaque).toEqual(['line-continuation']);
    expect(splitCommandLine("grep $\\\n'a' f").opaque).toEqual(['line-continuation']);
    expect(splitCommandLine('echo "$\\\n(id)"').opaque).toEqual(['line-continuation']);
    expect(splitCommandLine('r\\\nm -rf /').opaque).toEqual(['line-continuation']);
    expect(splitCommandLine('ls <\\\n(id)').opaque).toEqual(['line-continuation', 'malformed']);
    // Inside single quotes it is two ordinary characters.
    expect(splitCommandLine("grep 'a\\\nb' f").opaque).toEqual([]);
  });
});

describe('lexCommandLine — words as the shell builds them', () => {
  const argv = (line: string): string[][] =>
    lexCommandLine(line).commands.map((c) => c.words.map((w) => w.value));

  test('quotes and backslashes are removed, adjacent pieces are one word', () => {
    expect(argv(`r"m" -'r'f \\/tmp/x ''`)).toEqual([['rm', '-rf', '/tmp/x', '']]);
    expect(argv('echo "a b" c\\ d')).toEqual([['echo', 'a b', 'c d']]);
    expect(argv('echo "x\\$y" "x\\ny"')).toEqual([['echo', 'x$y', 'x\\ny']]);
  });

  test('a descriptor number glued to a redirection is not an argument ; targets are kept apart', () => {
    const [command] = lexCommandLine('echo 3 2>err >out <in').commands;
    expect(command?.words.map((w) => w.value)).toEqual(['echo', '3']);
    expect(command?.redirects.map((r) => [r.kind, r.target.value])).toEqual([
      ['out', 'err'],
      ['out', 'out'],
      ['in', 'in'],
    ]);
    // Quoted or escaped digits are a word : bash runs the command `2`.
    expect(argv("''2>f")).toEqual([['2']]);
    expect(argv('\\2>f')).toEqual([['2']]);
    expect(argv('"2">f x')).toEqual([['2', 'x']]);
    expect(argv('2"">f x')).toEqual([['2', 'x']]);
    // After `>&` the `-` is consumed alone, as bash does : the rest is an argument.
    expect(argv('rm >&--rf x')).toEqual([['rm', '-rf', 'x']]);
    expect(argv('2>f')).toEqual([[]]);
  });

  test('flags what the shell would rewrite : expansions, globs, braces — unless quoted', () => {
    const word = (text: string) => lexCommandLine(`x ${text}`).commands[0]!.words[1]!;
    expect(word('$HOME/x').expansion).toBe(true);
    expect(word('"${HOME}"').expansion).toBe(true);
    expect(word("'$HOME'").expansion).toBe(false);
    expect(word('\\$HOME').expansion).toBe(false);
    expect(hasGlob(word('*.log'))).toBe(true);
    expect(hasGlob(word('a?[bc]'))).toBe(true);
    expect(hasGlob(word("'*.log'"))).toBe(false);
    expect(hasGlob(word('\\*'))).toBe(false);
    expect(hasBrace(word('{a,b}'))).toBe(true);
    expect(hasBrace(word('"{a,b}"'))).toBe(false);
    expect(hasBrace(word('{}'))).toBe(false);
  });
});

describe('the read allow-list matches whole commands', () => {
  test.each([
    ['ls -la /srv', true],
    ['ls', true],
    ['ls /srv /tmp', false],
    ['ls; ls', false],
    ['ls > f', false],
    ['ls 2>&1', true],
    ['/bin/ls', false],
    ['./ls', false],
    ['ls $HOME', false],
    ['ls *.log', false],
    ['X=1 ls', false],
    ['cat /etc/hostname', true],
    ['cat -n /etc/hostname', false],
    ['cat /etc/hostname /etc/os-release', false],
    ['tail -n 50 /var/log/syslog', true],
    ['tail -f /var/log/syslog', true],
    ['tail -n 50', false],
    ['head -20 /var/log/syslog', true],
    ['journalctl', true],
    ['journalctl -u nginx -n 50 --since yesterday', true],
    ['journalctl -xeu nginx', true],
    ['journalctl _SYSTEMD_UNIT=nginx.service', true],
    ['journalctl --vacuum-time=1s', false],
    ['journalctl --rotate', false],
    ['journalctl --flush', false],
    ['journalctl -D /mnt/x', false],
    ['journalctl --file=/tmp/x.journal', false],
    ['journalctl -M web', false],
    ['sudo journalctl -u nginx', true],
    ['sudo -n journalctl -u nginx', false],
    ['sudo cat /etc/hostname', false],
    ['grep -c error /var/log/syslog', true],
    ['grep -e a -e b /var/log/syslog', true],
    ['grep', false],
    ['grep --unknown x f', false],
    ['pgrep -fa nginx', true],
    ['pgrep -u www-data nginx', true],
    ['pgrep --ns 1 nginx', false],
    ['ps', true],
    ['ps -ef', true],
    ['ps aux', false],
    ['docker ps --all', true],
    ['docker ps -a', false],
    ['docker logs --since 1h web', true],
    ['docker logs web db', false],
    ['docker inspect web', true],
    ['docker inspect', false],
    ['docker exec web ls', false],
    ['systemctl status nginx', true],
    ['systemctl is-active nginx --quiet', true],
    ['systemctl list-units --type=service --state=failed', true],
    ["systemctl status 'nginx*'", true],
    ['systemctl status nginx*', false],
    ['systemctl --no-pager status nginx', false],
    ['systemctl status -H other nginx', false],
    ['systemctl status --machine=web nginx', false],
    ['systemctl restart nginx', false],
    ['sudo systemctl status nginx', true],
    ['df -h', true],
    ['df -h /', false],
    ['free -m', true],
    ['uptime', true],
    ['uptime -p', false],
    ['who', true],
    ['ss -tlnp', true],
    ['sudo ss -tlnp', true],
    ['ss -K dst 10.0.0.1', false],
    ['md5sum /usr/bin/ssh', true],
    ['stat /etc/hostname', true],
    ['stat -c %a /etc/hostname', false],
  ])('isReadAllowed(%j) === %s', (cmd, expected) => {
    expect(isReadAllowed(cmd)).toBe(expected);
  });

  test('parseOptions : clusters, glued and separate values, `--`, the two modes', () => {
    const spec = { flags: 'ab', valued: 'n', longFlags: ['all'], longValued: ['lines'] };
    expect(
      parseOptions(['-ab', '-n5', '-n', '6', '--all', '--lines=7', 'x'], spec, 'interleaved'),
    ).toEqual({ seen: ['a', 'b', 'n', 'n', 'all', 'lines'], operands: ['x'] });
    expect(parseOptions(['x', '-a', 'y'], spec, 'interleaved')?.operands).toEqual(['x', 'y']);
    expect(parseOptions(['-a', 'x', '-z', 'y'], spec, 'leading')?.operands).toEqual([
      'x',
      '-z',
      'y',
    ]);
    expect(parseOptions(['-a', '--', '-z'], spec, 'interleaved')?.operands).toEqual(['-z']);
    expect(parseOptions(['-z'], spec, 'interleaved')).toBeNull();
    expect(parseOptions(['-az'], spec, 'interleaved')).toBeNull();
    expect(parseOptions(['--all=1'], spec, 'interleaved')).toBeNull();
    expect(parseOptions(['--other'], spec, 'interleaved')).toBeNull();
    expect(parseOptions(['-n'], spec, 'interleaved')).toBeNull();
    expect(parseOptions(['--lines'], spec, 'interleaved')).toBeNull();
    expect(parseOptions(['-5'], spec, 'interleaved')).toBeNull();
    expect(parseOptions(['-5'], { numeric: true }, 'interleaved')).toEqual({
      seen: [],
      operands: [],
    });
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
    ['userdel bob', true],
    ['wipefs -a /dev/sdb', true],
    ['truncate -s 0 /var/log/app.log', true],
    ['ip6tables --flush', true],
    ['nft flush ruleset', true],
    ['ufw reset', true],
    ['docker rmi image', true],
    ['docker image prune -f', true],
    ['docker container rm -f web', true],
    ['docker network rm net', true],
    ['docker compose down -v', true],
    ['docker compose down', false],
    ['docker-compose rm -f', true],
    ['kill -1 1', true],
    ['pkill -1 -f node', true],
    ['kill 1234', false],
    ['telinit 6', true],
    ['systemctl poweroff', true],
    ['systemctl reboot', true],
    ['systemctl halt', true],
    ['systemctl restart nginx', false],
    ['journalctl --vacuum-size=1M', true],
    ['journalctl -u nginx', false],
    ['find / -delete', true],
    ['find / -name core', false],
    ['rsync -a --delete src/ dst/', true],
    ['rsync -a src/ dst/', false],
    // The command word is normalised before the detector looks at it.
    ['/bin/rm -rf x', true],
    ['./rm -rf x', true],
    ["'rm' -rf x", true],
    ['\\rm -rf x', true],
    ['RM -rf x', true],
    ['sudo -n rm -rf x', true],
    ['env -i nohup nice -n 5 rm -rf x', true],
    ['xargs rm', false],
    // A command word that is not a literal cannot be cleared.
    ['$RM -rf x', true],
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
    ['aptitude install vim', true],
    ['microdnf install vim', true],
    ['zypper -n in vim', true],
    ['apk del curl', true],
    ['rpm -e vim', true],
    ['snap refresh', true],
    ['pipx upgrade black', true],
    ['pnpm add -g serve', true],
    ['bun add -g serve', true],
    ['yarn global remove serve', true],
    ['apt-get --yes install nginx', true],
    ['apt-get -qq -y install nginx', true],
    ['apt-get -o Dpkg::Options::=--force-confold install nginx', true],
    ['/usr/bin/apt-get install nginx', true],
    ['sudo -E apt install nginx', true],
    ['dpkg --configure -a', true],
    ['apt-get update', false],
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
    ['podman restart web', true],
    ['podman-compose up', true],
    ['killall node', true],
    ['supervisorctl shutdown', true],
    ['systemctl mask nginx', true],
    ['/usr/bin/systemctl restart nginx', true],
    ['/bin/kill -9 1234', true],
    ['docker container stop web', true],
    ['docker compose -f prod.yml up -d', true],
    ['docker service scale web=3', true],
    ['docker service ls', false],
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
      opaque: [],
    });
    expect(profileCommandLine(';')).toBeNull();
  });

  test('stripPrivilegePrefix : sudo / doas / pkexec with their options, `--`, assignments ; su is not looked into', () => {
    expect(stripPrivilegePrefix('ls -la')).toEqual({ inner: 'ls -la', privileged: false });
    expect(stripPrivilegePrefix('sudo -u postgres psql -c "select 1"')).toEqual({
      inner: 'psql -c select 1',
      privileged: true,
    });
    expect(stripPrivilegePrefix('sudo -n rm -rf /')).toEqual({
      inner: 'rm -rf /',
      privileged: true,
    });
    expect(stripPrivilegePrefix('sudo -- rm -rf /')).toEqual({
      inner: 'rm -rf /',
      privileged: true,
    });
    expect(stripPrivilegePrefix('/usr/bin/sudo FOO=1 id')).toEqual({
      inner: 'id',
      privileged: true,
    });
    expect(stripPrivilegePrefix('doas -u www ls')).toEqual({ inner: 'ls', privileged: true });
    expect(stripPrivilegePrefix('pkexec --user root id')).toEqual({
      inner: 'id',
      privileged: true,
    });
    expect(stripPrivilegePrefix('su - root')).toEqual({ inner: 'su - root', privileged: true });
    expect(stripPrivilegePrefix('sudo su -')).toEqual({ inner: 'sudo su -', privileged: true });
    // An option that hands the command to a shell : nothing reliable inside.
    expect(stripPrivilegePrefix('sudo -i')).toEqual({ inner: 'sudo -i', privileged: true });
  });

  test('every privilege wrapper adds the privilege marker next to the classes of what it runs', () => {
    const profile = (cmd: string) => profileCommandLine(cmd);
    expect(profile('doas rm -rf /srv/old')).toMatchObject({
      destructive: true,
      privilege: true,
      opaque: [],
    });
    expect(profile('pkexec apt-get install nginx')).toMatchObject({
      packageInstall: true,
      privilege: true,
      opaque: [],
    });
    expect(profile('sudo -u deploy touch /tmp/x')).toMatchObject({
      write: true,
      destructive: false,
      privilege: true,
      opaque: [],
    });
    expect(profile('touch /tmp/x')).toMatchObject({ privilege: false });
    expect(profile('su - deploy')?.opaque).toEqual(['indirect-command']);
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
    // `required` defaults to true ; only an explicit `false` makes a field optional.
    for (const name of ['host', 'user', 'host_key_fingerprint']) {
      expect(spec.fields.find((f) => f.name === name)?.required, name).not.toBe(false);
    }
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

  test('errors raised by the transport propagate unchanged : auth, host key mismatch, timeout', async () => {
    const { UpstreamAuthError } = await import('@vaubaan/plugin-sdk');
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

  test('a rejected key fails discovery with the typed authentication error', async () => {
    const { UpstreamAuthError } = await import('@vaubaan/plugin-sdk');
    const plugin = createSshPlugin({
      transport: fakeTransport(() => new UpstreamAuthError('authentication failed', 401)),
    });
    await expect(plugin.discoverResources(connCtx())).rejects.toMatchObject({
      name: 'UpstreamAuthError',
      upstreamStatus: 401,
    });
  });

  test('a host key mismatch raised by the transport fails discovery with the typed error', async () => {
    // The mismatch itself is produced by the real transport in `host-key-pinning.test.ts`.
    const plugin = createSshPlugin({
      transport: fakeTransport(
        () => new SshHostKeyMismatchError(HOST, FINGERPRINT, 'SHA256:other'),
      ),
    });
    await expect(plugin.discoverResources(connCtx())).rejects.toMatchObject({
      name: 'SshHostKeyMismatchError',
      host: HOST,
      expected: FINGERPRINT,
      actual: 'SHA256:other',
    });
  });
});
