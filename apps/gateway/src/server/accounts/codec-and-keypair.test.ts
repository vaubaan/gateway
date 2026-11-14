import type { CredentialSecret } from '@vaubaan/plugin-sdk';
import { utils as ssh2Utils } from 'ssh2';
import { describe, expect, it } from 'vitest';

import { CredentialFormatError, parseSecret, serializeSecret } from './credential-codec';
import { generateKeyPairSync } from 'node:crypto';

import { generateEd25519KeyPair, importEd25519PrivateKey, SshKeyImportError } from './ssh-keypair';

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
    ['{"kind":"app-install","installationId":"1","metadata":{}}', 'unknown kind'],
  ])('refuses %s', (text, reason) => {
    expect(() => parseSecret(text)).toThrow(CredentialFormatError);
    expect(() => parseSecret(text)).toThrow(reason);
  });
});

describe('ed25519 key pair for ssh-key accounts', () => {
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

describe('an existing ed25519 private key imported for an ssh-key account', () => {
  function publicHalf(line: string): string {
    return line.split(' ')[1] ?? '';
  }

  it('reads the PKCS#8 PEM v4 generated and writes the OpenSSH container', () => {
    const { privateKey } = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const pair = importEd25519PrivateKey(privateKey, 'vaubaan-gateway');
    const parsed = ssh2Utils.parseKey(pair.privateKeyPem);
    if (parsed instanceof Error) throw parsed;
    expect(parsed.type).toBe('ssh-ed25519');
    expect(parsed.getPublicSSH().toString('base64')).toBe(publicHalf(pair.publicKey));
    expect(pair.publicKey.endsWith(' vaubaan-gateway')).toBe(true);
  });

  it('reads an unencrypted OpenSSH container and keeps the same key', () => {
    const original = generateEd25519KeyPair('elsewhere');
    const pair = importEd25519PrivateKey(original.privateKeyPem, 'vaubaan-gateway');
    expect(publicHalf(pair.publicKey)).toBe(publicHalf(original.publicKey));
    const parsed = ssh2Utils.parseKey(pair.privateKeyPem);
    if (parsed instanceof Error) throw parsed;
    const message = Buffer.from('same key');
    const verifier = ssh2Utils.parseKey(original.publicKey);
    if (verifier instanceof Error) throw verifier;
    expect(verifier.verify(message, parsed.sign(message))).toBe(true);
  });

  it('refuses another key type without quoting the key', () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    expect(() => importEd25519PrivateKey(privateKey, 'c')).toThrow(SshKeyImportError);
    expect(() => importEd25519PrivateKey(privateKey, 'c')).toThrow('ec, not ed25519');
  });

  it('refuses text that is no key, and a truncated container', () => {
    expect(() => importEd25519PrivateKey('not a key', 'c')).toThrow(SshKeyImportError);
    const original = generateEd25519KeyPair('c').privateKeyPem;
    const lines = original.trim().split('\n');
    const cut = [lines[0], lines[1], lines[lines.length - 1]].join('\n');
    expect(() => importEd25519PrivateKey(cut, 'c')).toThrow(SshKeyImportError);
  });
});
