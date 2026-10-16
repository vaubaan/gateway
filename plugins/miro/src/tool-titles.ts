/**
 * What each `miro` tool does, in a few words a person reads at a glance
 * (`ProviderPlugin.toolTitles`) : the head of an approval request, before the
 * board the call resolves to ("Delete a frame · Retro board"). For people
 * only : never part of `tools/list`.
 */

import { TOOL } from './identity.ts';

export const miroToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listBoards]: 'List the boards',
  [TOOL.getBoard]: 'Read a board',
  [TOOL.listItems]: "List a board's items",
  [TOOL.getItem]: 'Read an item',
  [TOOL.listConnectors]: 'List connectors',
  [TOOL.getConnector]: 'Read a connector',
  [TOOL.listTags]: "List a board's tags",
  [TOOL.listItemTags]: "List an item's tags",
  [TOOL.createStickyNote]: 'Add a sticky note',
  [TOOL.updateStickyNote]: 'Edit a sticky note',
  [TOOL.deleteStickyNote]: 'Delete a sticky note',
  [TOOL.createShape]: 'Add a shape',
  [TOOL.updateShape]: 'Edit a shape',
  [TOOL.deleteShape]: 'Delete a shape',
  [TOOL.createText]: 'Add a text',
  [TOOL.updateText]: 'Edit a text',
  [TOOL.deleteText]: 'Delete a text',
  [TOOL.createCard]: 'Add a card',
  [TOOL.updateCard]: 'Edit a card',
  [TOOL.deleteCard]: 'Delete a card',
  [TOOL.createFrame]: 'Add a frame',
  [TOOL.updateFrame]: 'Edit a frame',
  [TOOL.deleteFrame]: 'Delete a frame',
  [TOOL.createConnector]: 'Connect two items',
  [TOOL.updateConnector]: 'Edit a connector',
  [TOOL.deleteConnector]: 'Delete a connector',
  [TOOL.createTag]: 'Create a tag',
  [TOOL.attachTag]: 'Tag an item',
  [TOOL.removeTag]: 'Remove a tag from an item',
  [TOOL.createItems]: 'Add several items at once',
};
