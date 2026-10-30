import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AttestationCache } from '../../src/attestation.ts';
import { createLogger } from '../../src/log.ts';
import { type PlatformAdapter, PlatformError } from '../../src/platform/types.ts';
import { parseSealingKey, TokenSealer } from '../../src/sealing.ts';

describe('refresh tokens sealed to their instance', () => {
  const sealer = new TokenSealer(randomBytes(32));

  it('opens for the same instance and provider only', () => {
    const blob = sealer.seal('i_aaaaaaaa', 'google', '1//refresh-token');
    expect(blob).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(blob).not.toContain('refresh-token');
    expect(sealer.open('i_aaaaaaaa', 'google', blob)).toBe('1//refresh-token');
    expect(sealer.open('i_bbbbbbbb', 'google', blob)).toBeUndefined();
    expect(sealer.open('i_aaaaaaaa', 'other', blob)).toBeUndefined();
  });

  it('refuses a tampered blob, a raw token, another key', () => {
    const blob = sealer.seal('i_aaaaaaaa', 'google', 'token');
    const raw = Buffer.from(blob.slice(3), 'base64url');
    raw[20] = (raw[20] ?? 0) ^ 1;
    expect(sealer.open('i_aaaaaaaa', 'google', `v1.${raw.toString('base64url')}`)).toBeUndefined();
    expect(sealer.open('i_aaaaaaaa', 'google', '1//a-raw-provider-token')).toBeUndefined();
    expect(sealer.open('i_aaaaaaaa', 'google', `v2.${blob.slice(3)}`)).toBeUndefined();
    expect(new TokenSealer(randomBytes(32)).open('i_aaaaaaaa', 'google', blob)).toBeUndefined();
  });

  it('never seals twice alike', () => {
    expect(sealer.seal('i_aaaaaaaa', 'google', 't')).not.toBe(
      sealer.seal('i_aaaaaaaa', 'google', 't'),
    );
  });

  it('reads its key as 32 bytes of base64, nothing else', () => {
    const key = randomBytes(32);
    expect(parseSealingKey(`${key.toString('base64')}\n`).equals(key)).toBe(true);
    expect(parseSealingKey(key.toString('base64url')).equals(key)).toBe(true);
    expect(() => parseSealingKey(randomBytes(16).toString('base64'))).toThrow(PlatformError);
    expect(() => parseSealingKey('not a key')).toThrow(PlatformError);
  });
});

function platform(answers: Array<'ok' | 'fail'>): PlatformAdapter & { calls: string[][] } {
  const calls: string[][] = [];
  let n = 0;
  return {
    name: 'test',
    attested: true,
    calls,
    async attest(nonces) {
      calls.push([...nonces]);
      if (answers[n++] === 'fail') throw new PlatformError('down');
      return { platform: 'test', evidence: `token-${n}` };
    },
    async unsealSecret() {
      return '';
    },
  };
}

describe('cached attestation', () => {
  const log = createLogger(() => undefined);

  it('asks the platform with the SPKI digest as the only nonce, then serves from memory', async () => {
    const p = platform(['ok']);
    const cache = new AttestationCache(p, 'spki-digest', log, { now: () => 0 });
    await cache.start();
    expect(cache.current()).toEqual({ platform: 'test', evidence: 'token-1' });
    expect(cache.current()).toEqual({ platform: 'test', evidence: 'token-1' });
    expect(p.calls).toEqual([['spki-digest']]);
    cache.stop();
  });

  it('serves nothing before a first success, and nothing too old', async () => {
    let now = 0;
    const p = platform(['fail', 'ok']);
    const cache = new AttestationCache(p, 'k', log, { now: () => now, maxAgeMs: 9 * 60_000 });
    await cache.start();
    expect(cache.current()).toBeUndefined();
    expect(await cache.refresh()).toBe(true);
    expect(cache.current()?.evidence).toBe('token-2');
    now = 9 * 60_000 + 1;
    expect(cache.current()).toBeUndefined();
    cache.stop();
  });

  it('keeps the last token when a refresh fails', async () => {
    const p = platform(['ok', 'fail']);
    const cache = new AttestationCache(p, 'k', log, { now: () => 0 });
    await cache.start();
    expect(await cache.refresh()).toBe(false);
    expect(cache.current()?.evidence).toBe('token-1');
    cache.stop();
  });

  it('refreshes in the background, sooner after a failure', async () => {
    const p = platform(['fail', 'ok', 'ok']);
    const cache = new AttestationCache(p, 'k', log, { refreshMs: 300, retryMs: 10 });
    await cache.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(p.calls.length).toBe(2); // retried after 10 ms, not 300
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(p.calls.length).toBe(3);
    cache.stop();
  });
});
