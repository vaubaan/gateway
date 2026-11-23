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

import { API_KEY_SPEC, fixturePlugin } from '../../../tests/support/accounts/testing';
import type { MissionService, TokenVerification, VerifiedToken } from '../missions';
import type { MissionRecord } from '../store/types';
import { AccountCredentialCache, MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS } from './credential-cache';
import {
  AGENT_LABEL_MAX_LENGTH,
  agentLabelOf,
  clientOriginOf,
  parseAgentLabel,
  readAgentLabel,
  trustedProxyList,
} from './request-meta';
import { citedRefs, createResourceStage, toolUnavailableOn } from './resource-stage';
import { depotPlugin } from '../../../tests/support/execution/testing';
import { TokenVerifier } from './token-verifier';
import { callableServices, callableTools } from './tools';

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
  const labs = fixturePlugin({ id: 'labs', credential: API_KEY_SPEC });
  const registry = createRegistry([depot, other, labs]);

  const context = (services: readonly string[], risks: readonly string[]): MissionContext =>
    ({
      mission: { id: 'm' },
      accounts: services.map((service) => ({ id: `c-${service}`, service })),
      resources: [],
      policy: risks.map((risk_id) => ({ risk_id })),
    }) as unknown as MissionContext;

  it('needs both an account and an accepted risk of the service', () => {
    expect(callableTools(context(['depot'], ['depot.read']), registry)).toHaveLength(5);
    expect(callableTools(context(['depot'], ['other.read-things']), registry)).toEqual([]);
    expect(callableTools(context([], ['depot.read']), registry)).toEqual([]);
    expect([
      ...callableServices(
        context(['depot', 'other'], ['depot[staging].write', 'other.read-things']),
      ),
    ]).toEqual(['depot', 'other']);
  });

  it('lists the tools of every plugin the mission holds and accepts a risk of', () => {
    const tools = callableTools(
      context(['labs', 'other'], ['labs.read-things', 'other.read-things']),
      registry,
    );
    expect(tools.map((t) => t.name)).toEqual(['other__list_things', 'labs__list_things']);
  });
});

describe('an account connected a way the plugin no longer offers', () => {
  // The GitHub App of catalog v8, the OAuth apps of Supabase and Railway : a stored
  // account may carry a credential kind the plugin no longer declares (ADR
  // one-place-to-authorize-services-token-first). It runs nothing until reconnected.
  const dual = fixturePlugin({ id: 'dual', displayName: 'Dual', credential: API_KEY_SPEC });
  const registry = createRegistry([dual]);
  const context = (credential_kind?: 'oauth2' | 'api-key' | 'app-install'): MissionContext =>
    ({
      mission: { id: 'm' },
      accounts: [
        {
          id: 'c-dual',
          service: 'dual',
          display_name: 'Dual bot',
          ...(credential_kind ? { credential_kind } : {}),
        },
      ],
      resources: [],
      policy: [{ risk_id: 'dual.read-things' }],
    }) as unknown as MissionContext;

  it('is left out of tools/list', () => {
    expect(callableTools(context('oauth2'), registry)).toEqual([]);
    // The GitHub App of earlier builds: a kind the contract no longer knows at all.
    expect(callableTools(context('app-install'), registry)).toEqual([]);
    expect(callableTools(context('api-key'), registry).map((t) => t.name)).toEqual([
      'dual__list_things',
    ]);
    // An account of a build that did not record the way is read as the plugin's way.
    expect(callableTools(context(), registry)).toHaveLength(1);
  });

  it('is refused by the resource stage, before any budget, naming the account and why', async () => {
    const stage = createResourceStage({
      registry,
      accounts: { listResources: async () => [] },
    });
    const call = { tool: 'dual__list_things', args: { space: 's' } } as unknown as CallRequest;
    const refused = await stage.resolve(context('oauth2'), call);
    expect(refused).toEqual({
      ok: false,
      reason:
        "tool 'dual__list_things' is not available on the Dual account 'Dual bot': this account was connected a way Dual no longer offers on this gateway (oauth2); its owner reconnects it from Accounts.",
    });
    expect(
      toolUnavailableOn(
        dual,
        { display_name: 'x', credential_kind: 'api-key' },
        'dual__list_things',
      ),
    ).toBeNull();
    const allowed = await stage.resolve(context('api-key'), call);
    expect(allowed.ok).toBe(true);
    const retired = await stage.resolve(context('app-install'), call);
    expect(retired).toEqual({
      ok: false,
      reason:
        "tool 'dual__list_things' is not available on the Dual account 'Dual bot': this account was connected a way Dual no longer offers on this gateway (app-install); its owner reconnects it from Accounts.",
    });
  });
});

describe('several accounts of one service in a mission', () => {
  // Spec §3.1, risk model §4.7 "The account of a call": a call runs with the account
  // holding the resource it names; the gateway never picks one for the agent.
  const depot = depotPlugin().plugin;
  const registry = createRegistry([depot]);
  const resource = (account_id: string, ref: string) => ({
    id: `r-${ref}`,
    account_id,
    service: 'depot',
    ref,
    env: null,
    displayName: `Space ${ref}`,
    discovered_at: '2026-11-22T00:00:00.000Z',
  });
  const record = (ref: string) => ({
    id: `r-${ref}`,
    ref,
    env: null,
    displayName: `Space ${ref}`,
    discoveredAt: '2026-11-22T00:00:00.000Z',
  });
  const account = (id: string, display_name: string, extra: object = {}) => ({
    id,
    service: 'depot',
    display_name,
    ...extra,
  });
  const context = (accounts: readonly object[]): MissionContext =>
    ({
      mission: { id: 'm' },
      accounts,
      // The mission reaches alpha on the first account and beta on the second.
      resources: [resource('c-a', 'alpha'), resource('c-b', 'beta')],
      policy: [{ risk_id: 'depot.read' }],
    }) as unknown as MissionContext;
  const two = context([account('c-a', 'Depot A'), account('c-b', 'Depot B')]);
  // The second account also knows gamma, which the mission does not reach.
  const known: Record<string, string[]> = { 'c-a': ['alpha'], 'c-b': ['beta', 'gamma'] };
  const stage = createResourceStage({
    registry,
    accounts: {
      listResources: async (id: string) => (known[id] ?? []).map(record),
    } as never,
  });
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    ({ tool: `depot__${tool}`, args }) as unknown as CallRequest;

  it('lists the service tools once, whatever the number of its accounts', () => {
    expect(callableTools(two, registry).map((t) => t.name)).toEqual(
      callableTools(context([account('c-a', 'Depot A')]), registry).map((t) => t.name),
    );
  });

  it('runs a call with the account holding the resource it names', async () => {
    const resolved = await stage.resolve(two, call('read_item', { space: 'beta' }));
    expect(resolved).toMatchObject({
      ok: true,
      target: { account: { id: 'c-b' }, resource: { ref: 'beta' } },
    });
    const first = await stage.resolve(two, call('write_item', { space: 'alpha' }));
    expect(first).toMatchObject({ ok: true, target: { account: { id: 'c-a' } } });
  });

  it('refuses account-ambiguous a call that names no resource, naming each account and its resources', async () => {
    for (const unnamed of [call('read_item'), call('whoami')]) {
      const refused = await stage.resolve(two, unnamed);
      expect(refused).toMatchObject({
        ok: false,
        refusal: {
          code: 'account-ambiguous',
          service: 'depot',
          accounts: [
            { id: 'c-a', name: 'Depot A', resources: [{ ref: 'alpha' }] },
            { id: 'c-b', name: 'Depot B', resources: [{ ref: 'beta' }] },
          ],
        },
      });
      const hint = (refused as { refusal: { hint: string } }).refusal.hint;
      expect(hint).toContain('names no resource');
      expect(hint).toContain("'Depot B' (beta)");
    }
  });

  it('refuses resource-not-in-mission a resource an account holds outside the mission, listing every account reached', async () => {
    const refused = await stage.resolve(two, call('read_item', { space: 'gamma' }));
    expect(refused).toMatchObject({
      ok: false,
      refusal: {
        code: 'resource-not-in-mission',
        cited_ref: 'gamma',
        account: { id: 'c-b', name: 'Depot B' },
        allowed_resources: [{ ref: 'alpha' }, { ref: 'beta' }],
      },
    });
  });

  it('sends a call naming nothing to the only account that still serves the mission', async () => {
    const lost = context([
      account('c-a', 'Depot A', { lost: { cause: 'account-revoked', final: true } }),
      account('c-b', 'Depot B'),
    ]);
    const resolved = await stage.resolve(lost, call('whoami'));
    expect(resolved).toMatchObject({ ok: true, target: { account: { id: 'c-b' } } });
  });

  it('runs a call naming a resource with the serving account, when a lost one holds it too', async () => {
    // A disconnected account and the one connected in its place, on one repository.
    const replaced = {
      ...context([
        account('c-a', 'Depot A', { lost: 'account-revoked' }),
        account('c-n', 'Depot N'),
      ]),
      resources: [resource('c-a', 'alpha'), resource('c-n', 'alpha')],
    } as unknown as MissionContext;
    const replacing = createResourceStage({
      registry,
      accounts: { listResources: async () => [record('alpha')] } as never,
    });
    const resolved = await replacing.resolve(replaced, call('read_item', { space: 'alpha' }));
    expect(resolved).toMatchObject({
      ok: true,
      target: { account: { id: 'c-n' }, resource: { ref: 'alpha' } },
    });
  });

  it('gives each tool the optional vaubaan_account argument, only with several accounts', () => {
    for (const tool of callableTools(two, registry)) {
      const property = tool.inputSchema.properties?.['vaubaan_account'] as { description: string };
      expect(property.description).toContain("'Depot B' (c-b)");
      expect(tool.inputSchema.required ?? []).not.toContain('vaubaan_account');
    }
    for (const tool of callableTools(context([account('c-a', 'Depot A')]), registry)) {
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty('vaubaan_account');
    }
  });

  it('runs a call naming no resource on the account named by vaubaan_account, by id or by name', async () => {
    const byName = await stage.resolve(two, { ...call('read_item'), account: 'depot b' });
    expect(byName).toMatchObject({
      ok: true,
      target: { account: { id: 'c-b' }, resource: { ref: 'beta' } },
    });
    const byId = await stage.resolve(two, { ...call('whoami'), account: 'c-a' });
    expect(byId).toMatchObject({ ok: true, target: { account: { id: 'c-a' } } });
  });

  it('refuses a call naming a resource of another account than the one vaubaan_account names', async () => {
    const refused = await stage.resolve(two, {
      ...call('read_item', { space: 'alpha' }),
      account: 'Depot B',
    });
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { reason: string }).reason).toContain(
      "names 'alpha', held by the Depot account 'Depot A'",
    );
  });

  it('refuses a vaubaan_account that names no account of the service, listing them', async () => {
    for (const ctx of [two, context([account('c-a', 'Depot A')])]) {
      const refused = await stage.resolve(ctx, { ...call('read_item'), account: 'Depot Z' });
      expect(refused).toMatchObject({ ok: false });
      expect((refused as { reason: string }).reason).toContain("'Depot A' (c-a)");
    }
    const one = context([account('c-a', 'Depot A')]);
    expect(await stage.resolve(one, { ...call('read_item'), account: 'Depot A' })).toMatchObject({
      ok: true,
      target: { account: { id: 'c-a' }, resource: { ref: 'alpha' } },
    });
  });

  it('keeps the single account default: a call naming nothing reaches its only resource', async () => {
    const one = context([account('c-a', 'Depot A')]);
    const resolved = await stage.resolve(one, call('read_item'));
    expect(resolved).toMatchObject({
      ok: true,
      target: { account: { id: 'c-a' }, resource: { ref: 'alpha' } },
    });
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

  /** A mission service that answers `answer` for every Bearer it is asked about. */
  function setup(answer: (bearer: string) => TokenVerification) {
    const verifyToken = vi.fn<Verify>(async (bearer: string) => answer(bearer));
    const verifier = new TokenVerifier({ missions: { verifyToken } });
    return { verifier, verifyToken };
  }

  it('remembers nothing: every call asks what the token is worth now', async () => {
    let standing: TokenVerification = verified;
    const { verifier, verifyToken } = setup(() => standing);
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

  it('does not look anything up for a bearer that is not a mission token', async () => {
    const { verifier, verifyToken } = setup(() => verified);
    expect(await verifier.verify('some-session-id')).toEqual({ outcome: 'unknown' });
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

describe('upstream credential cache', () => {
  const account = { id: 'conn-1', updatedAt: '2026-10-13T09:00:00.000Z' };

  it('scopes entries to the account and drops them on demand', async () => {
    const store = new AccountCredentialCache(new MemoryCacheClient());
    const mine = store.scopeFor(account);
    const theirs = store.scopeFor({ id: 'conn-2', updatedAt: account.updatedAt });
    await mine.set('installation-token:app', { token: 'a' }, 600);
    await mine.set('installation-token:*', { token: 'b' }, 600);

    expect(await mine.get('installation-token:app')).toEqual({ token: 'a' });
    expect(await theirs.get('installation-token:app')).toBeNull();

    expect(await store.drop('conn-1')).toBe(2);
    expect(await mine.get('installation-token:app')).toBeNull();
    expect(await store.drop('conn-1')).toBe(0);
  });

  it('makes earlier entries unreachable once the account row changed', async () => {
    const store = new AccountCredentialCache(new MemoryCacheClient());
    await store.scopeFor(account).set('k', 'before', 600);
    const reconnected = store.scopeFor({ ...account, updatedAt: '2026-10-13T10:00:00.000Z' });
    expect(await reconnected.get('k')).toBeNull();
  });

  it('bounds the lifetime, and stores nothing for a non-positive one', async () => {
    let now = 0;
    const cache = new MemoryCacheClient({ now: () => now });
    const scope = new AccountCredentialCache(cache).scopeFor(account);
    await scope.set('k', 'v', 24 * 3600);
    now = (MAX_UPSTREAM_CREDENTIAL_TTL_SECONDS + 1) * 1000;
    expect(await scope.get('k')).toBeNull();
    await scope.set('zero', 'v', 0);
    expect(await scope.get('zero')).toBeNull();
  });
});
