/**
 * Google Drive data model — the entity graph the classifier's slices and the
 * catalog's patterns are written on.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/services/google-drive.md.
 *
 * One plane, rooted at `drive`: the drive of one Google account, whose
 * identifier is the resource ref (the account's address with `@` written
 * `~`). `folder` and `file` are named by their Drive id, or without one for
 * a creation; `content` is a verb leaf, reading what a file holds rather than
 * what it is called.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { SERVICE_ID } from './identity.ts';

export const googleDriveDataModel: DataModel = {
  service: SERVICE_ID,
  planes: [
    {
      slug: 'drive',
      description: 'The files and folders one Google account can open.',
      entities: [
        {
          name: 'drive',
          parent: null,
          cardinalities: ['one', 'unbounded'],
          description:
            'The resource an account exposes: what the account can open in Drive. Its identifier is the ref (alice~acme.com); an address the slice grammar cannot carry is written [*].',
        },
        {
          name: 'folder',
          parent: 'drive',
          cardinalities: ['one', 'unbounded'],
          description:
            'A folder, by its Drive id (`root` for the top of My Drive); without an identifier, a new one.',
        },
        {
          name: 'file',
          parent: 'drive',
          cardinalities: ['one', 'unbounded'],
          description:
            'A file, by its Drive id; a search is [*]; without an identifier, a new one.',
        },
        {
          name: 'content',
          parent: 'file',
          cardinalities: ['one'],
          description: 'Verb leaf: reading what a file holds, not only its name and type.',
        },
      ],
    },
  ],
};
