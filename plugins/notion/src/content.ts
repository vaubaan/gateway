/**
 * Checks of the JSON values a Notion call carries (`children`, `properties`,
 * `rich_text`, `filter`, `sorts`, `icon`, `cover`, a block's new content),
 * shared by `classify` and `execute`.
 *
 * Handbook : docs/handbook/providers/notion.md ; Notion's request limits page.
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
 *     target, a person) is read by `notionId` ; the pages and databases
 *     they name are collected (`References`) so that `execute` walks each
 *     to the call's root before the write.
 *
 * Pure : a value in, a refusal sentence or the facts `execute` needs out.
 */

import { isRecord } from '@vaubaan/plugin-sdk';

import { MAX_TEXT_LENGTH, malformedId, notionId } from './ids.ts';
import { TOOL } from './identity.ts';
import type { Json } from './json.ts';

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

/** Block types whose content `TOOL.updateBlock` may rewrite. */
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
  child_page: `create a page with ${TOOL.createPage}`,
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

/**
 * The pages and databases a written value points at — relation targets,
 * mentions, links to a page — canonical, without repeats. `execute` walks
 * each to the call's root before the write : a link must not reach, or show
 * the title of, an object of another root.
 */
export interface References {
  readonly pages: string[];
  readonly databases: string[];
}

export function noReferences(): References {
  return { pages: [], databases: [] };
}

function refer(refs: References | undefined, kind: 'pages' | 'databases', id: string): void {
  if (refs && !refs[kind].includes(id)) refs[kind].push(id);
}

/** An accepted block rewrite, typed. */
export interface BlockUpdate {
  readonly type: string;
  readonly content: Json;
  readonly references: References;
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
  if (isRecord(value)) {
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

/** A rich text array : the limits, and every mention reads as a Notion id (collected in `refs`). */
export function checkRichText(value: unknown, path: string, refs?: References): string | null {
  if (!Array.isArray(value)) return `${path}: expected an array of rich text objects`;
  const limits = checkJson(value, path);
  if (limits) return limits;
  return mentionIssue(value, path, 0, refs);
}

/** Every id a mention names (page, database, user) reads as a Notion id, at any depth ; pages and databases are collected. */
function mentionIssue(
  value: unknown,
  path: string,
  depth: number,
  refs: References | undefined,
): string | null {
  if (depth > MAX_JSON_DEPTH) return `${path}: nested too deeply`;
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const issue = mentionIssue(item, `${path}[${i}]`, depth + 1, refs);
      if (issue) return issue;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  if ('mention' in value) {
    const issue = checkMention(value.mention, `${path}.mention`, refs);
    if (issue) return issue;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key === 'mention') continue;
    const issue = mentionIssue(item, `${path}.${key}`, depth + 1, refs);
    if (issue) return issue;
  }
  return null;
}

/**
 * The mentions this plugin writes : a page, a database, a user, a date.
 * Every other kind (`data_source`, `link_mention`, `link_preview`,
 * `template_mention`…) is refused : each names or previews an object whose
 * place the walk cannot prove, or one Notion resolves at write time.
 */
export const MENTION_TYPES: ReadonlySet<string> = new Set(['page', 'database', 'user', 'date']);

/** One mention object : `{ type, [type]: … }` and nothing else ; the page or database it names collected. */
function checkMention(mention: unknown, path: string, refs: References | undefined): string | null {
  if (!isRecord(mention) || typeof mention.type !== 'string' || !MENTION_TYPES.has(mention.type)) {
    return `${path}.type: one of 'page', 'database', 'user', 'date'`;
  }
  const type = mention.type;
  for (const key of Object.keys(mention)) {
    if (key !== 'type' && key !== type) return `${path}.${key}: not part of a '${type}' mention`;
  }
  const target = mention[type];
  if (!isRecord(target)) return `${path}.${type}: expected an object`;
  if (type === 'date') return null;
  for (const key of Object.keys(target)) {
    if (key !== 'id' && key !== 'object') return `${path}.${type}.${key}: not part of a mention`;
  }
  const id = notionId(target.id);
  if (!id) return malformedId(`${path}.${type}.id`, target.id);
  if (type === 'page') refer(refs, 'pages', id);
  if (type === 'database') refer(refs, 'databases', id);
  return null;
}

/** A link to a page : exactly `{ type: "page_id", page_id }` or `{ type: "database_id", database_id }`. */
function checkLinkToPage(body: Json, path: string, refs: References | undefined): string | null {
  const field = body.type === 'page_id' || body.type === 'database_id' ? body.type : null;
  if (!field) return `${path}.type: 'page_id' or 'database_id'`;
  for (const key of Object.keys(body)) {
    if (key !== 'type' && key !== field) return `${path}.${key}: not part of a '${field}' link`;
  }
  const id = notionId(body[field]);
  if (!id) return malformedId(`${path}.${field}`, body[field]);
  refer(refs, field === 'page_id' ? 'pages' : 'databases', id);
  return null;
}

interface BlockWalk {
  count: number;
  readonly refs: References | undefined;
}

/**
 * A `children` array of new blocks : at most 100 per array, two levels of
 * nesting and 1 000 blocks in all, creatable types only, no synced
 * duplicate, every id a well-formed Notion id.
 */
export function checkChildren(value: unknown, path = 'children', refs?: References): string | null {
  if (!Array.isArray(value)) return `${path}: expected an array of block objects`;
  const limits = checkJson(value, path);
  if (limits) return limits;
  return blocksIssue(value, path, 0, { count: 0, refs });
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
    const checked = newBlock(block, where, walk.refs);
    if (typeof checked === 'string') return checked;
    const { type, body } = checked;
    const nested = body.children;
    if (nested === undefined) continue;
    if (!Array.isArray(nested)) return `${where}.${type}.children: expected an array`;
    const deeper = blocksIssue(nested, `${where}.${type}.children`, level + 1, walk);
    if (deeper) return deeper;
  }
  return null;
}

/** One new block : `{ type, [type]: {...} }` and an optional `object: "block"`, nothing else ; its type and body, or the refusal. */
function newBlock(
  block: unknown,
  path: string,
  refs: References | undefined,
): { readonly type: string; readonly body: Json } | string {
  if (!isRecord(block)) return `${path}: expected a block object`;
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
  if (!isRecord(body)) return `${path}.${type}: expected an object`;
  return blockBodyIssue(type, body, `${path}.${type}`, refs) ?? { type, body };
}

/** What a block's own object may carry, for a new block and for an update alike. */
function blockBodyIssue(
  type: string,
  body: Json,
  path: string,
  refs: References | undefined,
): string | null {
  if (type === 'synced_block' && body.synced_from !== undefined && body.synced_from !== null) {
    return `${path}.synced_from: a synced copy of another block is not created by this plugin (it would show content from wherever the original lives)`;
  }
  if (type === 'link_to_page') return checkLinkToPage(body, path, refs);
  for (const [key, item] of Object.entries(body)) {
    if (key === 'rich_text' || key === 'caption') {
      const issue = checkRichText(item, `${path}.${key}`, refs);
      if (issue) return issue;
    }
  }
  return mentionIssue(body, path, 0, refs);
}

/**
 * The new content of an existing block (`TOOL.updateBlock`) : an
 * updatable type, the object Notion keys by that type, no `children` (a
 * block's children are not updated by this endpoint).
 */
export function checkBlockUpdate(type: unknown, content: unknown): Checked<BlockUpdate> {
  const refused = (reason: string) => ({ refused: reason });
  if (typeof type !== 'string') return refused('type: required (the type of the block to rewrite)');
  if (CONTAINER_BLOCK_TYPES.has(type)) {
    return refused(
      `type: a '${type}' is changed with ${type === 'child_page' ? TOOL.updatePage : 'no tool of this plugin'}`,
    );
  }
  if (!UPDATABLE_BLOCK_TYPES.has(type)) {
    return refused(`type: a '${type}' block cannot be rewritten here`);
  }
  if (!isRecord(content)) return refused(`content: expected the '${type}' object of the block`);
  if ('children' in content) {
    return refused(
      `content.children: a block’s children are not rewritten; use ${TOOL.appendBlocks} or ${TOOL.deleteBlock}`,
    );
  }
  const limits = checkJson(content, 'content');
  if (limits) return refused(limits);
  const references = noReferences();
  const issue = blockBodyIssue(type, content, 'content', references);
  return issue ? refused(issue) : { ok: { type, content, references } };
}

/**
 * Property values of a database entry : the limits, no read-only type, every
 * relation target and person a Notion id. Returns the relation targets.
 */
export function checkProperties(value: unknown, references: References): string | null {
  if (!isRecord(value)) return 'properties: expected an object keyed by property name';
  const limits = checkJson(value, 'properties');
  if (limits) return limits;
  for (const [name, property] of Object.entries(value)) {
    const path = `properties.${JSON.stringify(name)}`;
    if (!isRecord(property)) return `${path}: expected a property value object`;
    const keys = Object.keys(property).filter((k) => k !== 'id' && k !== 'type');
    const declared = typeof property.type === 'string' ? [property.type] : [];
    for (const type of [...declared, ...keys]) {
      if (READ_ONLY_PROPERTY_TYPES.has(type)) {
        return `${path}: a '${type}' value is computed by Notion and cannot be set`;
      }
    }
    const relation = property.relation;
    if (relation !== undefined) {
      if (!Array.isArray(relation)) return `${path}.relation: expected an array`;
      for (const [i, target] of relation.entries()) {
        const id = isRecord(target) ? notionId(target.id) : null;
        if (!id)
          return malformedId(`${path}.relation[${i}].id`, isRecord(target) ? target.id : target);
        refer(references, 'pages', id);
      }
    }
    const people = property.people;
    if (people !== undefined) {
      if (!Array.isArray(people)) return `${path}.people: expected an array`;
      for (const [i, person] of people.entries()) {
        if (!isRecord(person) || !notionId(person.id)) {
          return malformedId(`${path}.people[${i}].id`, isRecord(person) ? person.id : person);
        }
      }
    }
    for (const key of ['title', 'rich_text'] as const) {
      if (property[key] === undefined) continue;
      const issue = checkRichText(property[key], `${path}.${key}`, references);
      if (issue) return issue;
    }
  }
  return null;
}

/** A page icon : an emoji, a Notion icon or an `https:` image ; never an upload. */
export function checkIcon(value: unknown): string | null {
  if (!isRecord(value)) return 'icon: expected an icon object';
  const limits = checkJson(value, 'icon');
  if (limits) return limits;
  switch (value.type) {
    case 'emoji':
      return typeof value.emoji === 'string' ? null : 'icon.emoji: expected a string';
    case 'icon':
      return isRecord(value.icon) && typeof value.icon.name === 'string'
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
  if (!isRecord(value)) return 'cover: expected a cover object';
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
  if (!isRecord(external) || Object.keys(external).some((k) => k !== 'url')) {
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
