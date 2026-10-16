/**
 * The five firewall (WAF) tools : the slice and the risk each call touches,
 * and the REST request `execute` sends — method, URL with the pinned team and
 * the project, JSON body — plus the "argument required" refusals.
 *
 * No test reaches the network : an unmatched request rejects.
 */
import { describe, expect, test } from 'vitest';
import { serializeSlice } from '@vaubaan/plugin-sdk';
import { mockFetch } from '@vaubaan/plugin-sdk/testing';
import { risksTouchedBy } from '@vaubaan/policy-engine';
import { PluginRegistry } from '@vaubaan/plugin-sdk';

import { classifyVercel } from '../../src/classify.ts';
import { vercelPlugin, VERCEL_API_BASE } from '../../src/index.ts';
import { app, ctx, TEAM, text } from './fixtures.ts';

const CONFIG_URL = `${VERCEL_API_BASE}/v1/security/firewall/config?teamId=${TEAM}&projectId=prj_abc`;
const ACTIVE_URL = `${VERCEL_API_BASE}/v1/security/firewall/config/active?teamId=${TEAM}&projectId=prj_abc`;

const catalog = new PluginRegistry([vercelPlugin]).catalogOf(vercelPlugin.id);

/** Serialised slices and the catalog risks they touch, for one call of the single-project mission. */
function classified(tool: string, args: Record<string, unknown>) {
  const out = classifyVercel(tool, args, [app]);
  if ('denied' in out) throw new Error(`unexpected denial: ${out.denied}`);
  const risks = new Set(out.slices.flatMap((s) => risksTouchedBy(s, catalog)));
  return { slices: out.slices.map(serializeSlice), risks: [...risks] };
}

describe('classifyVercel — firewall tools', () => {
  test('get_firewall_config → firewall.R, risks firewall-read and the catch-all read', () => {
    // `vercel.read-account` matches every read (`vercel.[**].R`) ; the
    // dedicated `firewall-read` is the one a mission must add to it.
    expect(classified('vercel__get_firewall_config', {})).toEqual({
      slices: ['vercel.project[prj_abc].firewall.R'],
      risks: ['vercel.read-account', 'vercel.firewall-read'],
    });
  });

  test('toggle_firewall → firewall.W, risk firewall-write', () => {
    expect(classified('vercel__toggle_firewall', { enabled: false })).toEqual({
      slices: ['vercel.project[prj_abc].firewall.W'],
      risks: ['vercel.firewall-write'],
    });
  });

  test('upsert_firewall_rule → firewall-rule[R].W (or [*] on insert), risk firewall-rule-write', () => {
    expect(classified('vercel__upsert_firewall_rule', { name: 'r', ruleId: 'rule_1' })).toEqual({
      slices: ['vercel.project[prj_abc].firewall.firewall-rule[rule_1].W'],
      risks: ['vercel.firewall-rule-write'],
    });
    expect(classified('vercel__upsert_firewall_rule', { name: 'r' })).toEqual({
      slices: ['vercel.project[prj_abc].firewall.firewall-rule[*].W'],
      risks: ['vercel.firewall-rule-write'],
    });
  });

  test('remove_firewall_rule → firewall-rule[R].W, risk firewall-rule-write', () => {
    expect(classified('vercel__remove_firewall_rule', { ruleId: 'rule_1' })).toEqual({
      slices: ['vercel.project[prj_abc].firewall.firewall-rule[rule_1].W'],
      risks: ['vercel.firewall-rule-write'],
    });
  });

  test('manage_ip_blocking → ip-rule[I].W (or [*] on insert), risk ip-rule-write', () => {
    expect(classified('vercel__manage_ip_blocking', { operation: 'remove', id: 'ip_1' })).toEqual({
      slices: ['vercel.project[prj_abc].firewall.ip-rule[ip_1].W'],
      risks: ['vercel.ip-rule-write'],
    });
    expect(
      classified('vercel__manage_ip_blocking', { operation: 'insert', ip: '10.0.0.0/8' }),
    ).toEqual({
      slices: ['vercel.project[prj_abc].firewall.ip-rule[*].W'],
      risks: ['vercel.ip-rule-write'],
    });
  });

  test('a firewall tool on a project outside the mission is denied', () => {
    expect(classifyVercel('vercel__toggle_firewall', { projectId: 'prj_other' }, [app])).toEqual({
      denied: "vercel project 'prj_other' is not a resource of this mission.",
    });
  });
});

describe('executeVercel — request shapes of the firewall tools', () => {
  test('get_firewall_config GETs the active configuration without a body', async () => {
    const fetch = mockFetch([{ method: 'GET', url: ACTIVE_URL, body: { firewallEnabled: true } }]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__get_firewall_config', {});
    expect(JSON.parse(text(result))).toEqual({ firewallEnabled: true });
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.body).toBeNull();
  });

  test('toggle_firewall PATCHes firewallEnabled ; a non-boolean `enabled` fails first', async () => {
    const fetch = mockFetch([{ method: 'PATCH', url: CONFIG_URL, body: { ok: true } }]);
    const result = await vercelPlugin.execute(ctx(fetch), 'vercel__toggle_firewall', {
      projectId: 'prj_abc',
      enabled: false,
    });
    expect(result.isError).toBeUndefined();
    expect(fetch.calls[0]!.json).toEqual({ action: 'firewallEnabled', value: false });

    for (const enabled of [undefined, 'false', 0]) {
      const refused = await vercelPlugin.execute(ctx(fetch), 'vercel__toggle_firewall', {
        enabled,
      });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(/enabled \(boolean\) is required/);
    }
    expect(fetch.calls).toHaveLength(1);
  });

  test('upsert_firewall_rule inserts without ruleId and updates with one', async () => {
    const fetch = mockFetch([{ method: 'PATCH', url: CONFIG_URL, body: { ok: true } }]);
    const rule = {
      name: 'block-admin',
      description: 'no admin from outside',
      active: true,
      conditionGroup: [{ conditions: [{ type: 'path', op: 'pre', value: '/admin' }] }],
      action: { type: 'deny' },
    };
    await vercelPlugin.execute(ctx(fetch), 'vercel__upsert_firewall_rule', {
      ...rule,
    });
    expect(fetch.calls[0]!.json).toEqual({ action: 'rules.insert', value: rule });

    await vercelPlugin.execute(ctx(fetch), 'vercel__upsert_firewall_rule', {
      ...rule,
      ruleId: 'rule_1',
    });
    expect(fetch.calls[1]!.json).toEqual({ action: 'rules.update', id: 'rule_1', value: rule });

    const refused = await vercelPlugin.execute(ctx(fetch), 'vercel__upsert_firewall_rule', {
      active: true,
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/name is required/);
    expect(fetch.calls).toHaveLength(2);
  });

  test('remove_firewall_rule PATCHes rules.remove ; a missing ruleId fails first', async () => {
    const fetch = mockFetch([{ method: 'PATCH', url: CONFIG_URL, body: { ok: true } }]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__remove_firewall_rule', { ruleId: 'rule_1' });
    expect(fetch.calls[0]!.json).toEqual({ action: 'rules.remove', id: 'rule_1' });

    const refused = await vercelPlugin.execute(ctx(fetch), 'vercel__remove_firewall_rule', {});
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/ruleId is required/);
    expect(fetch.calls).toHaveLength(1);
  });

  test('manage_ip_blocking inserts an IP rule or removes one by id ; missing arguments fail first', async () => {
    const fetch = mockFetch([{ method: 'PATCH', url: CONFIG_URL, body: { ok: true } }]);
    await vercelPlugin.execute(ctx(fetch), 'vercel__manage_ip_blocking', {
      operation: 'insert',
      ip: '10.0.0.0/8',
      hostname: 'app.example.com',
      action: 'deny',
      notes: 'scanner',
    });
    expect(fetch.calls[0]!.json).toEqual({
      action: 'ip.insert',
      value: { hostname: 'app.example.com', ip: '10.0.0.0/8', action: 'deny', notes: 'scanner' },
    });

    await vercelPlugin.execute(ctx(fetch), 'vercel__manage_ip_blocking', {
      operation: 'remove',
      id: 'ip_1',
    });
    expect(fetch.calls[1]!.json).toEqual({ action: 'ip.remove', id: 'ip_1' });

    for (const [args, message] of [
      [{ operation: 'insert' }, /ip is required for insert/],
      [{ operation: 'remove' }, /id is required for remove/],
      [{ operation: 'purge' }, /operation must be 'insert' or 'remove'/],
      [{}, /operation must be 'insert' or 'remove'/],
    ] as const) {
      const refused = await vercelPlugin.execute(ctx(fetch), 'vercel__manage_ip_blocking', args);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(message);
    }
    expect(fetch.calls).toHaveLength(2);
  });
});
