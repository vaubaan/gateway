/**
 * Data model of the `vaubaan` service: what the gateway's own management
 * tools read and change.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/services/vaubaan.md.
 *
 * Three planes, one root each:
 *
 *   accounts   the accounts the person may build a mission from (their own and
 *              the ones shared with them), with their resources;
 *   catalogs   the risk catalog of a service the gateway ships;
 *   missions   the person's missions, with five verb leaves: `issue` (a new
 *              mission), `rename` (its name changed), `edit` (its accounts,
 *              resources, permissions or end changed), `token` (its key replaced),
 *              `revoke` (stopped for good).
 *
 * The account itself carries no resource: a call names no resource of the
 * mission, so nothing is `envScopable`, and the gateway has no environment.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { SERVICE_ID } from './identity.ts';

export const vaubaanDataModel: DataModel = {
  service: SERVICE_ID,
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
          name: 'rename',
          parent: 'mission',
          cardinalities: ['one'],
          description: 'Verb leaf: the name of a mission changed, nothing else.',
        },
        {
          name: 'edit',
          parent: 'mission',
          cardinalities: ['one'],
          description:
            'Verb leaf: a mission changed after issuance — its accounts, resources, permissions, limits or end — within the person’s authority.',
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
