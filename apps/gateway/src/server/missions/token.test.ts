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
  it('mints vbn_live_<8>_<32>, hashed with argon2id, with the prefix in clear', async () => {
    const token = await mintMissionToken();
    expect(token.secret).toMatch(new RegExp(`^${API_KEY_PATTERN.source}$`));
    expect(token.secret.startsWith(`vbn_live_${token.prefix}_`)).toBe(true);
    expect(token.prefix).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(parseApiKey(token.secret)).toMatchObject({ kind: 'live', prefix: token.prefix });
    expect(token.hashAlg).toBe(MISSION_TOKEN_HASH_ALG);
    expect(token.hash.startsWith('$argon2id$')).toBe(true);
    expect(token.hash).not.toContain(token.secret);
  });

  it('verifies the secret against the hash and nothing else', async () => {
    const token = await mintMissionToken();
    expect(await bearerMatches(token.hash, token.secret)).toBe(true);
    expect(await bearerMatches(token.hash, `  ${token.secret}\n`)).toBe(true);
    const tampered = `${token.secret.slice(0, -1)}${token.secret.endsWith('a') ? 'b' : 'a'}`;
    expect(await bearerMatches(token.hash, tampered)).toBe(false);
    expect(await bearerMatches('not-a-hash', token.secret)).toBe(false);
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
        preset: 'developer',
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
