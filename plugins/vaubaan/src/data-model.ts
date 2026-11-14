/**
 * Data model of the `vaubaan` provider: what the gateway's own management
 * tools read and change.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/providers/vaubaan.md.
 *
 * Three planes, one root each:
 *
 *   accounts   the accounts the person may build a mission from (their own and
 *              the ones shared with them), with their resources;
 *   catalogs   the risk catalog of a service the gateway ships;
 *   missions   the person's missions, with three verb leaves: `issue` (a new
 *              mission), `token` (its key replaced), `revoke` (stopped for good).
 *
 * The account itself carries no resource: a call names no resource of the
 * mission, so nothing is `envScopable`, and the gateway has no environment.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

export const vaubaanDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'accounts',
      description: 'The accounts the person may build a mission from.',
      entities: [
        {
          name: 'account',
          parent: null,
          cardinalities: ['one', 'unbounded'],
          description:
            'An account the person owns or that is shared with them: its permissions, resources and macro-actions.',
        },
      ],
    },
    {
      slug: 'catalogs',
      description: 'The risk catalogs of the services this gateway ships.',
      entities: [
        {
          name: 'catalog',
          parent: null,
          cardinalities: ['one'],
          description: 'The risk catalog of one service, named by its id (`github`).',
        },
      ],
    },
    {
      slug: 'missions',
      description: "The person's missions.",
      entities: [
        {
          name: 'mission',
          parent: null,
          cardinalities: ['one', 'unbounded'],
          description: 'A mission the person created, or one shared with them as a member.',
        },
        {
          name: 'issue',
          parent: 'mission',
          cardinalities: ['one'],
          description: 'Verb leaf: a new mission issued in the person’s name.',
        },
        {
          name: 'token',
          parent: 'mission',
          cardinalities: ['one'],
          description: 'Verb leaf: the key of a mission replaced, the old one refused at once.',
        },
        {
          name: 'revoke',
          parent: 'mission',
          cardinalities: ['one'],
          description: 'Verb leaf: a mission stopped for good.',
        },
      ],
    },
  ],
};
