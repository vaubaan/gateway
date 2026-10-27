/**
 * Data model of the `fly` provider.
 *
 * Spec : docs/spec/gateway-risk-model.md §2. Handbook : docs/handbook/providers/fly.md.
 *
 * One plane, `apps`. The organization is the root (one per connection) ; the
 * app is the resource the owner labels `staging` or `prod`. Operations that
 * deserve their own decision are verb leaves with names of their own
 * (`app-destroy`, `machine-destroy`, `image`, `exec`…), so that every leaf
 * name is unique in the plane.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { PROVIDER_ID } from './identity.ts';

const one = ['one'] as const;
const many = ['one', 'unbounded'] as const;

export const flyDataModel: DataModel = {
  provider: PROVIDER_ID,
  planes: [
    {
      slug: 'apps',
      description: 'A Fly organization, its apps and what runs and is stored in them.',
      entities: [
        {
          name: 'org',
          parent: null,
          cardinalities: one,
          description: 'The organization of the connection ; never a mission resource.',
        },
        {
          name: 'region',
          parent: 'org',
          cardinalities: ['unbounded'],
          description: 'Platform regions (read only).',
        },
        {
          name: 'app',
          parent: 'org',
          cardinalities: many,
          description:
            'A Fly app, named by its app name — the resource, labelled staging / prod by its owner. ' +
            'Without an id : the collection, written by a creation.',
          envScopable: true,
        },
        {
          name: 'app-destroy',
          parent: 'app',
          cardinalities: one,
          description: 'Verb leaf : destroying the app with its machines, volumes and snapshots.',
        },
        {
          name: 'machine',
          parent: 'app',
          cardinalities: many,
          description:
            'A machine (VM) of the app ; without an id, the collection a creation writes.',
        },
        {
          name: 'config',
          parent: 'machine',
          cardinalities: one,
          description:
            'The whole configuration of a machine : env, processes, files, services, mounts.',
        },
        {
          name: 'image',
          parent: 'machine',
          cardinalities: one,
          description: 'The image a machine runs.',
        },
        {
          name: 'guest',
          parent: 'machine',
          cardinalities: one,
          description: 'CPU and memory of a machine.',
        },
        {
          name: 'power',
          parent: 'machine',
          cardinalities: one,
          description: 'Start, stop, restart, suspend, cordon, uncordon.',
        },
        {
          name: 'exec',
          parent: 'machine',
          cardinalities: one,
          description: 'Verb leaf : running a command inside the machine.',
        },
        {
          name: 'machine-destroy',
          parent: 'machine',
          cardinalities: one,
          description: 'Verb leaf : destroying the machine.',
        },
        {
          name: 'event',
          parent: 'machine',
          cardinalities: ['unbounded'],
          description: 'The events of a machine (read only).',
        },
        {
          name: 'process',
          parent: 'machine',
          cardinalities: ['unbounded'],
          description: 'The processes of a machine (read only).',
        },
        {
          name: 'volume',
          parent: 'app',
          cardinalities: many,
          description: 'A volume of the app ; without an id, the collection a creation writes.',
        },
        {
          name: 'restore',
          parent: 'volume',
          cardinalities: one,
          description: 'A creation that copies data from a snapshot or another volume.',
        },
        {
          name: 'extend',
          parent: 'volume',
          cardinalities: one,
          description: 'Growing a volume ; it never shrinks.',
        },
        {
          name: 'backup-settings',
          parent: 'volume',
          cardinalities: one,
          description: 'Automatic daily snapshots and their retention.',
        },
        {
          name: 'snapshot',
          parent: 'volume',
          cardinalities: many,
          description: 'Snapshots of a volume : read as a list, written by taking one.',
        },
        {
          name: 'volume-destroy',
          parent: 'volume',
          cardinalities: one,
          description: 'Verb leaf : destroying the volume.',
        },
        {
          name: 'secret',
          parent: 'app',
          cardinalities: ['one', 'bounded', 'unbounded'],
          description: 'App secrets, by name ; values are never read.',
        },
        {
          name: 'ip',
          parent: 'app',
          cardinalities: many,
          description:
            'IP addresses of the app ; without an id, the collection an allocation writes.',
        },
        {
          name: 'ip-release',
          parent: 'ip',
          cardinalities: one,
          description: 'Verb leaf : releasing an address.',
        },
        {
          name: 'certificate',
          parent: 'app',
          cardinalities: many,
          description: 'TLS certificates of the app, by hostname.',
        },
        {
          name: 'certificate-remove',
          parent: 'certificate',
          cardinalities: one,
          description: 'Verb leaf : removing a certificate.',
        },
        {
          name: 'logs',
          parent: 'app',
          cardinalities: one,
          description: 'What the app printed (read only).',
        },
      ],
    },
  ],
};
