/**
 * Data model of the `github-projects` service.
 *
 * Spec : docs/spec/gateway-risk-model.md §2. Handbook :
 * docs/handbook/services/github-projects.md §1.
 *
 * One plane, `project` : the project (the account's one resource, `<org>/<number>`),
 * its fields (the board's columns), its views, its items (cards), the value of
 * one field on one item, and `delete`, the verb leaf of an item removed from the
 * project. Repositories are not entities here : an item links an issue or a
 * pull request of any repository, which the GitHub plugin models.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { SERVICE_ID } from './identity.ts';

export const githubProjectsDataModel: DataModel = {
  service: SERVICE_ID,
  planes: [
    {
      slug: 'project',
      description: 'A GitHub Projects board of an organization: its fields, views and items.',
      entities: [
        {
          name: 'project',
          parent: null,
          cardinalities: ['one'],
          description: 'The resource: one project of an organization, `<org>/<number>`.',
        },
        {
          name: 'field',
          parent: 'project',
          cardinalities: ['one', 'unbounded'],
          description: 'A field of the project (text, number, date, single select, iteration).',
        },
        {
          name: 'view',
          parent: 'project',
          cardinalities: ['one'],
          description: 'A saved view of the project (table, board, roadmap), by its number.',
        },
        {
          name: 'item',
          parent: 'project',
          cardinalities: ['one', 'unbounded'],
          description: 'A card: a linked issue or pull request, or a draft issue.',
        },
        {
          name: 'value',
          parent: 'item',
          cardinalities: ['one'],
          description: 'The value of one field on one item, keyed by the field id.',
        },
        {
          name: 'delete',
          parent: 'item',
          cardinalities: ['one'],
          description: 'Verb leaf: an item removed from the project, with its field values.',
        },
      ],
    },
  ],
};
