import { createHash } from 'node:crypto';

import { API_KEY_PATTERN, parseApiKey } from '@vaubaan/shared';
import { describe, expect, it } from 'vitest';

import { parseMissionDraft } from './draft-schema';
import {
  bearerMatches,
  maskedToken,
  mintMissionToken,
  MISSION_TOKEN_HASH_ALG,
  prefixOfBearer,
} from './token';

describe('mission token', () => {
  it('mints vbn_live_<8>_<32>, stored as its sha256 digest, with the prefix in clear', async () => {
    const token = await mintMissionToken();
    expect(token.secret).toMatch(new RegExp(`^${API_KEY_PATTERN.source}$`));
    expect(token.secret.startsWith(`vbn_live_${token.prefix}_`)).toBe(true);
    expect(token.prefix).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(parseApiKey(token.secret)).toMatchObject({ kind: 'live', prefix: token.prefix });
    expect(MISSION_TOKEN_HASH_ALG).toBe('sha256');
    expect(token.hashAlg).toBe(MISSION_TOKEN_HASH_ALG);
    expect(token.hash).toBe(createHash('sha256').update(token.secret).digest('hex'));
    expect(token.hash).not.toContain(token.secret.slice(-32));
  });

  it('verifies the secret against the digest and nothing else', async () => {
    const token = await mintMissionToken();
    expect(bearerMatches(token, token.secret)).toBe(true);
    expect(bearerMatches(token, `  ${token.secret}\n`)).toBe(true);
    const tampered = `${token.secret.slice(0, -1)}${token.secret.endsWith('a') ? 'b' : 'a'}`;
    expect(bearerMatches(token, tampered)).toBe(false);
    for (const hash of ['not-a-digest', '', token.hash.toUpperCase(), `${token.hash}\n`]) {
      expect(bearerMatches({ hash, hashAlg: 'sha256' }, token.secret), hash).toBe(false);
    }
  });

  it('never reads a hash under the wrong algorithm, nor under one it does not know', async () => {
    const token = await mintMissionToken();
    // An argon2id row of an earlier build (revoked by migration 0027) matches nothing.
    const argon = '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA';
    expect(bearerMatches({ hash: argon, hashAlg: 'argon2id' }, token.secret)).toBe(false);
    expect(bearerMatches({ hash: token.hash, hashAlg: 'argon2id' }, token.secret)).toBe(false);
    for (const hashAlg of ['', 'plain', 'md5', 'SHA256']) {
      expect(bearerMatches({ hash: token.hash, hashAlg }, token.secret), hashAlg).toBe(false);
      expect(bearerMatches({ hash: token.secret, hashAlg }, token.secret), hashAlg).toBe(false);
    }
  });

  it('never mints the same token twice', async () => {
    const [a, b] = await Promise.all([mintMissionToken(), mintMissionToken()]);
    expect(a.secret).not.toBe(b.secret);
    expect(a.hash).not.toBe(b.hash);
  });

  it('reads the lookup prefix of a live token only', async () => {
    const token = await mintMissionToken();
    expect(prefixOfBearer(token.secret)).toBe(token.prefix);
    expect(prefixOfBearer(token.secret.replace('vbn_live_', 'vbn_test_'))).toBeNull();
    expect(prefixOfBearer('Bearer nope')).toBeNull();
    expect(prefixOfBearer('')).toBeNull();
    expect(maskedToken(token.prefix)).toBe(`vbn_live_${token.prefix}_…`);
  });
});

describe('parseMissionDraft', () => {
  const valid = {
    name: 'm',
    connections: [
      {
        provider: 'github',
        trust_levels: { read: 'trusting', propose: 'careful' },
        resources: { scope: 'selected', resource_refs: ['acme/app'] },
        policy: [{ risk_id: 'github.code-read', quota: 5, gate: 'approval' }],
      },
    ],
    period: { kind: 'recurring', length_seconds: 3600 },
    expires_at: null,
  };

  it('accepts a well-formed draft', () => {
    const parsed = parseMissionDraft(valid);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.draft.connections[0]?.policy?.[0]?.gate).toBe('approval');
    expect(parsed.ok && parsed.draft.connections[0]?.trust_levels).toEqual({
      read: 'trusting',
      propose: 'careful',
    });
  });

  it('accepts the built-in everything-i-hold in place of trust levels', () => {
    const parsed = parseMissionDraft({
      ...valid,
      connections: [{ provider: 'github', everything_i_hold: true }],
    });
    expect(parsed.ok && parsed.draft.connections[0]?.everything_i_hold).toBe(true);
  });

  it('refuses a trust level that is not one of the three', () => {
    const parsed = parseMissionDraft({
      ...valid,
      connections: [{ provider: 'github', trust_levels: { read: 'reckless' } }],
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.join(' ')).toContain('connections.0.trust_levels');
  });

  it('refuses unknown keys, so a typo never drops a restriction silently', () => {
    const parsed = parseMissionDraft({
      ...valid,
      connections: [{ ...valid.connections[0], resource: { scope: 'all' } }],
    });
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.problems.join(' ')).toContain('connections.0');
  });

  it('names every malformed field', () => {
    const parsed = parseMissionDraft({
      name: 3,
      connections: [{ policy: [{ risk_id: 'a.b', gate: 'confirm' }] }],
      period: { kind: 'forever' },
    });
    expect(parsed.ok).toBe(false);
    const problems = parsed.ok ? [] : parsed.problems;
    expect(problems.some((p) => p.startsWith('name'))).toBe(true);
    expect(problems.some((p) => p.startsWith('connections.0.policy.0.gate'))).toBe(true);
    expect(problems.some((p) => p.startsWith('period'))).toBe(true);
    expect(problems.some((p) => p.startsWith('expires_at'))).toBe(true);
  });

  it('refuses anything that is not an object', () => {
    expect(parseMissionDraft(null).ok).toBe(false);
    expect(parseMissionDraft('draft').ok).toBe(false);
  });
});
