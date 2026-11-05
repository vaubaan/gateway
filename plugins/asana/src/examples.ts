/**
 * Representative calls of every tool of the `asana` provider
 * (`ProviderPlugin.examples`) : the samples the plugin's tests run through the
 * kit (catalog coverage, data-model walk, identifier proof) and the site
 * classifies when it builds (ADR plugin-contract-and-credential-spec,
 * amendment 2026-11-05). One realistic call per tool, and the refused ones.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID, TOOL } from './identity.ts';

export const WORKSPACE = '1100000000000001';
/** The project of the mission. */
export const PROJECT = '1200000000000001';
/** Another project of the connection, outside the mission. */
export const OTHER_PROJECT = '1200000000000002';
export const SECTION = '1300000000000001';
export const TASK = '1400000000000001';
export const USER = '1500000000000001';
/** The parent of a subtask in the samples : distinct from `TASK`, so the proof sees it in the path. */
export const PARENT_SAMPLE = '1400000000000005';

/** The project the samples run on unless they name other resources. */
export const EXAMPLE_PROJECT: Resource = {
  provider: PROVIDER_ID,
  ref: PROJECT,
  displayName: 'Engineering / Roadmap',
  metadata: { workspace_gid: WORKSPACE, workspace_name: 'Acme', team_name: 'Engineering' },
};
/** A second project, for the listing sample. */
export const EXAMPLE_OTHER_PROJECT: Resource = {
  provider: PROVIDER_ID,
  ref: OTHER_PROJECT,
  displayName: 'Acme / Hiring',
  metadata: { workspace_gid: WORKSPACE, workspace_name: 'Acme' },
};

export const asanaExamples: ToolSamples = samplesOn([EXAMPLE_PROJECT], {
  [TOOL.listProjects]: [
    { args: {}, resources: [EXAMPLE_PROJECT, EXAMPLE_OTHER_PROJECT] },
    { args: {} },
  ],
  [TOOL.getProject]: [
    { args: { project: PROJECT } },
    { args: { project: OTHER_PROJECT }, expectDenied: true },
  ],
  [TOOL.listSections]: [{ args: { project: PROJECT } }],
  [TOOL.listTasks]: [
    { args: { project: PROJECT, completed_since: 'now', limit: 20 } },
    { args: { project: PROJECT, section: SECTION } },
  ],
  [TOOL.searchTasks]: [
    { args: { project: PROJECT, text: 'launch plan', completed: false, assignee: 'me' } },
  ],
  [TOOL.getTask]: [{ args: { project: PROJECT, task_gid: TASK } }],
  [TOOL.listComments]: [{ args: { project: PROJECT, task_gid: TASK } }],
  [TOOL.createTask]: [
    {
      args: {
        project: PROJECT,
        name: 'Draft the launch post',
        assignee: USER,
        due_on: '2026-11-20',
      },
    },
    { args: { project: PROJECT, name: 'Review copy', section: SECTION } },
    { args: { project: PROJECT, name: 'Check links', parent: PARENT_SAMPLE } },
  ],
  [TOOL.updateTask]: [
    { args: { project: PROJECT, task_gid: TASK, completed: true, section: SECTION } },
    // Name or notes : also a rewrite.
    { args: { project: PROJECT, task_gid: TASK, notes: 'New description' } },
    { args: { project: PROJECT, task_gid: TASK }, expectDenied: true },
  ],
  [TOOL.addComment]: [{ args: { project: PROJECT, task_gid: TASK, text: 'Done on staging' } }],
  [TOOL.deleteTask]: [{ args: { project: PROJECT, task_gid: TASK } }],
});
