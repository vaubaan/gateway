/**
 * One realistic call (or a refused one) per tool : the table the catalog
 * coverage, the data-model walk and the identifier proof run on.
 */
import type { ToolSamples } from '@vaubaan/plugin-sdk/testing';

import { TOOL } from '../../src/identity.ts';
import {
  OTHER_PROJECT,
  PARENT_SAMPLE,
  PROJECT,
  SECTION,
  TASK,
  USER,
  otherProject,
  project,
} from './fixtures.ts';

export const SAMPLES: ToolSamples = {
  [TOOL.listProjects]: [{ args: {}, resources: [project, otherProject] }, { args: {} }],
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
};
