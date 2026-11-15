/**
 * MCP tools of the `template` service.
 *
 * Naming : `<service>__<verb>_<noun>`, service id with `-` turned into `_`.
 * The names are built once in `identity.ts` (`TOOL`) from the service id.
 * Every tool takes the `workspace` ref explicitly ; the classifier falls
 * back to the mission's single workspace when the argument is absent and
 * refuses a ref that is not one of the mission's resources.
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import { TOOL } from './identity.ts';

const workspaceArg = {
  workspace: { type: 'string', description: 'Workspace id, one of the workspaces of the mission.' },
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
  {
    name: TOOL.deleteWidget,
    description: 'Delete a widget. Cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceArg, widget_id: { type: 'string' } },
      required: ['workspace', 'widget_id'],
    },
  },
];

/**
 * What each tool does, in a few words a person reads at a glance
 * (`ServicePlugin.toolTitles`) : the head of an approval request in the web
 * interface, before the resource the call resolves to. A verb and its object,
 * sentence case, no final period. For people only : never part of `tools/list`.
 */
export const templateToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listWidgets]: 'List widgets',
  [TOOL.getWidget]: 'Read a widget',
  [TOOL.updateWidget]: 'Rename a widget',
  [TOOL.deleteWidget]: 'Delete a widget',
};
