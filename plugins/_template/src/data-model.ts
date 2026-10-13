/**
 * Data model of the `template` provider.
 *
 * Spec : docs/spec/gateway-risk-model.md §2.
 *
 * One plane, `workspace` : the workspace (the resource the owner labels with
 * an environment), the widgets it contains, and `delete`, a **verb leaf**.
 * A slice ends in `R` or `W` only, so an operation that deserves its own
 * risk among the writes is given a leaf of its own : deleting a widget is
 * `…widget[<id>].delete.W`, which the catalog can match apart from the other
 * writes. Every slice the classifier emits and every `matches` pattern of
 * the catalog uses the entities declared here ; nothing checks that for you
 * (`definePlugin` only checks that the model is consistent), a reviewer does.
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
        {
          name: 'delete',
          parent: 'widget',
          cardinalities: ['one'],
          description: 'Verb leaf : the deletion of a widget, a write with its own risk.',
        },
      ],
    },
  ],
};
