/**
 * Representative calls of every tool of the `vaubaan` provider
 * (`ProviderPlugin.examples`): the samples the plugin's tests run through the
 * kit and the site classifies when it builds. The account carries no resource,
 * so no sample names one.
 */
import { samplesOn, type ToolSamples } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

/** A mission id as `list_my_missions` returns it (UUIDv7). */
export const EXAMPLE_MISSION_ID = '0193a4f2-7c1e-7b3a-9d2f-5e6a7b8c9d0e';

/** A draft as `preview_policy` and `issue_mission` take it. */
export const EXAMPLE_DRAFT = {
  name: 'Fix the flaky test',
  period: { kind: 'one-off' },
  expires_at: null,
  connections: [
    {
      connection_id: '0193a4f2-0000-7000-8000-000000000001',
      resources: { scope: 'selected', resource_refs: ['acme/app'] },
      trust_levels: { read: 'careful', 'pull-requests': 'careful' },
    },
  ],
} as const;

export const vaubaanExamples: ToolSamples = samplesOn([], {
  [TOOL.listMyConnections]: [{ args: {} }],
  [TOOL.getCatalog]: [
    { args: { provider: 'github' } },
    { args: { provider: 'github', connection_id: '0193a4f2-0000-7000-8000-000000000001' } },
    { args: { provider: '' }, expectDenied: true },
  ],
  [TOOL.listMyMissions]: [
    { args: {} },
    { args: { mission_id: EXAMPLE_MISSION_ID, include_closed: true } },
    { args: { mission_id: 42 }, expectDenied: true },
  ],
  [TOOL.previewPolicy]: [{ args: EXAMPLE_DRAFT }],
  [TOOL.issueMission]: [{ args: EXAMPLE_DRAFT }],
  [TOOL.rotateMissionToken]: [
    { args: { mission_id: EXAMPLE_MISSION_ID } },
    { args: {}, expectDenied: true },
  ],
  [TOOL.revokeMission]: [
    { args: { mission_id: EXAMPLE_MISSION_ID } },
    { args: { mission_id: EXAMPLE_MISSION_ID, reason: 'done' }, expectDenied: true },
  ],
});
