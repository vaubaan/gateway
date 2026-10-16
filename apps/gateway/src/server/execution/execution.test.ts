/**
 * Unit tests of the execution door's pure and in-memory parts: agent label,
 * client origin, cited refs, tool filter, verified-token cache, upstream
 * credential cache. The pipeline and the HTTP surface are covered by
 * `tests/integration/execution/`.
 */
import { MemoryCacheClient, type CallRequest, type MissionContext } from '@vaubaan/gateway-core';
import { createRegistry } from '@vaubaan/plugin-sdk';
import { parseSlice } from '@vaubaan/policy-engine';
import { describe, expect, it, vi } from 'vitest';

import { API_KEY_SPEC, fixturePlugin, OAUTH_SPEC } from '../connections/testing';
import type { LegacyHashGate, MissionService, TokenVerification, VerifiedToken } from '../missions';
import { UNKNOWN_CLIENT } from '../http/client-ip';
import { SlidingWindowRateLimiter } from '../rate-limit';
import type { MissionRecord } from '../store/types';
import { ConnectionCredentialCache, MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS } from './credential-cache';
import {
  AGENT_LABEL_MAX_LENGTH,
  agentLabelOf,
  clientOriginOf,
  parseAgentLabel,
  readAgentLabel,
  trustedProxyList,
} from './request-meta';
import { citedRefs, createResourceStage, toolUnavailableOn } from './resource-stage';
import { depotPlugin } from './testing';
import { TokenVerifier, VERIFY_ATTEMPTS_PER_WINDOW, verifyThrottleKey } from './token-verifier';
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

describe('a tool the way of connecting cannot run', () => {
  const NEEDS_APP = 'needs the Dual app: a token cannot list things.';
  const dual = fixturePlugin({
    id: 'dual',
    displayName: 'Dual',
    credential: OAUTH_SPEC,
    alternativeCredentials: [
      { ...API_KEY_SPEC, unavailableTools: { dual__list_things: NEEDS_APP } },
    ],
  });
  const registry = createRegistry([dual]);
  const context = (credential_kind?: 'oauth2' | 'api-key'): MissionContext =>
    ({
      mission: { id: 'm' },
      connections: [
        {
          id: 'c-dual',
          provider: 'dual',
          display_name: 'Dual bot',
          ...(credential_kind ? { credential_kind } : {}),
        },
      ],
      resources: [],
      policy: [{ risk_id: 'dual.read-things' }],
    }) as unknown as MissionContext;

  it('is left out of tools/list for a token connection only', () => {
    expect(callableTools(context('api-key'), registry)).toEqual([]);
    expect(callableTools(context('oauth2'), registry).map((t) => t.name)).toEqual([
      'dual__list_things',
    ]);
    // A connection of a build that did not record the way is read as the primary way.
    expect(callableTools(context(), registry)).toHaveLength(1);
  });

  it('is refused by the resource stage, before any budget, naming the account and why', async () => {
    const stage = createResourceStage({
      registry,
      connections: { listResources: async () => [] },
    });
    const call = { tool: 'dual__list_things', args: { space: 's' } } as unknown as CallRequest;
    const refused = await stage.resolve(context('api-key'), call);
    expect(refused).toEqual({
      ok: false,
      reason: `tool 'dual__list_things' is not available on the Dual account 'Dual bot': ${NEEDS_APP}`,
    });
    expect(
      toolUnavailableOn(
        dual,
        { display_name: 'x', credential_kind: 'oauth2' },
        'dual__list_things',
      ),
    ).toBeNull();
    const allowed = await stage.resolve(context('oauth2'), call);
    expect(allowed.ok).toBe(true);
  });
});

describe('token verifier', () => {
  const BEARER = `vbn_live_AbCd1234_${'s'.repeat(32)}`;
  const token: VerifiedToken = {
    id: 'tok-1',
    prefix: 'AbCd1234',
    holder: { kind: 'member', user_id: 'usr-bob', display: 'bob@example.com' },
  };
  const mission = { id: 'mis-1', status: 'active' } as MissionRecord;
  const verified: TokenVerification = { outcome: 'verified', token, mission };

  type Verify = MissionService['verifyToken'];

  /**
   * A mission service whose token row is stored as `stored`. Like the real one, it
   * asks the gate only for a legacy row, before it would compute the slow hash.
   * `standing` is what the store says of the token at this instant.
   */
  function setup(stored: 'sha256' | 'argon2id', answer: (bearer: string) => TokenVerification) {
    const slowChecks = vi.fn();
    const verifyToken = vi.fn(async (bearer: string, gate?: LegacyHashGate) => {
      if (stored === 'argon2id' && gate) {
        const decision = await gate();
        if (!decision.allowed) {
          return { outcome: 'throttled' as const, retryAfterMs: decision.retryAfterMs };
        }
        slowChecks();
      }
      return answer(bearer);
    });
    const verifier = new TokenVerifier({
      missions: { verifyToken: verifyToken as unknown as Verify },
      rateLimiter: new SlidingWindowRateLimiter(),
    });
    return { verifier, verifyToken, slowChecks };
  }

  it('remembers nothing: every call asks what the token is worth now', async () => {
    let standing: TokenVerification = verified;
    const { verifier, verifyToken } = setup('sha256', () => standing);
    expect((await verifier.verify(BEARER)).outcome).toBe('verified');
    expect((await verifier.verify(BEARER)).outcome).toBe('verified');

    standing = { outcome: 'retired', reason: 'revoked', token, mission };
    expect(await verifier.verify(BEARER)).toMatchObject({ outcome: 'retired', reason: 'revoked' });
    standing = { outcome: 'retired', reason: 'holder-removed', token, mission };
    expect(await verifier.verify(BEARER)).toMatchObject({
      outcome: 'retired',
      reason: 'holder-removed',
    });
    standing = { outcome: 'retired', reason: 'holder-deactivated', token, mission };
    expect(await verifier.verify(BEARER)).toMatchObject({
      outcome: 'retired',
      reason: 'holder-deactivated',
    });
    // The member is back (added again, reactivated): the same token serves, by the same read.
    standing = verified;
    expect((await verifier.verify(BEARER)).outcome).toBe('verified');
    expect(verifyToken).toHaveBeenCalledTimes(6);
  });

  it('never throttles a token stored as a sha256 digest, however many wrong secrets are replayed', async () => {
    const { verifier, verifyToken } = setup('sha256', () => ({ outcome: 'unknown' }));
    for (let i = 0; i < VERIFY_ATTEMPTS_PER_WINDOW * 3; i++) {
      expect((await verifier.verify(BEARER, '203.0.113.7')).outcome).toBe('unknown');
    }
    expect(verifyToken).toHaveBeenCalledTimes(VERIFY_ATTEMPTS_PER_WINDOW * 3);
  });

  it('throttles the argon2id check of a legacy token: past the window, nothing is computed', async () => {
    const { verifier, slowChecks } = setup('argon2id', () => ({ outcome: 'unknown' }));
    for (let i = 0; i < VERIFY_ATTEMPTS_PER_WINDOW; i++) {
      expect((await verifier.verify(BEARER)).outcome).toBe('unknown');
    }
    expect(slowChecks).toHaveBeenCalledTimes(VERIFY_ATTEMPTS_PER_WINDOW);
    const throttled = await verifier.verify(BEARER);
    expect(throttled.outcome).toBe('throttled');
    expect(throttled.outcome === 'throttled' && throttled.retryAfterMs).toBeGreaterThan(0);
    expect(slowChecks).toHaveBeenCalledTimes(VERIFY_ATTEMPTS_PER_WINDOW);
  });

  it('throttles per prefix AND client address: a flood of wrong secrets locks out only its sender', async () => {
    const { verifier } = setup('argon2id', (bearer) =>
      bearer === BEARER ? verified : { outcome: 'unknown' },
    );
    const wrong = (i: number) => `vbn_live_AbCd1234_${String(i).padStart(32, 'x')}`;
    const ATTACKER = '203.0.113.7';
    for (let i = 0; i < VERIFY_ATTEMPTS_PER_WINDOW; i++) {
      expect((await verifier.verify(wrong(i), ATTACKER)).outcome).toBe('unknown');
    }
    expect((await verifier.verify(wrong(99), ATTACKER)).outcome).toBe('throttled');

    // The real agent, another address: verified, not 429.
    expect((await verifier.verify(BEARER, '198.51.100.9')).outcome).toBe('verified');
    // From the flooding address itself the window is still closed...
    expect((await verifier.verify(wrong(100), ATTACKER)).outcome).toBe('throttled');
    // ...and callers whose address cannot be resolved share one window of their own.
    expect((await verifier.verify(wrong(101))).outcome).toBe('unknown');
    expect((await verifier.verify(wrong(102), UNKNOWN_CLIENT)).outcome).toBe('unknown');
    // Another legacy prefix has a window of its own.
    expect(verifyThrottleKey('AbCd1234', ATTACKER)).not.toBe(
      verifyThrottleKey('ZyXw9876', ATTACKER),
    );
  });

  it('does not look anything up for a bearer that is not a mission token', async () => {
    const { verifier, verifyToken } = setup('sha256', () => verified);
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
