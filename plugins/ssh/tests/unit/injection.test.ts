/**
 * Identifier injection : what the arguments of `ssh__exec` — and the refs of
 * the mission's resources — may put in a slice, and what reaches the host.
 *
 * Two positions :
 *   - `host` : a slice identifier, compared with the host of the credential.
 *     It is never dialled (the transport connects to the credential's host),
 *     so the rule is that only a hostname or an IPv4 address names a host —
 *     as an argument or as the ref of the mission's single resource — and
 *     that a refused value opens no connection ;
 *   - `cmd` : the command line. The string handed to the transport is the
 *     string that was classified, character for character, and no hostile
 *     value is ever read as an inspection.
 *
 * Fed to `classify` AND to `execute`, over a recording transport.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, type ExecuteContext, type Resource } from '@vaubaan/plugin-sdk';

import {
  classifySsh,
  createSshPlugin,
  hasBrace,
  hasGlob,
  hostRef,
  lexCommandLine,
  sshTarget,
  type ExecResult,
  type SshTransport,
} from '../../src/index.ts';

const HOST = 'vps-1.example.com';
const FINGERPRINT = 'SHA256:' + 'A'.repeat(43);
const LONG = 'x'.repeat(5000);

/** The values every identifier position is fed. */
const HOSTILE: readonly string[] = [
  '..',
  '.',
  'a/../b',
  'a/b',
  '%2e%2e',
  '%2f',
  '..%2f',
  '',
  LONG,
  'a\nb',
  'a?x=1#y',
];

const resource = (ref: string): Resource => ({ service: 'ssh', ref, displayName: ref });

const credentialFor = (host: string) => ({
  kind: 'ssh-key' as const,
  privateKeyPem: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
  publicKey: 'ssh-ed25519 AAAA vaubaan-gateway',
  fields: { host, port: '22', user: 'deploy', host_key_fingerprint: FINGERPRINT },
  metadata: {},
});

function recordingTransport(): SshTransport & { calls: { host: string; cmd: string }[] } {
  const calls: { host: string; cmd: string }[] = [];
  const done: ExecResult = {
    stdout: '',
    stderr: '',
    exit_code: 0,
    duration_ms: 1,
    truncated: false,
  };
  return {
    calls,
    exec(target, cmd) {
      calls.push({ host: target.host, cmd });
      return Promise.resolve(done);
    },
  };
}

const ctx = (resources: readonly Resource[], host = HOST): ExecuteContext => ({
  credential: credentialFor(host),
  fetch: () => Promise.reject(new Error('ssh plugin must not use fetch')),
  resources,
});

/** `execute` over a recording transport ; a throw counts as a refusal. */
async function execute(
  args: Record<string, unknown>,
  resources: readonly Resource[],
): Promise<{ refused: boolean; calls: readonly { host: string; cmd: string }[] }> {
  const transport = recordingTransport();
  const plugin = createSshPlugin({ transport });
  try {
    const result = await plugin.execute(ctx(resources), 'ssh__exec', args);
    return { refused: result.isError === true, calls: transport.calls };
  } catch {
    return { refused: true, calls: transport.calls };
  }
}

const label = (value: unknown): string =>
  typeof value === 'string' && value.length > 40
    ? `a ${value.length}-character value`
    : JSON.stringify(value);

const NAMED = HOSTILE.map((value) => [label(value), value] as const);

describe('host — a hostname or an IPv4 address, nothing else', () => {
  test.each(NAMED)('the argument %s is refused, even when a resource bears it', async (_l, v) => {
    // The mission holds a resource with that very ref : membership cannot be what refuses it.
    const mission = [resource(HOST), resource(v)];
    expect(classifySsh('ssh__exec', { host: v, cmd: 'uptime' }, mission)).toHaveProperty('denied');
    const { refused, calls } = await execute({ host: v, cmd: 'uptime' }, mission);
    expect(refused).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test.each(NAMED)('a single resource whose ref is %s names no host', async (_l, v) => {
    // No `host` argument : the ref of the mission's single resource is used as it is.
    const mission = [resource(v)];
    expect(classifySsh('ssh__exec', { cmd: 'uptime' }, mission)).toHaveProperty('denied');
    const { refused, calls } = await execute({ cmd: 'uptime' }, mission);
    expect(refused).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test.each([
    'a b',
    'a]b',
    'host].command.R',
    '-oProxyCommand=id',
    '-v',
    'a_b',
    'a~b',
    'h\u0000',
    'h\r',
    ' vps-1',
    'vps-1 ',
    'vps-1.',
    '.vps-1',
    'vps/1',
    'user@vps-1',
    'vps-1:22',
    '::1',
    'vps\u200b-1',
    'vрs-1',
    'a'.repeat(254),
    42,
    null,
    ['vps-1'],
    { ref: 'vps-1' },
  ])('hostRef refuses %j, as an argument and as a resource ref', async (value) => {
    expect(hostRef(value)).toBeNull();
    const asArgument = [resource(HOST)];
    expect(classifySsh('ssh__exec', { host: value, cmd: 'uptime' }, asArgument)).toHaveProperty(
      'denied',
    );
    expect((await execute({ host: value, cmd: 'uptime' }, asArgument)).calls).toHaveLength(0);
    if (typeof value === 'string') {
      const asRef = [resource(value)];
      expect(classifySsh('ssh__exec', { cmd: 'uptime' }, asRef)).toHaveProperty('denied');
      expect((await execute({ cmd: 'uptime' }, asRef)).calls).toHaveLength(0);
    }
  });

  test.each(['vps-1.example.com', '10.0.0.7', 'localhost', 'a', 'Prod-DB.internal', '1a'])(
    'hostRef accepts %j, the slice names it and the command runs on the credential host',
    async (host) => {
      expect(hostRef(host)).toBe(host);
      const mission = [resource(host)];
      for (const args of [{ cmd: 'uptime' }, { host, cmd: 'uptime' }]) {
        const outcome = classifySsh('ssh__exec', args, mission);
        if ('denied' in outcome) throw new Error(outcome.denied);
        expect(outcome.slices.map(serializeSlice)).toEqual([`ssh.host[${host}].command.R`]);
        const transport = recordingTransport();
        const plugin = createSshPlugin({ transport });
        const result = await plugin.execute(ctx(mission, host), 'ssh__exec', args);
        expect(result.isError).toBeUndefined();
        expect(transport.calls).toEqual([{ host, cmd: 'uptime' }]);
      }
    },
  );

  test('the credential host goes through the same grammar', () => {
    for (const host of ['..', 'a/b', '-oProxyCommand=id', 'a b', '']) {
      expect(() => sshTarget(credentialFor(host))).toThrow(/field 'host'/);
    }
    expect(sshTarget(credentialFor(HOST)).host).toBe(HOST);
  });

  test('a host that is not the host of the credential opens no connection', async () => {
    const mission = [resource('10.0.0.7')];
    expect(classifySsh('ssh__exec', { cmd: 'uptime' }, mission)).toHaveProperty('slices');
    const { refused, calls } = await execute({ cmd: 'uptime' }, mission);
    expect(refused).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('cmd — what is sent is what was classified', () => {
  const mission = [resource(HOST)];

  test.each(NAMED)(
    'the command line %s is refused, or sent as it is and never as a read',
    async (_l, v) => {
      const outcome = classifySsh('ssh__exec', { cmd: v }, mission);
      const { refused, calls } = await execute({ cmd: v }, mission);
      if ('denied' in outcome) {
        expect(refused).toBe(true);
        expect(calls).toHaveLength(0);
        return;
      }
      expect(outcome.slices.map(serializeSlice)).not.toContain(`ssh.host[${HOST}].command.R`);
      expect(refused).toBe(false);
      expect(calls).toEqual([{ host: HOST, cmd: v }]);
    },
  );

  test.each([
    '  uptime  ',
    '\tuptime\n',
    'uptime\n\n',
    'ls -la /var/log\ntouch /tmp/x',
    'journalctl -u nginx --no-pager ; rm -rf /',
    "grep 'a b' /etc/hostname",
    'cat /etc/hostname # trailing comment',
    'echo été',
  ])('the line %j reaches the transport unchanged', async (cmd) => {
    expect(classifySsh('ssh__exec', { cmd }, mission)).toHaveProperty('slices');
    const { refused, calls } = await execute({ cmd }, mission);
    expect(refused).toBe(false);
    expect(calls).toEqual([{ host: HOST, cmd }]);
  });

  test.each(['', ' ', '\n', '\t \n', 'x'.repeat(16 * 1024 + 1), 42, null, ['uptime']])(
    'the command line %j runs nothing',
    async (cmd) => {
      expect(classifySsh('ssh__exec', { cmd }, mission)).toHaveProperty('denied');
      const { refused, calls } = await execute({ cmd }, mission);
      expect(refused).toBe(true);
      expect(calls).toHaveLength(0);
    },
  );
});

describe('cmd — a character outside the BMP does not hide a glob or a brace', () => {
  const mission = [resource(HOST)];
  const READ = `ssh.host[${HOST}].command.R`;
  const word = (line: string) => lexCommandLine(line).commands[0]!.words.at(-1)!;

  // `bare` holds one flag per UTF-16 unit of the word ; a quoted emoji is two
  // units, so reading the flags by code point saw the quoted half of the
  // emoji where the glob or the brace was.
  test.each(["cat '\u{1F600}'*", "ls /tmp/'\u{1F600}'?", "cat '\u{1F600}\u{1F600}'[ab]"])(
    'the glob of %j is seen',
    (line) => {
      expect(hasGlob(word(line))).toBe(true);
      const outcome = classifySsh('ssh__exec', { cmd: line }, mission);
      if ('denied' in outcome) throw new Error(outcome.denied);
      expect(outcome.slices.map(serializeSlice)).not.toContain(READ);
    },
  );

  test.each([
    "cat '\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}'{a,b}",
    "ls '\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}\u{1F600}'{,/x}",
  ])('the brace of %j is seen', (line) => {
    expect(hasBrace(word(line))).toBe(true);
    const outcome = classifySsh('ssh__exec', { cmd: line }, mission);
    if ('denied' in outcome) throw new Error(outcome.denied);
    expect(outcome.slices.map(serializeSlice)).not.toContain(READ);
  });

  test('a quoted glob after an emoji stays a literal', () => {
    expect(hasGlob(word("cat '\u{1F600}*'"))).toBe(false);
    expect(hasBrace(word("cat \u{1F600}'{a,b}'"))).toBe(false);
  });
});
