/**
 * Unit tests of the execution door's pure and in-memory parts: agent label,
 * client origin, cited refs, tool filter, verified-token cache, upstream
 * credential cache. The pipeline and the HTTP surface are covered by
 * `tests/integration/execution/`.
 */
import { MemoryCacheClient, type MissionContext } from '@vaubaan/gateway-core';
import { createRegistry } from '@vaubaan/plugin-sdk';
import { parseSlice } from '@vaubaan/policy-engine';
import { describe, expect, it, vi } from 'vitest';

import { API_KEY_SPEC, fixturePlugin } from '../connections/testing';
import type { TokenVerification } from '../missions';
import { UNKNOWN_CLIENT } from '../http/client-ip';
import { SlidingWindowRateLimiter } from '../rate-limit';
import type { MissionRecord, MissionTokenRecord } from '../store/types';
import { ConnectionCredentialCache, MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS } from './credential-cache';
import {
  AGENT_LABEL_MAX_LENGTH,
  agentLabelOf,
  clientOriginOf,
  parseAgentLabel,
  readAgentLabel,
  trustedProxyList,
} from './request-meta';
import { citedRefs } from './resource-stage';
import { depotPlugin } from './testing';
import {
  TokenVerifier,
  VERIFIED_TOKEN_TTL_SECONDS,
  VERIFY_ATTEMPTS_PER_WINDOW,
  verifiedTokenCacheKey,
} from './token-verifier';
import { callableProviders, callableTools } from './tools';

describe('agent label', () => {
  it('reads the header, and prefers the per-call _meta.agent', () => {
    const headers = new Headers({ 'x-vaubaan-agent': 'reviewer' });
    expect(agentLabelOf(headers, undefined)).toBe('reviewer');
    expect(agentLabelOf(headers, { agent: 'planner' })).toBe('planner');
    expect(agentLabelOf(headers, { agent: 42 })).toBe('reviewer');
    expect(agentLabelOf(new Headers(), {})).toBeNull();
  });

  it('accepts letters, digits and . _ - : / @ + up to the maximum length, trimmed', () => {
    for (const label of ['reviewer', 'sub-agent_2', 'team/planner:v1.2', 'a@b+c', '7']) {
      expect(parseAgentLabel(label)).toEqual({ kind: 'label', label });
    }
    expect(parseAgentLabel('  coder \t')).toEqual({ kind: 'label', label: 'coder' });
    const longest = 'x'.repeat(AGENT_LABEL_MAX_LENGTH);
    expect(parseAgentLabel(longest)).toEqual({ kind: 'label', label: longest });
  });

  it('holds nothing when the carrier is absent, empty or blank', () => {
    for (const raw of [undefined, null, '', '   ', '\t']) {
      expect(parseAgentLabel(raw)).toEqual({ kind: 'absent' });
    }
  });

  it('rejects, with the reason and never a repaired value', () => {
    expect(parseAgentLabel('x'.repeat(AGENT_LABEL_MAX_LENGTH + 1))).toEqual({
      kind: 'rejected',
      reason: 'too-long',
      length: AGENT_LABEL_MAX_LENGTH + 1,
    });
    for (const raw of [
      'build agent',
      'line\nbreak',
      'nul\u0000',
      'émile',
      '-leading',
      '<b>',
      'a,b',
    ]) {
      expect(parseAgentLabel(raw)).toMatchObject({ kind: 'rejected', reason: 'invalid-character' });
    }
    for (const raw of [42, true, { agent: 'x' }, ['x']]) {
      expect(parseAgentLabel(raw)).toEqual({
        kind: 'rejected',
        reason: 'not-a-string',
        length: null,
      });
    }
  });

  it('names the carrier it read, and what it dropped on the way', () => {
    const headers = new Headers({ 'x-vaubaan-agent': 'reviewer' });
    expect(readAgentLabel(headers, { agent: 'planner' })).toEqual({
      label: 'planner',
      carrier: 'meta',
      dropped: [],
    });
    // A rejected per-call value leaves the place to the header.
    expect(readAgentLabel(headers, { agent: 'not a label' })).toEqual({
      label: 'reviewer',
      carrier: 'header',
      dropped: [{ carrier: 'meta', reason: 'invalid-character', length: 11 }],
    });
    // The header is not examined once the per-call value gave the label.
    const badHeader = new Headers({ 'x-vaubaan-agent': 'x'.repeat(200) });
    expect(readAgentLabel(badHeader, { agent: 'planner' }).dropped).toEqual([]);
    expect(readAgentLabel(badHeader, { agent: 7 })).toEqual({
      label: null,
      carrier: null,
      dropped: [
        { carrier: 'meta', reason: 'not-a-string', length: null },
        { carrier: 'header', reason: 'too-long', length: 200 },
      ],
    });
    expect(readAgentLabel(new Headers(), 'not an object')).toEqual({
      label: null,
      carrier: null,
      dropped: [],
    });
  });
});

describe('client origin', () => {
  const headers = new Headers({
    'x-forwarded-for': '203.0.113.9, 198.51.100.7, 10.0.0.2',
    'user-agent': 'claude-code/2.1',
  });

  it('ignores X-Forwarded-For unless the operator declared the proxies', () => {
    const origin = clientOriginOf(headers, { proxies: trustedProxyList([]), configured: false });
    expect(origin).toEqual({ ip: null, user_agent: 'claude-code/2.1' });
  });

  it('takes the right-most hop that is not a trusted proxy', () => {
    const proxies = trustedProxyList(['10.0.0.0/8', '198.51.100.7']);
    expect(clientOriginOf(headers, { proxies, configured: true }).ip).toBe('203.0.113.9');
    const onlyEdge = trustedProxyList(['10.0.0.2']);
    expect(clientOriginOf(headers, { proxies: onlyEdge, configured: true }).ip).toBe(
      '198.51.100.7',
    );
  });

  it('gives no address for a malformed or fully trusted chain', () => {
    const proxies = trustedProxyList(['10.0.0.0/8', '2001:db8::/32']);
    const of = (xff: string) =>
      clientOriginOf(new Headers({ 'x-forwarded-for': xff }), { proxies, configured: true }).ip;
    expect(of('not-an-ip, 10.0.0.2')).toBeNull();
    expect(of('10.1.1.1, 10.0.0.2')).toBeNull();
    expect(of('2001:db8::1')).toBeNull();
    expect(of('2001:db9::1, 2001:db8::1')).toBe('2001:db9::1');
    expect(of('')).toBeNull();
  });

  it('reads a hop written with a port or in brackets (the one rule of http/client-ip)', () => {
    const proxies = trustedProxyList([' 10.0.0.0/8 ', '::1']);
    const of = (xff: string) =>
      clientOriginOf(new Headers({ 'x-forwarded-for': xff }), { proxies, configured: true }).ip;
    expect(of('203.0.113.7:4711, 10.0.0.2')).toBe('203.0.113.7');
    expect(of('[2001:db9::1]:4711, [::1]:443')).toBe('2001:db9::1');
    expect(of('  203.0.113.7  ,10.0.0.2:80 ')).toBe('203.0.113.7');
  });

  it('skips an invalid trusted_proxies entry instead of throwing or trusting more', () => {
    const proxies = trustedProxyList(['10.0.0.0/99', '10.0.0.0/', '10.0.0.0/x', '10.0.0.1']);
    const of = (xff: string) =>
      clientOriginOf(new Headers({ 'x-forwarded-for': xff }), { proxies, configured: true }).ip;
    expect(of('203.0.113.7, 10.0.0.1')).toBe('203.0.113.7');
    expect(of('203.0.113.7, 10.0.0.2')).toBe('10.0.0.2');
  });
});

describe('cited refs', () => {
  it('reads the known refs off the slices, identifiers and lists, in order, once each', () => {
    const known = new Set(['acme/app', 'acme/web', 'prj_1']);
    const slices = [
      parseSlice('github.repo[acme/app].branch[main].file[acme/web].R'),
      parseSlice('github.repo[acme/app].pull_request.R'),
      parseSlice('vercel.project[prj_1,prj_2].env[prod].W'),
      parseSlice('github.search.code.R'),
    ];
    expect(citedRefs(slices, known)).toEqual(['acme/app', 'acme/web', 'prj_1']);
    expect(citedRefs(slices, new Set())).toEqual([]);
  });
});

describe('tool discovery', () => {
  const depot = depotPlugin().plugin;
  const other = fixturePlugin({ id: 'other', credential: API_KEY_SPEC });
  const hidden = fixturePlugin({ id: 'labs', credential: API_KEY_SPEC, experimental: true });
  const registry = createRegistry([depot, other, hidden]);

  const context = (providers: readonly string[], risks: readonly string[]): MissionContext =>
    ({
      mission: { id: 'm' },
      connections: providers.map((provider) => ({ id: `c-${provider}`, provider })),
      resources: [],
      policy: risks.map((risk_id) => ({ risk_id })),
    }) as unknown as MissionContext;

  it('needs both a connection and an accepted risk of the provider', () => {
    expect(callableTools(context(['depot'], ['depot.read']), registry)).toHaveLength(4);
    expect(callableTools(context(['depot'], ['other.read-things']), registry)).toEqual([]);
    expect(callableTools(context([], ['depot.read']), registry)).toEqual([]);
    expect([
      ...callableProviders(
        context(['depot', 'other'], ['depot[staging].write', 'other.read-things']),
      ),
    ]).toEqual(['depot', 'other']);
  });

  it('lists nothing of an experimental plugin', () => {
    const tools = callableTools(
      context(['labs', 'other'], ['labs.read-things', 'other.read-things']),
      registry,
    );
    expect(tools.map((t) => t.name)).toEqual(['other__list_things']);
  });
});

describe('verified-token cache', () => {
  const BEARER = `vbn_live_AbCd1234_${'s'.repeat(32)}`;
  const token = { id: 'tok-1', prefix: 'AbCd1234', status: 'active' } as MissionTokenRecord;
  const mission = { id: 'mis-1', status: 'active' } as MissionRecord;

  function setup(verification: TokenVerification = { outcome: 'verified', token, mission }) {
    let stored: { token: MissionTokenRecord; mission: MissionRecord } | null = { token, mission };
    const verifyToken = vi.fn(async () => verification);
    const cache = new MemoryCacheClient();
    const verifier = new TokenVerifier({
      missions: { verifyToken },
      tokens: { findTokenByPrefix: async () => stored },
      cache,
      rateLimiter: new SlidingWindowRateLimiter(),
    });
    return {
      verifier,
      verifyToken,
      cache,
      store(next: typeof stored) {
        stored = next;
      },
    };
  }

  it('computes the hash once, then re-reads the state from the store', async () => {
    const { verifier, verifyToken, store } = setup();
    expect((await verifier.verify(BEARER)).outcome).toBe('verified');
    expect((await verifier.verify(BEARER)).outcome).toBe('verified');
    expect(verifyToken).toHaveBeenCalledTimes(1);

    store({ token: { ...token, status: 'revoked' }, mission: { ...mission, status: 'revoked' } });
    expect(await verifier.verify(BEARER)).toMatchObject({ outcome: 'retired', reason: 'revoked' });
    store({ token: { ...token, status: 'rotated' }, mission });
    expect(await verifier.verify(BEARER)).toMatchObject({ outcome: 'retired', reason: 'rotated' });
    expect(verifyToken).toHaveBeenCalledTimes(1);
  });

  it('keys the proof by a hash of the bearer, never by the bearer', async () => {
    const { verifier, cache } = setup();
    await verifier.verify(BEARER);
    const key = verifiedTokenCacheKey(BEARER);
    expect(key).not.toContain(BEARER.slice(-32));
    expect(await cache.get(key)).toBe('tok-1');
    expect(verifiedTokenCacheKey(`  ${BEARER} `)).toBe(key);
  });

  it('voids a proof whose token row is gone or replaced, and verifies again', async () => {
    const { verifier, verifyToken, store } = setup();
    await verifier.verify(BEARER);
    store({ token: { ...token, id: 'tok-2' }, mission });
    await verifier.verify(BEARER);
    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent first calls into one verification', async () => {
    const { verifier, verifyToken } = setup();
    const results = await Promise.all(Array.from({ length: 20 }, () => verifier.verify(BEARER)));
    expect(results.every((r) => r.outcome === 'verified')).toBe(true);
    expect(verifyToken).toHaveBeenCalledTimes(1);
  });

  it('never caches an unknown bearer, and throttles misses per prefix', async () => {
    const { verifier, verifyToken } = setup({ outcome: 'unknown' });
    for (let i = 0; i < VERIFY_ATTEMPTS_PER_WINDOW; i++) {
      expect((await verifier.verify(BEARER)).outcome).toBe('unknown');
    }
    expect(verifyToken).toHaveBeenCalledTimes(VERIFY_ATTEMPTS_PER_WINDOW);
    const throttled = await verifier.verify(BEARER);
    expect(throttled.outcome).toBe('throttled');
    expect(throttled.outcome === 'throttled' && throttled.retryAfterMs).toBeGreaterThan(0);
    expect(verifyToken).toHaveBeenCalledTimes(VERIFY_ATTEMPTS_PER_WINDOW);
  });

  it('slides the proof on every hit: an agent that keeps calling never verifies again', async () => {
    let nowMs = Date.parse('2026-10-13T09:00:00.000Z');
    const verifyToken = vi.fn(
      async (): Promise<TokenVerification> => ({ outcome: 'verified', token, mission }),
    );
    const verifier = new TokenVerifier({
      missions: { verifyToken },
      tokens: { findTokenByPrefix: async () => ({ token, mission }) },
      cache: new MemoryCacheClient({ now: () => nowMs }),
      rateLimiter: new SlidingWindowRateLimiter({ now: () => nowMs }),
    });
    const twoThirdsOfTheTtl = ((VERIFIED_TOKEN_TTL_SECONDS * 2) / 3) * 1000;
    for (let call = 0; call < 6; call++) {
      expect((await verifier.verify(BEARER)).outcome).toBe('verified');
      nowMs += twoThirdsOfTheTtl;
    }
    expect(verifyToken).toHaveBeenCalledTimes(1);

    // Silent for longer than the TTL: the proof is gone, one more verification.
    nowMs += VERIFIED_TOKEN_TTL_SECONDS * 1000;
    expect((await verifier.verify(BEARER)).outcome).toBe('verified');
    expect(verifyToken).toHaveBeenCalledTimes(2);
  });

  it('throttles per prefix AND client address: a flood of wrong secrets locks out only its sender', async () => {
    const verifyToken = vi.fn(
      async (bearer: string): Promise<TokenVerification> =>
        bearer === BEARER ? { outcome: 'verified', token, mission } : { outcome: 'unknown' },
    );
    const verifier = new TokenVerifier({
      missions: { verifyToken },
      tokens: { findTokenByPrefix: async () => ({ token, mission }) },
      cache: new MemoryCacheClient(),
      rateLimiter: new SlidingWindowRateLimiter(),
    });
    const wrong = (i: number) => `vbn_live_AbCd1234_${String(i).padStart(32, 'x')}`;
    const ATTACKER = '203.0.113.7';
    for (let i = 0; i < VERIFY_ATTEMPTS_PER_WINDOW; i++) {
      expect((await verifier.verify(wrong(i), ATTACKER)).outcome).toBe('unknown');
    }
    expect((await verifier.verify(wrong(99), ATTACKER)).outcome).toBe('throttled');

    // The real agent, cold cache, another address: verified, not 429.
    expect((await verifier.verify(BEARER, '198.51.100.9')).outcome).toBe('verified');
    // From the flooding address itself the window is still closed...
    expect((await verifier.verify(wrong(100), ATTACKER)).outcome).toBe('throttled');
    // ...and callers whose address cannot be resolved share one window of their own.
    expect((await verifier.verify(wrong(101))).outcome).toBe('unknown');
    expect((await verifier.verify(wrong(102), UNKNOWN_CLIENT)).outcome).toBe('unknown');
  });

  it('does not look anything up for a bearer that is not a mission token', async () => {
    const { verifier, verifyToken } = setup();
    expect(await verifier.verify('some-session-id')).toEqual({ outcome: 'unknown' });
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

describe('upstream credential cache', () => {
  const connection = { id: 'conn-1', updatedAt: '2026-10-13T09:00:00.000Z' };

  it('scopes entries to the connection and drops them on demand', async () => {
    const store = new ConnectionCredentialCache(new MemoryCacheClient());
    const mine = store.scopeFor(connection);
    const theirs = store.scopeFor({ id: 'conn-2', updatedAt: connection.updatedAt });
    await mine.set('installation-token:app', { token: 'a' }, 600);
    await mine.set('installation-token:*', { token: 'b' }, 600);

    expect(await mine.get('installation-token:app')).toEqual({ token: 'a' });
    expect(await theirs.get('installation-token:app')).toBeNull();

    expect(await store.drop('conn-1')).toBe(2);
    expect(await mine.get('installation-token:app')).toBeNull();
    expect(await store.drop('conn-1')).toBe(0);
  });

  it('makes earlier entries unreachable once the connection row changed', async () => {
    const store = new ConnectionCredentialCache(new MemoryCacheClient());
    await store.scopeFor(connection).set('k', 'before', 600);
    const reconnected = store.scopeFor({ ...connection, updatedAt: '2026-10-13T10:00:00.000Z' });
    expect(await reconnected.get('k')).toBeNull();
  });

  it('bounds the lifetime, and stores nothing for a non-positive one', async () => {
    let now = 0;
    const cache = new MemoryCacheClient({ now: () => now });
    const scope = new ConnectionCredentialCache(cache).scopeFor(connection);
    await scope.set('k', 'v', 24 * 3600);
    now = (MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS + 1) * 1000;
    expect(await scope.get('k')).toBeNull();
    await scope.set('zero', 'v', 0);
    expect(await scope.get('zero')).toBeNull();
  });
});
