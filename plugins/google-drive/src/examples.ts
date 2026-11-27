/**
 * Representative calls of every tool (`ServicePlugin.examples`): the samples
 * the plugin's tests run through the kit and the site classifies when it
 * builds. At least one per tool, none landing on the fallback.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

export const EXAMPLE_DRIVE: Resource = {
  service: SERVICE_ID,
  ref: 'alice~acme.example',
  displayName: 'Alice <alice@acme.example>',
  metadata: { account_email: 'alice@acme.example' },
};
export const EXAMPLE_OTHER_DRIVE: Resource = {
  service: SERVICE_ID,
  ref: 'bob~acme.example',
  displayName: 'Bob <bob@acme.example>',
  metadata: { account_email: 'bob@acme.example' },
};

export const googleDriveExamples: ToolSamples = samplesOn([EXAMPLE_DRIVE], {
  [TOOL.listFolder]: [
    { args: {} },
    { args: { drive: 'alice~acme.example', folderId: '1FoLdEr_x-2' } },
    // Two drives in the mission: the call names one.
    {
      args: { folderId: 'root' },
      resources: [EXAMPLE_DRIVE, EXAMPLE_OTHER_DRIVE],
      expectDenied: true,
    },
  ],
  [TOOL.searchFiles]: [{ args: { query: 'quarterly report' } }],
  [TOOL.readFile]: [
    { args: { fileId: '1AbCdEfGh_ijk-LmN' } },
    { args: { drive: 'carol~acme.example', fileId: '1AbCdEfGh_ijk-LmN' }, expectDenied: true },
  ],
  [TOOL.uploadFile]: [
    {
      args: {
        name: 'notes.md',
        content: '# Notes\n',
        mimeType: 'text/markdown',
        folderId: '1FoLdEr_x-2',
      },
    },
  ],
  [TOOL.createFolder]: [{ args: { name: 'Reports 2026', parentId: 'root' } }],
});
