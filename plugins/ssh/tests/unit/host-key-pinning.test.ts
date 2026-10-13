/**
 * Host key pinning of the SSH plugin — "no connection without a pinned,
 * matching host key fingerprint".
 *
 * Two seams, both in the code :
 *
 *   1. `ssh2Transport.exec(target, cmd, options)` (`src/transport.ts`) takes a
 *      plain `SshTarget`. The suite points it at an in-process `ssh2.Server`
 *      listening on 127.0.0.1 with a host key generated for the test : the
 *      REAL transport, the REAL handshake, loopback only — no external host,
 *      no `ssh` binary. The server counts the authentication attempts and the
 *      commands it ran, so a refusal is proven on the server side ("nothing
 *      reached the host"), not merely by the shape of the rejection.
 *   2. `createSshPlugin({ transport })` (`src/index.ts`) takes a recording
 *      fake : it proves `execute` and `discoverResources` never reach the
 *      transport when the stored credential carries no usable pin.
 *
 * Unlike `plugin.test.ts` (fake transport only), part 1 opens a loopback
 * socket on an ephemeral port ; it is the only suite that runs the
 * `hostVerifier` of `transport.ts`. One server per test, closed in
 * `afterEach` together with every connection it accepted.
 */
import { createHash } from 'node:crypto';

import { Server, utils, type Connection } from 'ssh2';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type {
  ConnectionContext,
  CredentialSecret,
  ExecuteContext,
  Resource,
} from '@vaubaan/plugin-sdk';

import {
  createSshPlugin,
  fingerprintOf,
  hostKeyMatches,
  ssh2Transport,
  sshPlugin,
  sshTarget,
  SshHostKeyMismatchError,
  SshHostKeyNotPinnedError,
  type ExecResult,
  type SshTarget,
  type SshTransport,
} from '../../src/index.ts';

// ─── a real SSH server on loopback ───────────────────────────────────────────

const LOOPBACK = '127.0.0.1';
const TIMEOUT_MS = 5_000;

const hostKeyPair = utils.generateKeyPairSync('ed25519');
const clientKeyPair = utils.generateKeyPairSync('ed25519');

/**
 * The key blob an SSH server presents is the base64 field of its public key
 * line (`ssh-ed25519 <base64>`). Decoded and hashed here without any helper
 * of the plugin, the way `ssh-keygen -lf` prints it.
 */
function publicKeyBlob(publicKeyLine: string): Buffer {
  const base64 = publicKeyLine.trim().split(/\s+/)[1];
  if (!base64) throw new Error('unexpected public key line');
  return Buffer.from(base64, 'base64');
}

function openSshFingerprint(publicKeyLine: string): string {
  const digest = createHash('sha256').update(publicKeyBlob(publicKeyLine)).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

const REAL_PIN = openSshFingerprint(hostKeyPair.public);
/** A well-formed fingerprint that is not the server's. */
const OTHER_PIN = `SHA256:${'A'.repeat(43)}`;

interface ServerLog {
  connections: number;
  authAttempts: number;
  commands: string[];
}

let seen: ServerLog = { connections: 0, authAttempts: 0, commands: [] };
let server: Server;
let accepted: Connection[] = [];
let port = 0;

beforeEach(async () => {
  seen = { connections: 0, authAttempts: 0, commands: [] };
  accepted = [];
  server = new Server({ hostKeys: [hostKeyPair.private] }, (client) => {
    seen.connections += 1;
    accepted.push(client);
    client.on('error', () => {
      /* a client that drops the handshake resets the socket — expected */
    });
    client.on('authentication', (ctx) => {
      seen.authAttempts += 1;
      ctx.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          seen.commands.push(info.command);
          const stream = acceptExec();
          stream.write('ran\n');
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0 : the kernel picks a free ephemeral port, so parallel workers never collide.
    server.listen(0, LOOPBACK, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server did not bind a TCP port');
  }
  port = address.port;
});

afterEach(async () => {
  for (const client of accepted) client.end();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function target(hostKeyFingerprint: string): SshTarget {
  return {
    host: LOOPBACK,
    port,
    user: 'deploy',
    privateKeyPem: clientKeyPair.private,
    hostKeyFingerprint,
  };
}

/** A target as a buggy caller or a corrupted store could build it, bypassing the type. */
function forgedTarget(hostKeyFingerprint: unknown): SshTarget {
  return { ...target(OTHER_PIN), hostKeyFingerprint } as unknown as SshTarget;
}

const run = (t: SshTarget): Promise<ExecResult> =>
  ssh2Transport.exec(t, 'echo should-not-run-unpinned', { timeoutMs: TIMEOUT_MS });

// ─── 1. the real transport ───────────────────────────────────────────────────

describe('ssh2Transport — the host key is verified against the pin before anything else', () => {
  test('control : the matching pin connects, authenticates and runs the command', async () => {
    const result = await run(target(REAL_PIN));
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toBe('ran\n');
    expect(seen.authAttempts).toBeGreaterThan(0);
    expect(seen.commands).toEqual(['echo should-not-run-unpinned']);
  });

  test('the pin with base64 padding is the same pin', async () => {
    await expect(run(target(`${REAL_PIN}=`))).resolves.toMatchObject({ exit_code: 0 });
    expect(seen.commands).toHaveLength(1);
  });

  test('the plugin computes the same fingerprint as OpenSSH for the presented key', () => {
    const blob = publicKeyBlob(hostKeyPair.public);
    expect(fingerprintOf(blob)).toBe(REAL_PIN);
    expect(hostKeyMatches(REAL_PIN, blob)).toBe(true);
  });

  test('a well-formed pin of another key is refused : typed error, no authentication, no command', async () => {
    const error = await run(target(OTHER_PIN)).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(SshHostKeyMismatchError);
    expect(error).toMatchObject({
      name: 'SshHostKeyMismatchError',
      host: LOOPBACK,
      expected: OTHER_PIN,
      actual: REAL_PIN,
    });
    // The server was reached (TCP + key exchange) but never asked to authenticate
    // the user, and never ran anything : the key pair was not even offered.
    expect(seen.connections).toBe(1);
    expect(seen.authAttempts).toBe(0);
    expect(seen.commands).toEqual([]);
  });

  test.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['undefined', undefined],
    ['null (the v4 "no pin" value)', null],
    ['the bare prefix', 'SHA256:'],
    ['a wildcard', '*'],
    ['a truncated copy of the real pin', REAL_PIN.slice(0, -1)],
    ['the real pin in another case', REAL_PIN.toLowerCase()],
    ['the real digest without the SHA256: prefix', REAL_PIN.slice('SHA256:'.length)],
    ['an MD5 fingerprint', 'MD5:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'],
    ['a boolean', true],
    ['an object', { toString: () => REAL_PIN }],
  ])(
    'a target whose pin is %s never connects : no socket, no authentication, no command',
    async (_label, pin) => {
      await expect(run(forgedTarget(pin))).rejects.toBeInstanceOf(SshHostKeyNotPinnedError);
      expect(seen.connections).toBe(0);
      expect(seen.authAttempts).toBe(0);
      expect(seen.commands).toEqual([]);
    },
  );

  test('the mismatch is logged with the host, the pin and the key presented', async () => {
    const errors: Array<{ message: string; fields: unknown }> = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message: string, fields?: unknown) => {
        errors.push({ message, fields });
      },
    };
    await expect(
      ssh2Transport.exec(target(OTHER_PIN), 'uptime', { timeoutMs: TIMEOUT_MS, logger }),
    ).rejects.toBeInstanceOf(SshHostKeyMismatchError);
    expect(errors).toEqual([
      {
        message: 'ssh host key mismatch',
        fields: { host: LOOPBACK, expected: OTHER_PIN, actual: REAL_PIN },
      },
    ]);
  });

  test('a signal aborted before the call rejects without opening a socket', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      ssh2Transport.exec(target(REAL_PIN), 'uptime', {
        timeoutMs: TIMEOUT_MS,
        signal: controller.signal,
      }),
    ).rejects.toThrow('ssh command aborted by the gateway.');
    expect(seen.connections).toBe(0);
  });

  test('there is no trust on first use : a refused host is refused again', async () => {
    await expect(run(target(OTHER_PIN))).rejects.toBeInstanceOf(SshHostKeyMismatchError);
    await expect(run(target(OTHER_PIN))).rejects.toBeInstanceOf(SshHostKeyMismatchError);
    expect(seen.connections).toBe(2);
    expect(seen.authAttempts).toBe(0);
    expect(seen.commands).toEqual([]);
  });

  test('hostKeyMatches is false for every non-pin value, whatever the key', () => {
    const key = Buffer.from('any key blob');
    for (const pin of ['', ' ', 'SHA256:', '*', 'garbage', OTHER_PIN]) {
      expect(hostKeyMatches(pin, key), JSON.stringify(pin)).toBe(false);
    }
    for (const pin of [undefined, null, 0, true, {}]) {
      expect(hostKeyMatches(forgedTarget(pin).hostKeyFingerprint, key), String(pin)).toBe(false);
    }
  });
});

// ─── 2. execute / discoverResources never reach the transport without a pin ──

const HOST = 'vps-1.example.com';
const resource: Resource = {
  provider: 'ssh',
  ref: HOST,
  env: 'staging',
  displayName: `deploy@${HOST}:22`,
};

function recordingTransport(): SshTransport & { calls: SshTarget[] } {
  const calls: SshTarget[] = [];
  return {
    calls,
    exec(t) {
      calls.push(t);
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exit_code: 0,
        duration_ms: 1,
        truncated: false,
      });
    },
  };
}

function credentialWith(fields: Record<string, string>): CredentialSecret {
  return {
    kind: 'ssh-key',
    privateKeyPem: clientKeyPair.private,
    publicKey: clientKeyPair.public,
    fields,
    metadata: {},
  };
}

const BASE_FIELDS = { host: HOST, port: '22', user: 'deploy' };
const noFetch = (): Promise<never> => Promise.reject(new Error('ssh plugin must not use fetch'));

const UNPINNED: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['no host_key_fingerprint field', { ...BASE_FIELDS }],
  ['an empty host_key_fingerprint', { ...BASE_FIELDS, host_key_fingerprint: '' }],
  ['a blank host_key_fingerprint', { ...BASE_FIELDS, host_key_fingerprint: '   ' }],
  ['the bare SHA256: prefix', { ...BASE_FIELDS, host_key_fingerprint: 'SHA256:' }],
  ['a wildcard', { ...BASE_FIELDS, host_key_fingerprint: '*' }],
  ['an MD5 fingerprint', { ...BASE_FIELDS, host_key_fingerprint: 'MD5:aa:bb:cc' }],
  ['a too-short digest', { ...BASE_FIELDS, host_key_fingerprint: `SHA256:${'A'.repeat(42)}` }],
];

describe('plugin.execute / discoverResources — a credential without a pin never reaches the transport', () => {
  test.each(UNPINNED)('execute refuses a credential with %s', async (_label, fields) => {
    const transport = recordingTransport();
    const plugin = createSshPlugin({ transport });
    const ctx: ExecuteContext = {
      credential: credentialWith(fields),
      appConfig: {},
      fetch: noFetch,
      resources: [resource],
    };
    await expect(plugin.execute(ctx, 'ssh__exec', { cmd: 'uptime' })).rejects.toThrow(
      /'host_key_fingerprint' is missing or is not a 'SHA256:…' fingerprint/,
    );
    expect(transport.calls).toHaveLength(0);
  });

  test.each(UNPINNED)('discoverResources refuses a credential with %s', async (_label, fields) => {
    const transport = recordingTransport();
    const plugin = createSshPlugin({ transport });
    const ctx: ConnectionContext = {
      credential: credentialWith(fields),
      appConfig: {},
      fetch: noFetch,
    };
    await expect(plugin.discoverResources(ctx)).rejects.toThrow(/'host_key_fingerprint'/);
    expect(transport.calls).toHaveLength(0);
  });

  test('sshTarget never yields a target without a normalised SHA256 pin', () => {
    for (const [, fields] of UNPINNED) {
      expect(() => sshTarget(credentialWith(fields))).toThrow(/'host_key_fingerprint'/);
    }
    const pinned = sshTarget(credentialWith({ ...BASE_FIELDS, host_key_fingerprint: REAL_PIN }));
    expect(pinned.hostKeyFingerprint).toBe(REAL_PIN);
  });

  test('the pin the transport receives is the pin of the credential, on every call', async () => {
    const transport = recordingTransport();
    const plugin = createSshPlugin({ transport });
    const ctx: ExecuteContext = {
      credential: credentialWith({ ...BASE_FIELDS, host_key_fingerprint: `${REAL_PIN}=` }),
      appConfig: {},
      fetch: noFetch,
      resources: [resource],
    };
    await plugin.execute(ctx, 'ssh__exec', { cmd: 'uptime' });
    await plugin.execute(ctx, 'ssh__exec', { cmd: 'uptime' });
    await plugin.discoverResources(ctx);
    expect(transport.calls.map((t) => t.hostKeyFingerprint)).toEqual([
      REAL_PIN,
      REAL_PIN,
      REAL_PIN,
    ]);
  });
});

// ─── 3. the connect form cannot omit the pin ─────────────────────────────────

describe('credential spec — the fingerprint is a required, patterned field', () => {
  test('host_key_fingerprint is required (the host rejects the form without it) and SHA256-only', () => {
    const spec = sshPlugin.credential;
    if (spec.kind !== 'ssh-key') throw new Error('expected an ssh-key credential spec');
    const field = spec.fields.find((f) => f.name === 'host_key_fingerprint');
    expect(field).toBeDefined();
    // `required` defaults to true ; only an explicit `false` makes a field optional.
    expect(field!.required).not.toBe(false);
    expect(field!.pattern).toBeDefined();
    const pattern = new RegExp(field!.pattern!);
    expect(pattern.test(REAL_PIN)).toBe(true);
    for (const bad of [
      '',
      ' ',
      'SHA256:',
      '*',
      'SHA256:*',
      'MD5:aa:bb',
      `SHA256:${'A'.repeat(42)}`,
    ]) {
      expect(pattern.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
