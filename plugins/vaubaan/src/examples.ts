/**
 * Representative calls of every tool of the `vaubaan` service
 * (`ServicePlugin.examples`): the samples the plugin's tests run through the
 * kit and the site classifies when it builds. The account carries no resource,
 * so no sample names one.
 */
import { samplesOn, type ToolSamples } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

/** A mission id as `list_my_missions` returns it (UUIDv7). */
export const EXAMPLE_MISSION_ID = '0193a4f2-7c1e-7b3a-9d2f-5e6a7b8c9d0e';

/** A draft as `preview_policy`, `issue_mission` and `edit_mission` (with `mission_id`) take it. */
export const EXAMPLE_DRAFT = {
  name: 'Fix the flaky test',
  period: { kind: 'one-off' },
  expires_at: null,
  accounts: [
    {
      account_id: '0193a4f2-0000-7000-8000-000000000001',
      resources: { scope: 'selected', resource_refs: ['acme/app'] },
      trust_levels: { read: 'careful', 'pull-requests': 'careful' },
    },
  ],
} as const;

export const vaubaanExamples: ToolSamples = samplesOn([], {
  [TOOL.listMyAccounts]: [{ args: {} }],
  [TOOL.getCatalog]: [
    { args: { service: 'github' } },
    { args: { service: 'github', account_id: '0193a4f2-0000-7000-8000-000000000001' } },
    { args: { service: '' }, expectDenied: true },
  ],
  [TOOL.listMyMissions]: [
    { args: {} },
    { args: { mission_id: EXAMPLE_MISSION_ID, include_closed: true } },
    { args: { mission_id: 42 }, expectDenied: true },
  ],
  [TOOL.previewPolicy]: [
    { args: EXAMPLE_DRAFT },
    { args: { ...EXAMPLE_DRAFT, mission_id: EXAMPLE_MISSION_ID } },
    { args: { ...EXAMPLE_DRAFT, mission_id: 42 }, expectDenied: true },
  ],
  [TOOL.issueMission]: [{ args: EXAMPLE_DRAFT }],
  [TOOL.renameMission]: [
    { args: { mission_id: EXAMPLE_MISSION_ID, name: 'Fix the flaky test, then the docs' } },
    { args: { name: 'No mission named' }, expectDenied: true },
  ],
  [TOOL.editMission]: [
    { args: { ...EXAMPLE_DRAFT, mission_id: EXAMPLE_MISSION_ID } },
    { args: EXAMPLE_DRAFT, expectDenied: true },
  ],
  [TOOL.rotateMissionToken]: [
    { args: { mission_id: EXAMPLE_MISSION_ID } },
    { args: {}, expectDenied: true },
  ],
  [TOOL.uploadPlugin]: [
    { args: { archive_base64: 'H4sIAAAAAAAAA+3BAQ0AAADCoPdPbQ8HFAAAAAAAAAAAAAAA' } },
    { args: { archive_base64: 'x', name: 'extra' }, expectDenied: true },
  ],
  [TOOL.pluginStatus]: [{ args: {} }],
  [TOOL.revokeMission]: [
    { args: { mission_id: EXAMPLE_MISSION_ID } },
    { args: { mission_id: EXAMPLE_MISSION_ID, reason: 'done' }, expectDenied: true },
  ],
});
