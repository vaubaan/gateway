/**
 * Data model of the `template` provider.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 *
 * One plane, `workspace`, with two entities : the workspace (the resource
 * the owner labels with an environment) and the widgets it contains. Every
 * slice the classifier emits walks this graph ; every `matches` pattern of
 * the catalog names entities declared here.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const templateDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'workspace',
      description: 'A workspace of the provider and the widgets it holds.',
      entities: [
        {
          name: 'workspace',
          parent: null,
          cardinalities: ['one'],
          description: 'The resource a connection exposes ; labelled prod / staging by its owner.',
          envScopable: true,
        },
        {
          name: 'widget',
          parent: 'workspace',
          cardinalities: ['one', 'unbounded'],
          description: 'A widget inside a workspace.',
        },
      ],
    },
  ],
};
