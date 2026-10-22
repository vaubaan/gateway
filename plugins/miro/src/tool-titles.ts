/**
 * What each `miro` tool does, in a few words a person reads at a glance
 * (`ProviderPlugin.toolTitles`) : the head of an approval request, before the
 * board the call resolves to ("Update what is drawn · Retro board"). For
 * people only : never part of `tools/list`.
 */

import { TOOL } from './identity.ts';

export const miroToolTitles: Readonly<Record<string, string>> = {
  [TOOL.listBoards]: 'List the boards',
  [TOOL.boardCreate]: 'Create a board',
  [TOOL.canvasSearch]: 'Search a board',
  [TOOL.canvasReadAsSvg]: 'Read what is drawn',
  [TOOL.canvasCreateFromSvg]: 'Draw new items',
  [TOOL.canvasUpdateFromSvg]: 'Update what is drawn (may delete)',
  [TOOL.canvasComposerSkill]: 'Read the canvas format guide',
  [TOOL.canvasFormatSkill]: 'Read a format guide',
  [TOOL.commentListComments]: 'Read the comments',
  [TOOL.commentCreate]: 'Write a comment',
  [TOOL.commentReply]: 'Reply to a comment',
  [TOOL.commentResolve]: 'Resolve a comment',
  [TOOL.imageGetData]: 'Read an image',
  [TOOL.imageGetUrl]: "Get an image's download link",
  [TOOL.imageCreate]: 'Add an image',
  [TOOL.prototypeRead]: 'Read a prototype',
  [TOOL.prototypeCreate]: 'Create a prototype',
  [TOOL.tableCreate]: 'Create a table',
  [TOOL.tableListRows]: "Read a table's rows",
  [TOOL.tableSyncRows]: "Add or update a table's rows",
  [TOOL.tableUpdateHistory]: "Read a table's latest changes",
  [TOOL.tableUpdateView]: "Change a table's view",
};
