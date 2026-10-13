import type { CredentialSecret } from '@vaubaan/plugin-sdk';
import { utils as ssh2Utils } from 'ssh2';
import { describe, expect, it } from 'vitest';

import { CredentialFormatError, parseSecret, serializeSecret } from './credential-codec';
import { generateEd25519KeyPair } from './ssh-keypair';

describe('credential codec', () => {
  const secrets: CredentialSecret[] = [
    { kind: 'api-key', fields: { token: 't', team_id: 'team_a' }, metadata: { team_id: 'team_a' } },
    {
      kind: 'oauth2',
      accessToken: 'at',
      refreshToken: null,
      expiresAt: '2026-10-13T10:00:00.000Z',
      scopes: ['all'],
      metadata: {},
    },
    { kind: 'app-install', installationId: '42', metadata: {} },
    {
      kind: 'ssh-key',
      privateKeyPem: 'pem',
      publicKey: 'ssh-ed25519 AAAA comment',
      fields: { host: 'h', user: 'u' },
      metadata: { host: 'h' },
    },
  ];

  it.each(secrets)('round-trips a $kind secret', (secret) => {
    expect(parseSecret(serializeSecret(secret))).toEqual(secret);
  });

  it.each([
    ['not json', 'not JSON'],
    ['[]', 'not an object'],
    ['{"kind":"password","metadata":{}}', 'unknown kind'],
    ['{"kind":"oauth2","metadata":{},"scopes":[]}', "'accessToken' is missing"],
    ['{"kind":"api-key","fields":{"token":1},"metadata":{}}', "'fields.token' is not a string"],
    ['{"kind":"app-install","installationId":"1"}', "'metadata' is not an object"],
  ])('refuses %s', (text, reason) => {
    expect(() => parseSecret(text)).toThrow(CredentialFormatError);
    expect(() => parseSecret(text)).toThrow(reason);
  });
});

describe('ed25519 key pair for ssh-key connections', () => {
  it('produces an OpenSSH private key an SSH client reads, matching the public line', () => {
    const pair = generateEd25519KeyPair('vaubaan gateway/test');
    expect(pair.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ vaubaan-gateway-test$/);

    const privateKey = ssh2Utils.parseKey(pair.privateKeyPem);
    const publicKey = ssh2Utils.parseKey(pair.publicKey);
    if (privateKey instanceof Error) throw privateKey;
    if (publicKey instanceof Error) throw publicKey;
    expect(privateKey.type).toBe('ssh-ed25519');
    expect(privateKey.getPublicSSH().toString('base64')).toBe(pair.publicKey.split(' ')[1]);

    const message = Buffer.from('authenticate me');
    expect(publicKey.verify(message, privateKey.sign(message))).toBe(true);
  });

  it('generates a different pair every time', () => {
    const a = generateEd25519KeyPair('c');
    const b = generateEd25519KeyPair('c');
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
  });
});
