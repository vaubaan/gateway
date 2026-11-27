/**
 * Representative calls of every tool (`ServicePlugin.examples`): the samples
 * the plugin's tests run through the kit and the site classifies when it
 * builds. At least one per tool, none landing on the fallback.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

export const EXAMPLE_DRIVE: Resource = {
  service: SERVICE_ID,
  ref: 'alice~contoso.example',
  displayName: 'Alice <alice@contoso.example>',
  metadata: { account_email: 'alice@contoso.example' },
};
export const EXAMPLE_OTHER_DRIVE: Resource = {
  service: SERVICE_ID,
  ref: 'bob~contoso.example',
  displayName: 'Bob <bob@contoso.example>',
  metadata: { account_email: 'bob@contoso.example' },
};

export const oneDriveExamples: ToolSamples = samplesOn([EXAMPLE_DRIVE], {
  [TOOL.listFolder]: [
    { args: {} },
    { args: { drive: 'alice~contoso.example', folderId: '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K' } },
    // Two drives in the mission: the call names one.
    {
      args: { folderId: 'root' },
      resources: [EXAMPLE_DRIVE, EXAMPLE_OTHER_DRIVE],
      expectDenied: true,
    },
  ],
  [TOOL.searchFiles]: [{ args: { query: 'quarterly report' } }],
  [TOOL.readFile]: [
    { args: { fileId: 'D4648F06C91D9D3D!54927' } },
    {
      args: { drive: 'carol~contoso.example', fileId: '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K' },
      expectDenied: true,
    },
  ],
  [TOOL.uploadFile]: [
    {
      args: {
        name: 'notes.md',
        content: '# Notes\n',
        mimeType: 'text/markdown',
        folderId: '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K',
      },
    },
  ],
  [TOOL.createFolder]: [{ args: { name: 'Reports 2026', parentId: 'root' } }],
});
