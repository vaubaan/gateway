/**
 * MCP tools of the `miro` provider.
 *
 * Handbook : docs/handbook/providers/miro.md §2.
 *
 * Naming : `miro__<verb>_<noun>`, built once in `identity.ts` (`TOOL`). Every
 * tool but `list_boards` takes `board`, the board ref of the mission ; the
 * classifier falls back to the mission's single board when it is absent and
 * refuses a ref the mission does not hold. The `properties` of each schema
 * are the whole argument surface of the tool : anything else is refused
 * (`call.ts`, `undeclaredArgument`), and the keys of `data`, `style`,
 * `position` and `geometry` are closed per item type (`bodies.ts`).
 */

import type { McpToolDeclaration } from '@vaubaan/plugin-sdk';

import {
  BODY_SHAPES,
  BULK_ELEMENT_KEYS,
  CAPTION_KEYS,
  CONNECTOR_SHAPES,
  CONNECTOR_STYLE_KEYS,
  ITEM_KINDS,
  LIST_ITEM_TYPES,
  MAX_BULK_ITEMS,
  MAX_CAPTIONS,
  MAX_TAG_TITLE_LENGTH,
  POSITION_FIELDS,
  SNAP_VALUES,
  TAG_COLORS,
  type WritableKind,
} from './bodies.ts';
import { TOOL } from './identity.ts';

type Schema = Readonly<Record<string, unknown>>;

const board: Schema = {
  type: 'string',
  description:
    'Board ref, as list_boards shows it (the Miro id with its trailing = written ~). May be omitted when the mission holds one board.',
};

const id = (what: string): Schema => ({
  type: 'string',
  description: `Id of the ${what} (a numeric string).`,
});

/** An object whose keys are closed to `keys`, values flat. */
function fields(keys: readonly string[], description: string): Schema {
  return {
    type: 'object',
    description: `${description} Only these keys: ${keys.join(', ')}.`,
    properties: Object.fromEntries(keys.map((key) => [key, {}])),
    additionalProperties: false,
  };
}

function itemFields(kind: WritableKind): Readonly<Record<string, Schema>> {
  const shape = BODY_SHAPES[kind];
  return {
    data: fields(shape.data, 'Content of the item, as Miro names it.'),
    style: fields(shape.style, 'Style of the item, as Miro names it.'),
    position: fields(
      POSITION_FIELDS,
      'Position on the board (x, y; the centre of the board is 0, 0).',
    ),
    geometry: fields(shape.geometry, 'Size in pixels.'),
    ...(shape.parent
      ? {
          parent_frame_id: {
            type: ['string', 'null'],
            description: 'Id of the frame to put the item in; null to put it on the canvas.',
          },
        }
      : {}),
  };
}

const limit = (min: number, max: number): Schema => ({
  type: 'integer',
  minimum: min,
  maximum: max,
  description: `Page size, ${min} to ${max}.`,
});

const cursor: Schema = { type: 'string', description: 'The cursor of the previous page.' };

interface TypedTools {
  readonly create: string;
  readonly update: string;
  readonly remove: string;
}

const TYPED: ReadonlyArray<readonly [WritableKind, string, TypedTools]> = [
  [
    'sticky_note',
    'sticky note',
    {
      create: TOOL.createStickyNote,
      update: TOOL.updateStickyNote,
      remove: TOOL.deleteStickyNote,
    },
  ],
  [
    'shape',
    'shape',
    { create: TOOL.createShape, update: TOOL.updateShape, remove: TOOL.deleteShape },
  ],
  ['text', 'text', { create: TOOL.createText, update: TOOL.updateText, remove: TOOL.deleteText }],
  ['card', 'card', { create: TOOL.createCard, update: TOOL.updateCard, remove: TOOL.deleteCard }],
  [
    'frame',
    'frame',
    { create: TOOL.createFrame, update: TOOL.updateFrame, remove: TOOL.deleteFrame },
  ],
];

function typedTools(kind: WritableKind, noun: string, names: TypedTools): McpToolDeclaration[] {
  const idArg = kind === 'frame' ? 'frame_id' : 'item_id';
  const required = BODY_SHAPES[kind].requiredOnCreate.data ? ['data'] : [];
  return [
    {
      name: names.create,
      description: `Add a ${noun} to a board.`,
      inputSchema: {
        type: 'object',
        properties: { board, ...itemFields(kind) },
        required,
      },
    },
    {
      name: names.update,
      description: `Edit a ${noun}: its content, style, position or size${BODY_SHAPES[kind].parent ? ', or the frame it is in' : ''}.`,
      inputSchema: {
        type: 'object',
        properties: { board, [idArg]: id(noun), ...itemFields(kind) },
        required: [idArg],
      },
    },
    {
      name: names.remove,
      description:
        kind === 'frame'
          ? 'Delete a frame. The items inside may go with it; there is no restore.'
          : `Delete a ${noun}, and the connectors attached to it. There is no restore.`,
      inputSchema: {
        type: 'object',
        properties: { board, [idArg]: id(noun) },
        required: [idArg],
      },
    },
  ];
}

const snap: Schema = {
  type: 'string',
  enum: [...SNAP_VALUES],
  description: 'Where the end snaps.',
};

const connectorFields: Readonly<Record<string, Schema>> = {
  start_item_id: id('item the connector starts from'),
  end_item_id: id('item the connector ends at'),
  start_snap_to: snap,
  end_snap_to: snap,
  shape: { type: 'string', enum: [...CONNECTOR_SHAPES] },
  captions: {
    type: 'array',
    maxItems: MAX_CAPTIONS,
    items: fields(CAPTION_KEYS, 'A text on the connector (content: at most 200 characters).'),
  },
  style: fields(CONNECTOR_STYLE_KEYS, 'Style of the line, as Miro names it.'),
};

export const miroTools: readonly McpToolDeclaration[] = [
  // ─── Reads ────────────────────────────────────────────────────────────────
  {
    name: TOOL.listBoards,
    description: 'List the boards of this mission, with their details.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: TOOL.getBoard,
    description: 'Read the details of a board.',
    inputSchema: { type: 'object', properties: { board } },
  },
  {
    name: TOOL.listItems,
    description:
      'List the items of a board, one page at a time (pass back the cursor of the answer).',
    inputSchema: {
      type: 'object',
      properties: {
        board,
        type: { type: 'string', enum: [...LIST_ITEM_TYPES] },
        parent_frame_id: id('frame whose items to list'),
        limit: limit(10, 50),
        cursor,
      },
    },
  },
  {
    name: TOOL.getItem,
    description: 'Read one item of a board, whatever its type.',
    inputSchema: {
      type: 'object',
      properties: { board, item_id: id('item') },
      required: ['item_id'],
    },
  },
  {
    name: TOOL.listConnectors,
    description: 'List the connectors of a board, one page at a time.',
    inputSchema: { type: 'object', properties: { board, limit: limit(10, 50), cursor } },
  },
  {
    name: TOOL.getConnector,
    description: 'Read one connector.',
    inputSchema: {
      type: 'object',
      properties: { board, connector_id: id('connector') },
      required: ['connector_id'],
    },
  },
  {
    name: TOOL.listTags,
    description: 'List the tags of a board.',
    inputSchema: {
      type: 'object',
      properties: {
        board,
        limit: limit(1, 50),
        offset: { type: 'integer', minimum: 0, maximum: 10000 },
      },
    },
  },
  {
    name: TOOL.listItemTags,
    description: 'List the tags attached to an item.',
    inputSchema: {
      type: 'object',
      properties: { board, item_id: id('item') },
      required: ['item_id'],
    },
  },

  // ─── Items and frames ────────────────────────────────────────────────────
  ...TYPED.flatMap(([kind, noun, names]) => typedTools(kind, noun, names)),

  // ─── Connectors ──────────────────────────────────────────────────────────
  {
    name: TOOL.createConnector,
    description: 'Draw a connector between two items of a board.',
    inputSchema: {
      type: 'object',
      properties: { board, ...connectorFields },
      required: ['start_item_id', 'end_item_id'],
    },
  },
  {
    name: TOOL.updateConnector,
    description: 'Edit a connector: its ends, shape, captions or style.',
    inputSchema: {
      type: 'object',
      properties: { board, connector_id: id('connector'), ...connectorFields },
      required: ['connector_id'],
    },
  },
  {
    name: TOOL.deleteConnector,
    description: 'Delete a connector. The two items stay.',
    inputSchema: {
      type: 'object',
      properties: { board, connector_id: id('connector') },
      required: ['connector_id'],
    },
  },

  // ─── Tags ────────────────────────────────────────────────────────────────
  {
    name: TOOL.createTag,
    description: 'Create a tag on a board.',
    inputSchema: {
      type: 'object',
      properties: {
        board,
        title: { type: 'string', minLength: 1, maxLength: MAX_TAG_TITLE_LENGTH },
        fill_color: { type: 'string', enum: [...TAG_COLORS] },
      },
      required: ['title'],
    },
  },
  {
    name: TOOL.attachTag,
    description: 'Attach a tag of the board to a card or a sticky note.',
    inputSchema: {
      type: 'object',
      properties: { board, item_id: id('item'), tag_id: id('tag') },
      required: ['item_id', 'tag_id'],
    },
  },
  {
    name: TOOL.removeTag,
    description: 'Remove a tag from an item. The tag stays on the board.',
    inputSchema: {
      type: 'object',
      properties: { board, item_id: id('item'), tag_id: id('tag') },
      required: ['item_id', 'tag_id'],
    },
  },

  // ─── Bulk ────────────────────────────────────────────────────────────────
  {
    name: TOOL.createItems,
    description: `Add 1 to ${MAX_BULK_ITEMS} sticky notes, shapes, texts or cards in one call, all or none. Each item takes the fields of the tool that creates its type.`,
    inputSchema: {
      type: 'object',
      properties: {
        board,
        items: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_BULK_ITEMS,
          items: {
            type: 'object',
            properties: Object.fromEntries(
              BULK_ELEMENT_KEYS.map((key) => [
                key,
                key === 'type' ? { type: 'string', enum: [...ITEM_KINDS] } : {},
              ]),
            ),
            required: ['type'],
            additionalProperties: false,
          },
        },
      },
      required: ['items'],
    },
  },
];
