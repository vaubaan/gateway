/**
 * Representative calls of every tool (`ServicePlugin.examples`) : what the
 * tests run through the kit and the site classifies to show worked calls.
 * Ids are written as digits (strings), as the identifier proof feeds the
 * string arguments ; agents may send them as numbers too.
 */
import { samplesOn, type Resource, type ToolSamples } from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

export const EXAMPLE_PROJECT: Resource = {
  service: SERVICE_ID,
  ref: 'acme/12',
  displayName: 'Roadmap',
};
export const EXAMPLE_OTHER_PROJECT: Resource = {
  service: SERVICE_ID,
  ref: 'acme/7',
  displayName: 'Support',
};

export const githubProjectsExamples: ToolSamples = samplesOn([EXAMPLE_PROJECT], {
  [TOOL.getProject]: [
    { args: { project: 'acme/12' } },
    { args: {} },
    // A project the mission does not hold is refused.
    { args: { project: 'acme/7' }, expectDenied: true },
  ],
  [TOOL.listProjectFields]: [{ args: { project: 'acme/12', per_page: 50 } }],
  [TOOL.getProjectField]: [{ args: { project: 'acme/12', field_id: '4011' } }],
  [TOOL.listProjectItems]: [
    { args: { project: 'acme/12', q: 'status:Todo', fields: ['4011'], after: 'Y3Vyc29y' } },
  ],
  [TOOL.getProjectItem]: [{ args: { project: 'acme/12', item_id: '981', fields: ['4011'] } }],
  [TOOL.listProjectViewItems]: [{ args: { project: 'acme/12', view_number: '3' } }],
  [TOOL.addProjectItem]: [
    { args: { project: 'acme/12', type: 'Issue', owner: 'acme', repo: 'api', number: '42' } },
    { args: { project: 'acme/12', type: 'PullRequest', content_id: '1347' } },
  ],
  [TOOL.addProjectDraft]: [{ args: { project: 'acme/12', title: 'Spike: rate limits' } }],
  [TOOL.updateProjectItem]: [
    { args: { project: 'acme/12', item_id: '981', fields: [{ id: 4011, value: '98236657' }] } },
    // Two projects in the mission : the call names one.
    {
      args: { item_id: '981', fields: [{ id: 4011, value: null }] },
      resources: [EXAMPLE_PROJECT, EXAMPLE_OTHER_PROJECT],
      expectDenied: true,
    },
  ],
  [TOOL.deleteProjectItem]: [{ args: { project: 'acme/12', item_id: '981' } }],
  [TOOL.createProjectField]: [
    {
      args: {
        project: 'acme/12',
        name: 'Priority',
        data_type: 'single_select',
        single_select_options: [{ name: 'P0', color: 'RED', description: 'Now' }],
      },
    },
  ],
  [TOOL.createProjectView]: [
    { args: { project: 'acme/12', name: 'By status', layout: 'board', vertical_group_by: [4011] } },
  ],
});
