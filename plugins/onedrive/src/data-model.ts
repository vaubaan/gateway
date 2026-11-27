/**
 * OneDrive data model — the entity graph the classifier's slices and the
 * catalog's patterns are written on.
 *
 * Spec     : docs/spec/gateway-risk-model.md §2.
 * Handbook : docs/handbook/services/onedrive.md.
 *
 * One plane, rooted at `drive`: the OneDrive of one Microsoft account, whose
 * identifier is the resource ref (the account's address with `@` written
 * `~`). `folder` and `file` are named by their item id (`[*]` when it holds
 * a `!`, as personal OneDrive ids do), or without one for a creation; `content` is a verb leaf, reading what a file holds rather than
 * what it is called.
 */

import type { DataModel } from '@vaubaan/plugin-sdk';

import { SERVICE_ID } from './identity.ts';

export const oneDriveDataModel: DataModel = {
  service: SERVICE_ID,
  planes: [
    {
      slug: 'drive',
      description: "The files and folders of one Microsoft account's OneDrive.",
      entities: [
        {
          name: 'drive',
          parent: null,
          cardinalities: ['one', 'unbounded'],
          description:
            'The resource an account exposes: its OneDrive. Its identifier is the ref (alice~contoso.com); an address the slice grammar cannot carry is written [*].',
        },
        {
          name: 'folder',
          parent: 'drive',
          cardinalities: ['one', 'unbounded'],
          description:
            'A folder, by its item id (`root` for the top of the drive; [*] for an id the slice grammar cannot carry); without an identifier, a new one.',
        },
        {
          name: 'file',
          parent: 'drive',
          cardinalities: ['one', 'unbounded'],
          description:
            'A file, by its item id; a search, or an id the slice grammar cannot carry, is [*]; without an identifier, a new one.',
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
