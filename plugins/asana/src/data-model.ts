/**
 * Data model of the `asana` provider.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/asana.md.
 *
 * One plane, `work` : the project (the resource a mission selects), its
 * sections, its tasks and the comments of a task, plus two verb leaves under the
 * task, `rewrite` and `delete`. A subtask is a task : it is named under the project it
 * belongs to through its ancestors. Asana has no environment : no entity is
 * `envScopable`, no risk is env-scoped.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const asanaDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'work',
      description: 'The projects of an Asana account, their sections, tasks and comments.',
      entities: [
        {
          name: 'project',
          parent: null,
          // `bounded` : `list_projects` names every project of the mission at once.
          cardinalities: ['one', 'bounded'],
          description:
            'An Asana project : the resource a connection exposes and a mission selects.',
        },
        {
          name: 'section',
          parent: 'project',
          cardinalities: ['one', 'unbounded'],
          description: 'A section (or board column) of a project.',
        },
        {
          name: 'task',
          parent: 'project',
          cardinalities: ['one', 'unbounded'],
          description: 'A task of the project, or a subtask of one of its tasks.',
        },
        {
          name: 'comment',
          parent: 'task',
          cardinalities: ['one', 'unbounded'],
          description: 'A comment on a task (a story of subtype comment_added).',
        },
        {
          name: 'rewrite',
          parent: 'task',
          cardinalities: ['one'],
          description:
            "Verb leaf : overwriting a task's name or description, a write with its own risk.",
        },
        {
          name: 'delete',
          parent: 'task',
          cardinalities: ['one'],
          description:
            "Verb leaf : moving a task to the account's trash, a write with its own risk.",
        },
      ],
    },
  ],
};
