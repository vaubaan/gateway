/**
 * Checks of the JSON values a Notion call carries (`children`, `properties`,
 * `rich_text`, `filter`, `sorts`, `icon`, `cover`, a block's new content),
 * shared by `classify` and `execute`.
 *
 * Handbook : docs/handbook/providers/notion.md §2 ("Refused by the
 *            classifier") ; Notion's request limits page.
 *
 * These values are forwarded to Notion as JSON, so the checks are what keeps
 * an agent inside the tool's scope :
 *   - Notion's request limits, refused up front (kit step 3) : at most 100
 *     items in any array, at most 2 000 characters in any string, at most
 *     two levels of nesting and 1 000 blocks in one `children` ;
 *   - no file upload anywhere (out of scope) ;
 *   - block types : an allow-list of what the block endpoints create or
 *     update, never `child_page` / `child_database` (their own endpoints),
 *     never a synced duplicate (it would show content from wherever its
 *     original lives) ;
 *   - property values Notion does not let a request set are refused ;
 *   - every id nested in a value (a mention, a link to a page, a relation
 *     target, a person) is read by `notionId` ; relation targets are
 *     returned so that `execute` walks them to the call's root.
 *
 * Pure : a value in, a refusal sentence or the facts `execute` needs out.
 */

import { MAX_TEXT_LENGTH, malformedId, notionId } from './ids.ts';

/** Longest array Notion accepts anywhere in a request body. */
export const MAX_ARRAY_ITEMS = 100;
/** Most blocks in one request, nested ones included. */
export const MAX_BLOCKS_PER_REQUEST = 1000;
/** Levels of nesting under the top-level `children` array of one request. */
export const MAX_NESTING_LEVELS = 2;
/** Deepest JSON value walked ; deeper is refused rather than recursed into. */
const MAX_JSON_DEPTH = 24;

/** Block types the block endpoints create (append block children reference, 2026-03-11). */
export const CREATABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'audio',
  'bookmark',
  'breadcrumb',
  'bulleted_list_item',
  'callout',
  'code',
  'column',
  'column_list',
  'divider',
  'embed',
  'equation',
  'file',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'image',
  'link_to_page',
  'numbered_list_item',
  'paragraph',
  'pdf',
  'quote',
  'synced_block',
  'tab',
  'table',
  'table_of_contents',
  'table_row',
  'to_do',
  'toggle',
  'video',
]);

/** Block types whose content `notion__update_block` may rewrite. */
export const UPDATABLE_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'audio',
  'bookmark',
  'bulleted_list_item',
  'callout',
  'code',
  'embed',
  'equation',
  'file',
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'image',
  'numbered_list_item',
  'paragraph',
  'pdf',
  'quote',
  'table',
  'table_row',
  'to_do',
  'toggle',
  'video',
]);

/** Block types that are pages or databases : created, changed and trashed through their own tools. */
export const CONTAINER_BLOCK_TYPES: ReadonlySet<string> = new Set(['child_page', 'child_database']);

const NOT_CREATABLE: Readonly<Record<string, string>> = {
  child_page: 'create a page with notion__create_page',
  child_database: 'databases are not created by this plugin',
  link_preview: 'Notion does not create it through the block endpoints',
  meeting_notes: 'Notion does not create it through the block endpoints',
  transcription: 'Notion does not create it through the block endpoints',
  unsupported: 'Notion does not create it through the block endpoints',
};

/** Property values a request cannot set (page property values reference). */
const READ_ONLY_PROPERTY_TYPES: ReadonlySet<string> = new Set([
  'button',
  'created_by',
  'created_time',
  'formula',
  'last_edited_by',
  'last_edited_time',
  'rollup',
  'unique_id',
  'verification',
]);

/** A refusal, or the facts the executor needs from an accepted value. */
export type Checked<T> = { readonly ok: T } | { readonly refused: string };

export interface PropertyFacts {
  /** Relation targets, canonical, in order : walked to the call's root by `execute`. */
  readonly relationIds: readonly string[];
}

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The limits every forwarded value is held to, at any depth : arrays of at
 * most 100 items, strings of at most 2 000 characters, no file upload.
 */
export function checkJson(value: unknown, path: string, depth = 0): string | null {
  if (depth > MAX_JSON_DEPTH) return `${path}: nested too deeply`;
  if (typeof value === 'string') {
    return value.length > MAX_TEXT_LENGTH
      ? `${path}: longer than ${MAX_TEXT_LENGTH} characters (Notion's limit)`
      : null;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) {
      return `${path}: more than ${MAX_ARRAY_ITEMS} items (Notion's limit)`;
    }
    for (const [i, item] of value.entries()) {
      const issue = checkJson(item, `${path}[${i}]`, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  if (isObject(value)) {
    if ('file_upload' in value || value.type === 'file_upload') {
      return `${path}: file uploads are not available through this plugin`;
    }
    for (const [key, item] of Object.entries(value)) {
      const issue = checkJson(item, `${path}.${key}`, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  return null;
}

/** A rich text array : the limits, and every mention reads as a Notion id. */
export function checkRichText(value: unknown, path: string): string | null {
  if (!Array.isArray(value)) return `${path}: expected an array of rich text objects`;
  const limits = checkJson(value, path);
  if (limits) return limits;
  return mentionIssue(value, path, 0);
}

/** Every id a mention names (page, database, user) reads as a Notion id, at any depth. */
function mentionIssue(value: unknown, path: string, depth: number): string | null {
  if (depth > MAX_JSON_DEPTH) return `${path}: nested too deeply`;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const issue = mentionIssue(item, `${path}[${i}]`, depth + 1);
      if (issue) return issue;
    }
    return null;
  }
  if (!isObject(value)) return null;
  const mention = value.mention;
  if (isObject(mention)) {
    for (const kind of ['page', 'database', 'user'] as const) {
      const target = mention[kind];
      if (target === undefined) continue;
      if (!isObject(target) || !notionId(target.id)) {
        return malformedId(`${path}.mention.${kind}.id`, isObject(target) ? target.id : target);
      }
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'mention') continue;
    const issue = mentionIssue(item, `${path}.${key}`, depth + 1);
    if (issue) return issue;
  }
  return null;
}

interface BlockWalk {
  count: number;
}

/**
 * A `children` array of new blocks : at most 100 per array, two levels of
 * nesting and 1 000 blocks in all, creatable types only, no synced
 * duplicate, every id a well-formed Notion id.
 */
export function checkChildren(value: unknown, path = 'children'): string | null {
  if (!Array.isArray(value)) return `${path}: expected an array of block objects`;
  const limits = checkJson(value, path);
  if (limits) return limits;
  return blocksIssue(value, path, 0, { count: 0 });
}

function blocksIssue(
  blocks: readonly unknown[],
  path: string,
  level: number,
  walk: BlockWalk,
): string | null {
  if (level > MAX_NESTING_LEVELS) {
    return `${path}: more than ${MAX_NESTING_LEVELS} levels of nesting in one request (Notion's limit)`;
  }
  for (const [i, block] of blocks.entries()) {
    walk.count += 1;
    if (walk.count > MAX_BLOCKS_PER_REQUEST) {
      return `${path}: more than ${MAX_BLOCKS_PER_REQUEST} blocks in one request (Notion's limit)`;
    }
    const where = `${path}[${i}]`;
    const issue = newBlockIssue(block, where);
    if (issue) return issue;
    const type = (block as Json).type as string;
    const nested = ((block as Json)[type] as Json).children;
    if (nested === undefined) continue;
    if (!Array.isArray(nested)) return `${where}.${type}.children: expected an array`;
    const deeper = blocksIssue(nested, `${where}.${type}.children`, level + 1, walk);
    if (deeper) return deeper;
  }
  return null;
}

/** One new block : `{ type, [type]: {...} }` and an optional `object: "block"`, nothing else. */
function newBlockIssue(block: unknown, path: string): string | null {
  if (!isObject(block)) return `${path}: expected a block object`;
  const type = block.type;
  if (typeof type !== 'string') return `${path}.type: required (the block type)`;
  if (type in NOT_CREATABLE) {
    return `${path}: a '${type}' block cannot be added here — ${NOT_CREATABLE[type]}`;
  }
  if (!CREATABLE_BLOCK_TYPES.has(type)) return `${path}.type: unknown block type '${type}'`;
  for (const key of Object.keys(block)) {
    if (key !== 'type' && key !== 'object' && key !== type) {
      return `${path}.${key}: not part of a '${type}' block`;
    }
  }
  if (block.object !== undefined && block.object !== 'block') {
    return `${path}.object: must be 'block'`;
  }
  const body = block[type];
  if (!isObject(body)) return `${path}.${type}: expected an object`;
  return blockBodyIssue(type, body, `${path}.${type}`);
}

/** What a block's own object may carry, for a new block and for an update alike. */
function blockBodyIssue(type: string, body: Json, path: string): string | null {
  if (type === 'synced_block' && body.synced_from !== undefined && body.synced_from !== null) {
    return `${path}.synced_from: a synced copy of another block is not created by this plugin (it would show content from wherever the original lives)`;
  }
  if (type === 'link_to_page') {
    const target = body.page_id ?? body.database_id;
    if (!notionId(target)) return malformedId(`${path}.page_id`, target);
  }
  for (const [key, item] of Object.entries(body)) {
    if (key === 'rich_text' || key === 'caption') {
      const issue = checkRichText(item, `${path}.${key}`);
      if (issue) return issue;
    }
  }
  return mentionIssue(body, path, 0);
}

/**
 * The new content of an existing block (`notion__update_block`) : an
 * updatable type, the object Notion keys by that type, no `children` (a
 * block's children are not updated by this endpoint).
 */
export function checkBlockUpdate(type: unknown, content: unknown): string | null {
  if (typeof type !== 'string') return 'type: required (the type of the block to rewrite)';
  if (CONTAINER_BLOCK_TYPES.has(type)) {
    return `type: a '${type}' is changed with ${type === 'child_page' ? 'notion__update_page' : 'no tool of this plugin'}`;
  }
  if (!UPDATABLE_BLOCK_TYPES.has(type)) return `type: a '${type}' block cannot be rewritten here`;
  if (!isObject(content)) return `content: expected the '${type}' object of the block`;
  if ('children' in content) {
    return 'content.children: a block’s children are not rewritten; use notion__append_blocks or notion__delete_block';
  }
  const limits = checkJson(content, 'content');
  if (limits) return limits;
  return blockBodyIssue(type, content, 'content');
}

/**
 * Property values of a database entry : the limits, no read-only type, every
 * relation target and person a Notion id. Returns the relation targets.
 */
export function checkProperties(value: unknown): Checked<PropertyFacts> {
  if (!isObject(value)) return { refused: 'properties: expected an object keyed by property name' };
  const limits = checkJson(value, 'properties');
  if (limits) return { refused: limits };
  const relationIds: string[] = [];
  for (const [name, property] of Object.entries(value)) {
    const path = `properties.${JSON.stringify(name)}`;
    if (!isObject(property)) return { refused: `${path}: expected a property value object` };
    const keys = Object.keys(property).filter((k) => k !== 'id' && k !== 'type');
    const declared = typeof property.type === 'string' ? [property.type] : [];
    for (const type of [...declared, ...keys]) {
      if (READ_ONLY_PROPERTY_TYPES.has(type)) {
        return { refused: `${path}: a '${type}' value is computed by Notion and cannot be set` };
      }
    }
    const relation = property.relation;
    if (relation !== undefined) {
      if (!Array.isArray(relation)) return { refused: `${path}.relation: expected an array` };
      for (const [i, target] of relation.entries()) {
        const id = isObject(target) ? notionId(target.id) : null;
        if (!id) {
          return {
            refused: malformedId(
              `${path}.relation[${i}].id`,
              isObject(target) ? target.id : target,
            ),
          };
        }
        relationIds.push(id);
      }
    }
    const people = property.people;
    if (people !== undefined) {
      if (!Array.isArray(people)) return { refused: `${path}.people: expected an array` };
      for (const [i, person] of people.entries()) {
        if (!isObject(person) || !notionId(person.id)) {
          return {
            refused: malformedId(`${path}.people[${i}].id`, isObject(person) ? person.id : person),
          };
        }
      }
    }
    for (const key of ['title', 'rich_text'] as const) {
      if (property[key] === undefined) continue;
      const issue = checkRichText(property[key], `${path}.${key}`);
      if (issue) return { refused: issue };
    }
  }
  return { ok: { relationIds } };
}

/** A page icon : an emoji, a Notion icon or an `https:` image ; never an upload. */
export function checkIcon(value: unknown): string | null {
  if (!isObject(value)) return 'icon: expected an icon object';
  const limits = checkJson(value, 'icon');
  if (limits) return limits;
  switch (value.type) {
    case 'emoji':
      return typeof value.emoji === 'string' ? null : 'icon.emoji: expected a string';
    case 'icon':
      return isObject(value.icon) && typeof value.icon.name === 'string'
        ? null
        : 'icon.icon.name: expected a string';
    case 'external':
      return externalIssue(value, 'icon');
    default:
      return "icon.type: one of 'emoji', 'icon', 'external'";
  }
}

/** A page cover : an `https:` image. */
export function checkCover(value: unknown): string | null {
  if (!isObject(value)) return 'cover: expected a cover object';
  const limits = checkJson(value, 'cover');
  if (limits) return limits;
  if (value.type !== 'external') return "cover.type: must be 'external'";
  return externalIssue(value, 'cover');
}

function externalIssue(value: Json, path: string): string | null {
  for (const key of Object.keys(value)) {
    if (key !== 'type' && key !== 'external') return `${path}.${key}: not part of an external file`;
  }
  const external = value.external;
  if (!isObject(external) || Object.keys(external).some((k) => k !== 'url')) {
    return `${path}.external: expected { url }`;
  }
  const url = external.url;
  if (typeof url !== 'string' || url.length > MAX_TEXT_LENGTH) {
    return `${path}.external.url: expected an https URL of at most ${MAX_TEXT_LENGTH} characters`;
  }
  try {
    if (new URL(url).protocol !== 'https:') return `${path}.external.url: must be https`;
  } catch {
    return `${path}.external.url: not a URL`;
  }
  return null;
}
