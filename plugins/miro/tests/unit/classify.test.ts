/**
 * `classifyMiro`, branch by branch : the slice of every tool, the board
 * resolution, the closed argument surface (top level and the objects
 * forwarded to Miro), the bounds Miro sets, the bulk elements.
 */
import { describe, expect, test } from 'vitest';

import { serializeSlice, toolPrefixFor, type Resource } from '@vaubaan/plugin-sdk';

import { classifyMiro } from '../../src/classify.ts';
import { PROVIDER_ID, TOOL } from '../../src/identity.ts';
import {
  BOARD,
  CONNECTOR,
  FRAME,
  ITEM,
  ITEM_2,
  OTHER_BOARD,
  SAMPLES,
  TAG,
  retro,
  workshop,
} from './fixtures.ts';

function slices(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [workshop],
): string[] {
  const out = classifyMiro(tool, args, resources);
  if ('denied' in out) throw new Error(out.denied);
  return out.slices.map(serializeSlice);
}

function denied(
  tool: string,
  args: Record<string, unknown>,
  resources: readonly Resource[] = [workshop],
): string {
  const out = classifyMiro(tool, args, resources);
  if (!('denied' in out))
    throw new Error(`expected a denial, got ${out.slices.map(serializeSlice).join(', ')}`);
  return out.denied;
}

const B = `miro.board[${BOARD}]`;

describe('slices', () => {
  test('reads', () => {
    // One slice, the boards read as a list : the audit keeps every one of them.
    expect(slices(TOOL.listBoards, {}, [workshop, retro])).toEqual([
      `miro.board[${BOARD},${OTHER_BOARD}].R`,
    ]);
    expect(slices(TOOL.listBoards, {})).toEqual([`miro.board[${BOARD}].R`]);
    expect(slices(TOOL.getBoard, { board: BOARD })).toEqual([`${B}.R`]);
    expect(slices(TOOL.listItems, { board: BOARD })).toEqual([`${B}.item[*].R`]);
    expect(slices(TOOL.getItem, { board: BOARD, item_id: ITEM })).toEqual([`${B}.item[${ITEM}].R`]);
    expect(slices(TOOL.listConnectors, {})).toEqual([`${B}.connector[*].R`]);
    expect(slices(TOOL.getConnector, { connector_id: CONNECTOR })).toEqual([
      `${B}.connector[${CONNECTOR}].R`,
    ]);
    expect(slices(TOOL.listTags, {})).toEqual([`${B}.tag[*].R`]);
    expect(slices(TOOL.listItemTags, { item_id: ITEM })).toEqual([
      `${B}.item[${ITEM}].tag-link[*].R`,
    ]);
  });

  test('typed item writes : the collection, the item, the delete leaf ; frames apart', () => {
    const prefix = toolPrefixFor(PROVIDER_ID);
    const content: Record<string, Record<string, unknown>> = {
      sticky_note: { content: 'x' },
      shape: { content: 'x' },
      text: { content: 'x' },
      card: { title: 'x' },
    };
    for (const noun of ['sticky_note', 'shape', 'text', 'card']) {
      expect(slices(`${prefix}create_${noun}`, { data: content[noun] })).toEqual([`${B}.item.W`]);
      expect(
        slices(`${prefix}update_${noun}`, {
          item_id: ITEM,
          position: { x: 1, y: 2 },
        }),
      ).toEqual([`${B}.item[${ITEM}].W`]);
      expect(slices(`${prefix}delete_${noun}`, { item_id: ITEM })).toEqual([
        `${B}.item[${ITEM}].delete.W`,
      ]);
    }
    expect(slices(TOOL.createFrame, { data: { title: 'F' } })).toEqual([`${B}.frame.W`]);
    expect(slices(TOOL.updateFrame, { frame_id: FRAME, data: { title: 'G' } })).toEqual([
      `${B}.frame[${FRAME}].W`,
    ]);
    expect(slices(TOOL.deleteFrame, { frame_id: FRAME })).toEqual([
      `${B}.frame[${FRAME}].delete.W`,
    ]);
  });

  test('moving an item into a frame emits no frame slice', () => {
    expect(slices(TOOL.updateStickyNote, { item_id: ITEM, parent_frame_id: FRAME })).toEqual([
      `${B}.item[${ITEM}].W`,
    ]);
    expect(slices(TOOL.updateStickyNote, { item_id: ITEM, parent_frame_id: null })).toEqual([
      `${B}.item[${ITEM}].W`,
    ]);
  });

  test('connectors, tags, bulk', () => {
    expect(slices(TOOL.createConnector, { start_item_id: ITEM, end_item_id: ITEM_2 })).toEqual([
      `${B}.connector.W`,
    ]);
    expect(slices(TOOL.updateConnector, { connector_id: CONNECTOR, shape: 'curved' })).toEqual([
      `${B}.connector[${CONNECTOR}].W`,
    ]);
    expect(slices(TOOL.deleteConnector, { connector_id: CONNECTOR })).toEqual([
      `${B}.connector[${CONNECTOR}].delete.W`,
    ]);
    expect(slices(TOOL.createTag, { title: 'Urgent' })).toEqual([`${B}.tag.W`]);
    for (const tool of [TOOL.attachTag, TOOL.removeTag]) {
      expect(slices(tool, { item_id: ITEM, tag_id: TAG })).toEqual([
        `${B}.item[${ITEM}].tag-link[${TAG}].W`,
      ]);
    }
    expect(slices(TOOL.createItems, { items: [{ type: 'shape' }] })).toEqual([
      `${B}.item.bulk-create.W`,
    ]);
  });

  test('every sample slice reads back as itself', () => {
    for (const [tool, samples] of Object.entries(SAMPLES)) {
      for (const sample of samples) {
        const out = classifyMiro(tool, sample.args, sample.resources ?? [workshop]);
        if ('denied' in out) continue;
        for (const s of out.slices) expect(serializeSlice(s)).toMatch(/^miro\.board\[/);
      }
    }
  });
});

describe('board resolution', () => {
  test('a board outside the mission is refused, never replaced by the single board', () => {
    expect(denied(TOOL.getBoard, { board: OTHER_BOARD })).toBe(
      `board '${OTHER_BOARD}' is not selected in this mission`,
    );
    const foreign: Resource = { provider: 'other', ref: OTHER_BOARD, displayName: 'Foreign' };
    expect(denied(TOOL.getBoard, { board: OTHER_BOARD }, [workshop, foreign])).toBe(
      `board '${OTHER_BOARD}' is not selected in this mission`,
    );
  });

  test('absent : the single board ; none or several is refused', () => {
    expect(slices(TOOL.getBoard, {})).toEqual([`${B}.R`]);
    expect(denied(TOOL.getBoard, {}, [workshop, retro])).toBe(
      'board: argument missing and the mission touches 2 Miro boards — name one',
    );
    expect(denied(TOOL.getBoard, {}, [])).toBe(
      'board: argument missing and the mission touches no Miro board',
    );
    expect(denied(TOOL.listBoards, {}, [])).toBe('the mission touches no Miro board');
  });

  test('list_boards reads at most 50 boards', () => {
    const many = Array.from(
      { length: 51 },
      (_, i): Resource => ({
        provider: PROVIDER_ID,
        ref: `board${i}~`,
        displayName: `B${i}`,
      }),
    );
    expect(denied(TOOL.listBoards, {}, many)).toMatch(/at most 50/);
    const fifty = slices(TOOL.listBoards, {}, many.slice(0, 50));
    expect(fifty).toHaveLength(1);
    expect(fifty[0]).toBe(
      `miro.board[${many
        .slice(0, 50)
        .map((b) => b.ref)
        .join(',')}].R`,
    );
  });

  test('a malformed board is refused', () => {
    expect(denied(TOOL.getBoard, { board: 42 })).toBe('board: malformed board ref');
    expect(denied(TOOL.getBoard, { board: 'a b' })).toBe('board: malformed board ref');
  });
});

describe('refusals', () => {
  test('an unknown tool, an undeclared argument', () => {
    const unknown = `${toolPrefixFor(PROVIDER_ID)}delete_board`;
    expect(denied(unknown, {})).toBe(`unknown miro tool '${unknown}'`);
    expect(denied(TOOL.getItem, { item_id: ITEM, assignee: 'x' })).toBe(
      `assignee: not an argument of '${TOOL.getItem}' — nothing classifies it, so it is not sent.`,
    );
    // A card's `assigneeId` is a field of no allowlist.
    expect(denied(TOOL.createCard, { data: { title: 'T', assigneeId: '123' } })).toMatch(
      /^data\.assigneeId: not a field this tool sends to Miro/,
    );
  });

  test('missing ids', () => {
    expect(denied(TOOL.getItem, {})).toBe('item_id: missing');
    expect(denied(TOOL.deleteFrame, {})).toBe('frame_id: missing');
    expect(denied(TOOL.getConnector, {})).toBe('connector_id: missing');
    expect(denied(TOOL.attachTag, { item_id: ITEM })).toBe('tag_id: missing');
  });

  test('the objects forwarded to Miro are closed, flat and typed', () => {
    expect(denied(TOOL.createStickyNote, { data: 'text' })).toBe('data: expected an object');
    expect(denied(TOOL.createStickyNote, { data: ['x'] })).toBe('data: expected an object');
    expect(denied(TOOL.createStickyNote, { style: { fontSize: '14' } })).toMatch(
      /^style\.fontSize: not a field/,
    );
    expect(denied(TOOL.createStickyNote, { geometry: { rotation: 10 } })).toMatch(
      /^geometry\.rotation: not a field/,
    );
    expect(denied(TOOL.createShape, { data: { content: { nested: true } } })).toBe(
      'data.content: expected a string, a number, a boolean or null',
    );
    expect(denied(TOOL.createShape, { position: { x: 0, y: 0, origin: 'center' } })).toMatch(
      /^position\.origin: not a field/,
    );
    expect(denied(TOOL.createShape, { data: { 'bad key': 1 } })).toMatch(
      /^data\.a field with a malformed name: not a field/,
    );
  });

  test('required content, a frame without parent, an empty update', () => {
    expect(denied(TOOL.createText, {})).toBe('data: required to create a text');
    expect(denied(TOOL.createText, { data: {} })).toBe('data.content: required to create a text');
    expect(denied(TOOL.createFrame, {})).toBe('data: required to create a frame');
    expect(denied(TOOL.updateCard, { item_id: ITEM })).toMatch(/^nothing to change/);
    expect(denied(TOOL.updateConnector, { connector_id: CONNECTOR })).toMatch(/^nothing to change/);
    // The frame tools do not declare parent_frame_id at all.
    expect(denied(TOOL.createFrame, { data: {}, parent_frame_id: FRAME })).toMatch(
      /^parent_frame_id: not an argument/,
    );
  });

  test('connectors : distinct ends, snap and shape values, captions', () => {
    expect(denied(TOOL.createConnector, { start_item_id: ITEM, end_item_id: ITEM })).toBe(
      'end_item_id: must differ from start_item_id',
    );
    expect(denied(TOOL.createConnector, { start_item_id: ITEM })).toBe('end_item_id: missing');
    expect(
      denied(TOOL.createConnector, { start_item_id: ITEM, end_item_id: ITEM_2, end_snap_to: 'up' }),
    ).toMatch(/^end_snap_to: expected one of/);
    expect(denied(TOOL.updateConnector, { connector_id: CONNECTOR, start_snap_to: 'top' })).toBe(
      'start_snap_to: give start_item_id with it',
    );
    expect(
      denied(TOOL.createConnector, { start_item_id: ITEM, end_item_id: ITEM_2, shape: 'zigzag' }),
    ).toMatch(/^shape: expected one of/);
    const tooMany = Array.from({ length: 21 }, () => ({ content: 'c' }));
    expect(
      denied(TOOL.createConnector, { start_item_id: ITEM, end_item_id: ITEM_2, captions: tooMany }),
    ).toMatch(/^captions: expected a list of at most 20/);
    expect(
      denied(TOOL.createConnector, {
        start_item_id: ITEM,
        end_item_id: ITEM_2,
        captions: [{ content: 'x'.repeat(201) }],
      }),
    ).toMatch(/^captions\[0\]\.content: expected a text of at most 200/);
    expect(
      denied(TOOL.createConnector, {
        start_item_id: ITEM,
        end_item_id: ITEM_2,
        captions: [{ content: 'ok', color: 'red' }],
      }),
    ).toMatch(/^captions\[0\]\.color: not a field/);
  });

  test("Miro's bounds : limits, offset, type, tag title and colour", () => {
    expect(denied(TOOL.listItems, { limit: 5 })).toBe('limit: expected an integer from 10 to 50');
    expect(denied(TOOL.listItems, { limit: '20' })).toBe(
      'limit: expected an integer from 10 to 50',
    );
    expect(denied(TOOL.listConnectors, { limit: 51 })).toBe(
      'limit: expected an integer from 10 to 50',
    );
    expect(denied(TOOL.listTags, { limit: 0 })).toBe('limit: expected an integer from 1 to 50');
    expect(denied(TOOL.listTags, { offset: -1 })).toBe(
      'offset: expected an integer from 0 to 10000',
    );
    expect(denied(TOOL.listItems, { type: 'connector' })).toMatch(/^type: expected one of/);
    expect(denied(TOOL.listItems, { parent_frame_id: 'x' })).toBe('parent_frame_id: malformed id');
    expect(denied(TOOL.createTag, { title: '' })).toMatch(/^title: expected a text of 1 to 120/);
    expect(denied(TOOL.createTag, { title: 'x'.repeat(121) })).toMatch(/^title:/);
    expect(denied(TOOL.createTag, { title: 'ok', fill_color: 'pink' })).toMatch(
      /^fill_color: expected one of/,
    );
  });

  test('bulk : 1 to 20 elements of the four item types, each closed like its typed tool', () => {
    expect(denied(TOOL.createItems, {})).toBe('items: expected a list of 1 to 20 items');
    expect(denied(TOOL.createItems, { items: [] })).toBe('items: expected a list of 1 to 20 items');
    const many = Array.from({ length: 21 }, () => ({ type: 'shape' }));
    expect(denied(TOOL.createItems, { items: many })).toBe(
      'items: expected a list of 1 to 20 items',
    );
    expect(denied(TOOL.createItems, { items: ['x'] })).toBe('items[0]: expected an object');
    expect(denied(TOOL.createItems, { items: [{ type: 'frame', data: {} }] })).toBe(
      'items[0].type: expected one of sticky_note, shape, text, card',
    );
    expect(denied(TOOL.createItems, { items: [{ type: 'image', data: { url: 'x' } }] })).toMatch(
      /^items\[0\]\.type/,
    );
    expect(denied(TOOL.createItems, { items: [{ type: 'shape', parent: { id: FRAME } }] })).toMatch(
      /^items\[0\]\.parent: not a field of an item/,
    );
    expect(
      denied(TOOL.createItems, {
        items: [{ type: 'shape' }, { type: 'card', data: { assigneeId: '1' } }],
      }),
    ).toMatch(/^items\[1\]\.data\.assigneeId: not a field/);
    expect(denied(TOOL.createItems, { items: [{ type: 'text' }] })).toBe(
      'items[0].data: required to create a text',
    );
  });
});
