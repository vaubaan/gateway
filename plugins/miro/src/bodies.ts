/**
 * The request bodies of the `miro` provider, read from the arguments and
 * built field by field. Pure : shared by `classify` (through `call.ts`) and
 * `execute`, so what is classified is what is sent.
 *
 * Handbook : docs/handbook/providers/miro.md §2 "Undeclared arguments", §5.3,
 *            §5.5, §5.6, §5.8.
 * ADR      : docs/decisions/plugin-arguments-closed-surface-and-typed-refusals.md.
 *
 * The objects a write forwards to Miro — `data`, `style`, `position`,
 * `geometry` — are closed one level deeper than the tool schema : each key
 * must be on the allowlist of the item type (taken from Miro's request
 * schemas), and each value must be a string, a number, a boolean or `null`.
 * A field Miro adds later, or an undocumented one, is refused instead of
 * reaching the board unpriced.
 */

import { itemId } from './identifiers.ts';

/** The item types the typed tools and the bulk call write. */
export const ITEM_KINDS = ['sticky_note', 'shape', 'text', 'card'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What a typed write tool acts on : an item type, or a frame. */
export type WritableKind = ItemKind | 'frame';

/** The fields Miro takes for one writable type. */
export interface BodyShape {
  readonly data: readonly string[];
  readonly style: readonly string[];
  readonly geometry: readonly string[];
  /** Whether the item may be put in a frame (`parent_frame_id`). Frames take no parent. */
  readonly parent: boolean;
  /** Whether a creation needs `data`, and which key of it. */
  readonly requiredOnCreate: { readonly data: boolean; readonly key?: string };
}

const POSITION_KEYS: readonly string[] = ['x', 'y'];

/**
 * Per type, from Miro's request schemas (StickyNoteCreateRequest,
 * ShapeCreateRequest, TextCreateRequest, CardCreateRequest,
 * FrameCreateRequest and their update twins). A card's `assigneeId` is left
 * out on purpose (handbook §5.8).
 */
export const BODY_SHAPES: Readonly<Record<WritableKind, BodyShape>> = {
  sticky_note: {
    data: ['content', 'shape'],
    style: ['fillColor', 'textAlign', 'textAlignVertical'],
    geometry: ['width', 'height'],
    parent: true,
    requiredOnCreate: { data: false },
  },
  shape: {
    data: ['content', 'shape'],
    style: [
      'borderColor',
      'borderOpacity',
      'borderStyle',
      'borderWidth',
      'color',
      'fillColor',
      'fillOpacity',
      'fontFamily',
      'fontSize',
      'textAlign',
      'textAlignVertical',
    ],
    geometry: ['width', 'height', 'rotation'],
    parent: true,
    requiredOnCreate: { data: false },
  },
  text: {
    data: ['content'],
    style: ['color', 'fillColor', 'fillOpacity', 'fontFamily', 'fontSize', 'textAlign'],
    geometry: ['width', 'rotation'],
    parent: true,
    requiredOnCreate: { data: true, key: 'content' },
  },
  card: {
    data: ['title', 'description', 'dueDate'],
    style: ['cardTheme'],
    geometry: ['width', 'height', 'rotation'],
    parent: true,
    requiredOnCreate: { data: false },
  },
  frame: {
    data: ['format', 'title', 'type', 'showContent'],
    style: ['fillColor'],
    geometry: ['width', 'height'],
    parent: false,
    requiredOnCreate: { data: true },
  },
};

/** The `position` keys, the same for every type. */
export const POSITION_FIELDS = POSITION_KEYS;

/** Miro's item types, as the `type` filter of `GET /items` takes them. */
export const LIST_ITEM_TYPES = [
  'text',
  'shape',
  'sticky_note',
  'image',
  'document',
  'card',
  'app_card',
  'preview',
  'frame',
  'embed',
  'doc_format',
  'data_table_format',
] as const;

/** The fields of a connector's `style` (ConnectorStyle). */
export const CONNECTOR_STYLE_KEYS: readonly string[] = [
  'color',
  'strokeColor',
  'strokeStyle',
  'strokeWidth',
  'fontSize',
  'startStrokeCap',
  'endStrokeCap',
  'textOrientation',
];

/** The fields of one connector caption (Caption). */
export const CAPTION_KEYS: readonly string[] = ['content', 'position', 'textAlignVertical'];
export const MAX_CAPTIONS = 20;
export const MAX_CAPTION_LENGTH = 200;

/** Where a connector end snaps to its item. */
export const SNAP_VALUES = ['auto', 'top', 'right', 'bottom', 'left'] as const;
export const CONNECTOR_SHAPES = ['straight', 'elbowed', 'curved'] as const;

/** The colours Miro takes for a tag. */
export const TAG_COLORS = [
  'red',
  'light_green',
  'cyan',
  'yellow',
  'magenta',
  'green',
  'blue',
  'gray',
  'violet',
  'dark_green',
  'dark_blue',
  'black',
] as const;
export const MAX_TAG_TITLE_LENGTH = 120;

/** The keys of one element of `create_items`. */
export const BULK_ELEMENT_KEYS: readonly string[] = [
  'type',
  'data',
  'style',
  'position',
  'geometry',
  'parent_frame_id',
];
export const MAX_BULK_ITEMS = 20;

/** A JSON body, built by this module only. */
export type Body = Readonly<Record<string, unknown>>;

/** A body, or the sentence refusing the arguments it was read from. */
export type BodyOutcome = { readonly body: Body } | { readonly denied: string };

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A key as a refusal may quote it. */
function fieldLabel(key: string): string {
  return FIELD_NAME.test(key) ? key : 'a field with a malformed name';
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFlatValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * A copy of the object made of the allowed keys only, or a refusal. Absent
 * (`undefined`) stays absent.
 */
export function flatObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
): { readonly value: Body | undefined } | { readonly denied: string } {
  if (value === undefined) return { value: undefined };
  if (!isPlainObject(value)) return { denied: `${label}: expected an object` };
  const copy: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field === undefined) continue;
    if (!allowed.includes(key)) {
      return {
        denied: `${label}.${fieldLabel(key)}: not a field this tool sends to Miro (allowed: ${allowed.join(', ')})`,
      };
    }
    if (!isFlatValue(field)) {
      return { denied: `${label}.${key}: expected a string, a number, a boolean or null` };
    }
    copy[key] = field;
  }
  return { value: copy };
}

/** The parent of an item : `{ id }`, `{ id: null }` (the canvas), absent, or a refusal. */
export function parentOf(
  value: unknown,
  label = 'parent_frame_id',
): { readonly value: Body | undefined } | { readonly denied: string } {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: { id: null } };
  const id = itemId(value);
  return id === null ? { denied: `${label}: malformed id` } : { value: { id } };
}

/** The arguments a typed item write reads. */
export interface ItemArguments {
  readonly data?: unknown;
  readonly style?: unknown;
  readonly position?: unknown;
  readonly geometry?: unknown;
  readonly parent_frame_id?: unknown;
}

/**
 * The body of a creation or an update of `kind`, from the arguments of a
 * typed tool or of one element of `create_items` (`label` prefixes the
 * refusals : `items[3]`).
 */
export function itemBody(
  kind: WritableKind,
  args: ItemArguments,
  mode: 'create' | 'update',
  label = '',
): BodyOutcome {
  const shape = BODY_SHAPES[kind];
  const at = (name: string): string => (label === '' ? name : `${label}.${name}`);
  const body: Record<string, unknown> = {};
  const parts: readonly [string, unknown, readonly string[]][] = [
    ['data', args.data, shape.data],
    ['style', args.style, shape.style],
    ['position', args.position, POSITION_FIELDS],
    ['geometry', args.geometry, shape.geometry],
  ];
  for (const [name, value, allowed] of parts) {
    const read = flatObject(value, allowed, at(name));
    if ('denied' in read) return read;
    if (read.value !== undefined) body[name] = read.value;
  }
  if (args.parent_frame_id !== undefined) {
    if (!shape.parent) return { denied: `${at('parent_frame_id')}: a frame takes no parent` };
    const parent = parentOf(args.parent_frame_id, at('parent_frame_id'));
    if ('denied' in parent) return parent;
    body.parent = parent.value;
  }
  if (mode === 'create' && shape.requiredOnCreate.data) {
    const data = body.data as Body | undefined;
    if (data === undefined) return { denied: `${at('data')}: required to create a ${kind}` };
    const key = shape.requiredOnCreate.key;
    if (key !== undefined && typeof data[key] !== 'string') {
      return { denied: `${at('data')}.${key}: required to create a ${kind}` };
    }
  }
  if (mode === 'update' && Object.keys(body).length === 0) {
    return { denied: 'nothing to change: give data, style, position, geometry or parent_frame_id' };
  }
  return { body };
}

/** One element of `create_items` : `{ type, …the body of that type }`. */
export function bulkElementBody(element: unknown, index: number): BodyOutcome {
  const label = `items[${index}]`;
  if (!isPlainObject(element)) return { denied: `${label}: expected an object` };
  for (const [key, value] of Object.entries(element)) {
    if (value !== undefined && !BULK_ELEMENT_KEYS.includes(key)) {
      return {
        denied: `${label}.${fieldLabel(key)}: not a field of an item (allowed: ${BULK_ELEMENT_KEYS.join(', ')})`,
      };
    }
  }
  const type = element.type;
  if (typeof type !== 'string' || !(ITEM_KINDS as readonly string[]).includes(type)) {
    return { denied: `${label}.type: expected one of ${ITEM_KINDS.join(', ')}` };
  }
  const read = itemBody(type as ItemKind, element, 'create', label);
  if ('denied' in read) return read;
  return { body: { type, ...read.body } };
}

/** The body of `create_items` : 1 to 20 elements. */
export function bulkBody(
  items: unknown,
): { readonly items: readonly Body[] } | { readonly denied: string } {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BULK_ITEMS) {
    return { denied: `items: expected a list of 1 to ${MAX_BULK_ITEMS} items` };
  }
  const bodies: Body[] = [];
  for (const [index, element] of items.entries()) {
    const read = bulkElementBody(element, index);
    if ('denied' in read) return read;
    bodies.push(read.body);
  }
  return { items: bodies };
}

/** The arguments of a connector write. */
export interface ConnectorArguments {
  readonly start_item_id?: unknown;
  readonly end_item_id?: unknown;
  readonly start_snap_to?: unknown;
  readonly end_snap_to?: unknown;
  readonly shape?: unknown;
  readonly captions?: unknown;
  readonly style?: unknown;
}

function connectorEnd(
  idArg: 'start_item_id' | 'end_item_id',
  snapArg: 'start_snap_to' | 'end_snap_to',
  args: ConnectorArguments,
  required: boolean,
): { readonly value: Body | undefined } | { readonly denied: string } {
  const rawId = args[idArg];
  const rawSnap = args[snapArg];
  if (rawId === undefined) {
    if (required) return { denied: `${idArg}: missing` };
    if (rawSnap !== undefined) return { denied: `${snapArg}: give ${idArg} with it` };
    return { value: undefined };
  }
  const id = itemId(rawId);
  if (id === null) return { denied: `${idArg}: malformed id` };
  if (rawSnap === undefined) return { value: { id } };
  if (typeof rawSnap !== 'string' || !(SNAP_VALUES as readonly string[]).includes(rawSnap)) {
    return { denied: `${snapArg}: expected one of ${SNAP_VALUES.join(', ')}` };
  }
  return { value: { id, snapTo: rawSnap } };
}

function captionsOf(
  value: unknown,
): { readonly value: readonly Body[] | undefined } | { readonly denied: string } {
  if (value === undefined) return { value: undefined };
  if (!Array.isArray(value) || value.length > MAX_CAPTIONS) {
    return { denied: `captions: expected a list of at most ${MAX_CAPTIONS} captions` };
  }
  const captions: Body[] = [];
  for (const [index, caption] of value.entries()) {
    const read = flatObject(caption, CAPTION_KEYS, `captions[${index}]`);
    if ('denied' in read) return read;
    const content = read.value?.content;
    if (typeof content !== 'string' || content.length > MAX_CAPTION_LENGTH) {
      return {
        denied: `captions[${index}].content: expected a text of at most ${MAX_CAPTION_LENGTH} characters`,
      };
    }
    captions.push(read.value ?? {});
  }
  return { value: captions };
}

/** The body of a connector creation or update. */
export function connectorBody(args: ConnectorArguments, mode: 'create' | 'update'): BodyOutcome {
  const required = mode === 'create';
  const start = connectorEnd('start_item_id', 'start_snap_to', args, required);
  if ('denied' in start) return start;
  const end = connectorEnd('end_item_id', 'end_snap_to', args, required);
  if ('denied' in end) return end;
  if (start.value !== undefined && end.value !== undefined && start.value.id === end.value.id) {
    return { denied: 'end_item_id: must differ from start_item_id' };
  }
  const body: Record<string, unknown> = {};
  if (start.value !== undefined) body.startItem = start.value;
  if (end.value !== undefined) body.endItem = end.value;
  if (args.shape !== undefined) {
    if (
      typeof args.shape !== 'string' ||
      !(CONNECTOR_SHAPES as readonly string[]).includes(args.shape)
    ) {
      return { denied: `shape: expected one of ${CONNECTOR_SHAPES.join(', ')}` };
    }
    body.shape = args.shape;
  }
  const captions = captionsOf(args.captions);
  if ('denied' in captions) return captions;
  if (captions.value !== undefined) body.captions = captions.value;
  const style = flatObject(args.style, CONNECTOR_STYLE_KEYS, 'style');
  if ('denied' in style) return style;
  if (style.value !== undefined) body.style = style.value;
  if (mode === 'update' && Object.keys(body).length === 0) {
    return {
      denied:
        'nothing to change: give start_item_id, end_item_id, a snap, shape, captions or style',
    };
  }
  return { body };
}

/** The body of a tag creation. */
export function tagBody(args: {
  readonly title?: unknown;
  readonly fill_color?: unknown;
}): BodyOutcome {
  const title = args.title;
  if (typeof title !== 'string' || title.length === 0 || title.length > MAX_TAG_TITLE_LENGTH) {
    return { denied: `title: expected a text of 1 to ${MAX_TAG_TITLE_LENGTH} characters` };
  }
  const body: Record<string, unknown> = { title };
  if (args.fill_color !== undefined) {
    if (
      typeof args.fill_color !== 'string' ||
      !(TAG_COLORS as readonly string[]).includes(args.fill_color)
    ) {
      return { denied: `fill_color: expected one of ${TAG_COLORS.join(', ')}` };
    }
    body.fillColor = args.fill_color;
  }
  return { body };
}
