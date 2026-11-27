/**
 * MCP tools of the `google-drive` service, and their titles.
 *
 * Every tool takes the drive ref (`drive`) optionally: a mission holding one
 * drive needs none. No tool shares, deletes or changes who may open a file
 * (`EXCLUDED_TOOLS`).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { DRIVE_ARGUMENT, TOOL } from './identity.ts';

/** The most items one page lists. */
export const MAX_PAGE_SIZE = 100;
/** The longest text an agent uploads, in bytes of UTF-8. */
export const MAX_UPLOAD_BYTES = 1_000_000;
/** The longest file read as text, in bytes. */
export const MAX_READ_BYTES = 1_000_000;

const driveArg = {
  [DRIVE_ARGUMENT]: {
    type: 'string',
    description:
      'The drive: a ref of the mission (alice~acme.com) or its account address. Optional when the mission holds one drive.',
  },
};
const pageArgs = {
  pageSize: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    description: `Items per page (1 to ${MAX_PAGE_SIZE}, default 50).`,
  },
  pageToken: { type: 'string', description: 'The nextPageToken of the previous page.' },
};

export const googleDriveTools: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listFolder,
    description:
      'List the files and folders inside a folder (not in the trash): id, name, type, size, last change, link. Without folderId, the top of My Drive.',
    inputSchema: {
      type: 'object',
      properties: {
        ...driveArg,
        folderId: { type: 'string', description: "A folder id, or 'root' (the default)." },
        ...pageArgs,
      },
    },
  },
  {
    name: TOOL.searchFiles,
    description:
      'Search the files the account can open, by name and by content (not in the trash): id, name, type, size, last change, link.',
    inputSchema: {
      type: 'object',
      properties: {
        ...driveArg,
        query: { type: 'string', description: 'Words to find, 1 to 200 characters.' },
        ...pageArgs,
      },
      required: ['query'],
    },
  },
  {
    name: TOOL.readFile,
    description: `Read a file as text: a Google Doc as Markdown, a Sheet as CSV (its first sheet), Slides as plain text, a text file as it is. Binary files (PDF, images, Office files) and files over ${MAX_READ_BYTES} bytes are refused.`,
    inputSchema: {
      type: 'object',
      properties: { ...driveArg, fileId: { type: 'string', description: 'The file id.' } },
      required: ['fileId'],
    },
  },
  {
    name: TOOL.uploadFile,
    description: `Create a new text file in a folder (a file of the same name is not replaced: Drive keeps both). Up to ${MAX_UPLOAD_BYTES} bytes. Whoever can open the folder sees the file.`,
    inputSchema: {
      type: 'object',
      properties: {
        ...driveArg,
        name: { type: 'string', description: 'The file name, with its extension (notes.md).' },
        content: { type: 'string', description: 'The text of the file.' },
        mimeType: {
          type: 'string',
          description:
            'A text type: text/plain (the default), text/markdown, text/csv, application/json…',
        },
        folderId: { type: 'string', description: "The folder id, or 'root' (the default)." },
      },
      required: ['name', 'content'],
    },
  },
  {
    name: TOOL.createFolder,
    description: 'Create a folder inside a folder. Whoever can open the parent folder sees it.',
    inputSchema: {
      type: 'object',
      properties: {
        ...driveArg,
        name: { type: 'string', description: 'The folder name.' },
        parentId: { type: 'string', description: "The parent folder id, or 'root' (the default)." },
      },
      required: ['name'],
    },
  },
];

/**
 * What each tool does, in a few words a person reads at a glance
 * (`ServicePlugin.toolTitles`): the head of an approval request. For people
 * only: never part of `tools/list`.
 */
export const googleDriveToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listFolder]: 'List a folder',
  [TOOL.searchFiles]: 'Search files',
  [TOOL.readFile]: 'Read a file',
  [TOOL.uploadFile]: 'Upload a file',
  [TOOL.createFolder]: 'Create a folder',
};
