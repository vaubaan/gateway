/**
 * MCP tools of the `template` provider.
 *
 * Naming : `<provider>__<verb>_<noun>`, provider id with `-` turned into `_`.
 * Every tool takes the `workspace` ref explicitly ; the classifier falls
 * back to the mission's single workspace when the argument is absent.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

const workspaceArg = {
  workspace: { type: 'string', description: 'Workspace ref, as listed in the mission catalog.' },
};

export const templateTools: readonly McpToolDeclaration[] = [
  {
    name: 'template__list_widgets',
    description: 'List the widgets of a workspace.',
    inputSchema: { type: 'object', properties: { ...workspaceArg }, required: ['workspace'] },
  },
  {
    name: 'template__get_widget',
    description: 'Read one widget.',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceArg, widget_id: { type: 'string' } },
      required: ['workspace', 'widget_id'],
    },
  },
  {
    name: 'template__update_widget',
    description: 'Rename a widget.',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceArg, widget_id: { type: 'string' }, name: { type: 'string' } },
      required: ['workspace', 'widget_id', 'name'],
    },
  },
];
