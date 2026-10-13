/**
 * MCP tools of the `template` provider.
 *
 * Naming : `<provider>__<verb>_<noun>`, provider id with `-` turned into `_`.
 * The names are built once in `identity.ts` (`TOOL`) from the provider id.
 * Every tool takes the `workspace` ref explicitly ; the classifier falls
 * back to the mission's single workspace when the argument is absent and
 * refuses a ref that is not one of the mission's resources.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

const workspaceArg = {
  workspace: { type: 'string', description: 'Workspace ref, as listed in the mission catalog.' },
};

export const templateTools: readonly McpToolDeclaration[] = [
  {
    name: TOOL.listWidgets,
    description: 'List the widgets of a workspace.',
    inputSchema: { type: 'object', properties: { ...workspaceArg }, required: ['workspace'] },
  },
  {
    name: TOOL.getWidget,
    description: 'Read one widget.',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceArg, widget_id: { type: 'string' } },
      required: ['workspace', 'widget_id'],
    },
  },
  {
    name: TOOL.updateWidget,
    description: 'Rename a widget.',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceArg, widget_id: { type: 'string' }, name: { type: 'string' } },
      required: ['workspace', 'widget_id', 'name'],
    },
  },
];
