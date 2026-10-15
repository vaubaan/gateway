/**
 * SEC 2026-10-15 re-check M-1: a tool a plugin declares unbound (Railway's agent,
 * a free-text request acting with the whole credential) is unavailable on a
 * connection that reaches a resource hosting this gateway — refused by the
 * resource stage, left out of `tools/list` — and only there.
 */
import railwayPlugin from '@vaubaan/plugin-railway';
import { definePlugin, pluginIssues } from '@vaubaan/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { toolUnavailableOn, unavailableReason } from './resource-stage';

const AGENT = 'railway__railway-agent';
const OTHER = 'railway__list-projects';

const account = (hostsInstance: boolean) => ({
  display_name: 'ops',
  credential_kind: null,
  hosts_instance: hostsInstance,
});

describe('unbound tools on a connection that hosts the instance', () => {
  it('Railway declares its agent unbound', () => {
    expect(Object.keys(railwayPlugin.unboundTools ?? {})).toEqual([AGENT]);
  });

  it('the agent is refused on an account that reaches the hosting project, with the reason', () => {
    const refusal = toolUnavailableOn(railwayPlugin, account(true), AGENT);
    expect(refusal).toContain(`tool '${AGENT}' is not available on the Railway account 'ops'`);
    expect(refusal).toContain('hosts this gateway');
  });

  it('every other tool, and the agent on any other account, stay available', () => {
    const otherTool = railwayPlugin.tools.find((t) => t.name !== AGENT)?.name ?? OTHER;
    expect(unavailableReason(railwayPlugin, account(true), otherTool)).toBeNull();
    expect(unavailableReason(railwayPlugin, account(false), AGENT)).toBeNull();
    expect(unavailableReason(railwayPlugin, undefined, AGENT)).toBeNull();
  });

  it('the SDK refuses an unbound tool the plugin does not have', () => {
    const issues = pluginIssues({ ...railwayPlugin, unboundTools: { railway__nope: 'Why not.' } });
    expect(issues.some((issue) => issue.includes("unboundTools: 'railway__nope'"))).toBe(true);
    expect(() => definePlugin({ ...railwayPlugin, unboundTools: { [AGENT]: '' } })).toThrow();
  });
});
