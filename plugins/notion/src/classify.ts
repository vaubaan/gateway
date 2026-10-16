/**
 * Classifier of the `notion` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10.
 * Handbook : docs/handbook/providers/notion.md §2, §5.
 *
 * Pure : no IO, no credential, no clock. One reader, `readCall`, turns the
 * arguments into a typed call — every identifier through its grammar, every
 * forwarded JSON value through the checks of `content.ts` — and is used by
 * `classify` and by `execute` alike : `execute` builds its requests from what
 * `readCall` returned, never from `args`.
 *
 * Every slice names `root[<R>]`, the root the call claims, checked against
 * the mission's resources. Nothing in a Notion id says under which root it
 * lives : the claim is proven at run time by the executor's ancestry walk
 * (`ancestry.ts`), before anything is written or returned.
 */

import {
  declaredArgumentsOf,
  parseSlice,
  undeclaredArgumentDenial,
  type ClassifyOutcome,
  type Resource,
  type Slice,
} from '@vaubaan/plugin-sdk';

import {
  checkBlockUpdate,
  checkChildren,
  checkCover,
  checkIcon,
  checkJson,
  checkProperties,
  checkRichText,
} from './content.ts';
import {
  MAX_TEXT_LENGTH,
  boundedInt,
  cursor,
  malformedId,
  notionId,
  resolveRoot,
  type ResolvedRoot,
} from './ids.ts';
import { PROVIDER_ID, TOOL } from './identity.ts';
import { notionTools } from './tools.ts';

const DECLARED = declaredArgumentsOf(notionTools);

/** The refusal of an argument the tool does not declare ; `null` when every argument is declared. */
export function undeclaredArgument(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string | null {
  return undeclaredArgumentDenial(DECLARED, tool, args);
}

/** Default page sizes, always sent explicitly (Notion documents two different defaults). */
export const DEFAULT_PAGE_SIZE = { search: 20, children: 50, query: 50, comments: 20 } as const;

export type AppendPosition =
  | { readonly type: 'end' }
  | { readonly type: 'start' }
  | { readonly type: 'after_block'; readonly afterBlockId: string };

interface Paged {
  readonly pageSize: number;
  readonly startCursor: string | null;
}

/** The key of `TOOL` naming a tool : what a call is discriminated on. */
export type ToolOp = keyof typeof TOOL;

const OPS: ReadonlyMap<string, ToolOp> = new Map(
  (Object.entries(TOOL) as [ToolOp, string][]).map(([op, name]) => [name, op]),
);

/** The op of a tool name of this plugin, or `null`. */
export function opOf(tool: string): ToolOp | null {
  return OPS.get(tool) ?? null;
}

/** A call read by its one reader : the identifiers canonical, the forwarded values checked. */
export type NotionCall =
  | { readonly op: 'listRoots' }
  | ({
      readonly op: 'searchContent';
      readonly root: ResolvedRoot;
      readonly query: string | null;
      readonly object: 'page' | 'data_source' | null;
      readonly sort: Readonly<Record<string, unknown>> | null;
    } & Paged)
  | { readonly op: 'getPage'; readonly root: ResolvedRoot; readonly pageId: string }
  | ({
      readonly op: 'listBlockChildren';
      readonly root: ResolvedRoot;
      readonly blockId: string;
      readonly depth: number;
    } & Paged)
  | {
      readonly op: 'getDatabase';
      readonly root: ResolvedRoot;
      readonly databaseId: string;
    }
  | {
      readonly op: 'getDataSource';
      readonly root: ResolvedRoot;
      readonly dataSourceId: string;
    }
  | ({
      readonly op: 'queryDataSource';
      readonly root: ResolvedRoot;
      readonly dataSourceId: string;
      readonly filter: unknown;
      readonly sorts: unknown;
    } & Paged)
  | {
      readonly op: 'createPage';
      readonly root: ResolvedRoot;
      readonly parentPageId: string;
      readonly title: string;
      readonly children: unknown;
      readonly icon: unknown;
      readonly cover: unknown;
    }
  | {
      readonly op: 'updatePage';
      readonly root: ResolvedRoot;
      readonly pageId: string;
      readonly title: string | null;
      readonly icon: unknown;
      readonly cover: unknown;
    }
  | {
      readonly op: 'appendBlocks';
      readonly root: ResolvedRoot;
      readonly blockId: string;
      readonly children: unknown;
      readonly position: AppendPosition;
    }
  | {
      readonly op: 'updateBlock';
      readonly root: ResolvedRoot;
      readonly blockId: string;
      readonly type: string;
      readonly content: Readonly<Record<string, unknown>>;
    }
  | {
      readonly op: 'deleteBlock';
      readonly root: ResolvedRoot;
      readonly blockId: string;
    }
  | { readonly op: 'trashPage'; readonly root: ResolvedRoot; readonly pageId: string }
  | { readonly op: 'restorePage'; readonly root: ResolvedRoot; readonly pageId: string }
  | {
      readonly op: 'createEntry';
      readonly root: ResolvedRoot;
      readonly dataSourceId: string;
      readonly properties: unknown;
      readonly relationIds: readonly string[];
      readonly children: unknown;
      readonly icon: unknown;
    }
  | {
      readonly op: 'updateEntry';
      readonly root: ResolvedRoot;
      readonly dataSourceId: string;
      readonly pageId: string;
      readonly properties: unknown;
      readonly relationIds: readonly string[];
      readonly icon: unknown;
    }
  | ({
      readonly op: 'listComments';
      readonly root: ResolvedRoot;
      readonly blockId: string;
    } & Paged)
  | {
      readonly op: 'createComment';
      readonly root: ResolvedRoot;
      readonly blockId: string;
      readonly richText: unknown;
      readonly discussionId: string | null;
    };

type Read = NotionCall | { readonly denied: string };
type Args = Readonly<Record<string, unknown>>;

/** A refusal raised while reading ; caught by `readCall`, never out of it. */
class Denied extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'Denied';
  }
}

function deny(reason: string): never {
  throw new Denied(reason);
}

/** A required Notion id argument. */
function idArg(args: Args, name: string): string {
  return notionId(args[name]) ?? deny(malformedId(name, args[name]));
}

/** An optional Notion id argument. */
function optionalIdArg(args: Args, name: string): string | null {
  return args[name] === undefined ? null : idArg(args, name);
}

function paged(args: Args, fallback: number): Paged {
  const pageSize =
    args.page_size === undefined
      ? fallback
      : (boundedInt(args.page_size, 1, 100) ?? deny('page_size: an integer from 1 to 100'));
  const startCursor =
    args.start_cursor === undefined
      ? null
      : (cursor(args.start_cursor) ?? deny('start_cursor: malformed'));
  return { pageSize, startCursor };
}

function title(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    return deny(`${name}: expected a non-empty string`);
  if (value.length > MAX_TEXT_LENGTH)
    return deny(`${name}: longer than ${MAX_TEXT_LENGTH} characters (Notion's limit)`);
  return value;
}

function checked(issue: string | null): void {
  if (issue) deny(issue);
}

function optional(value: unknown, check: (v: unknown) => string | null): unknown {
  if (value !== undefined) checked(check(value));
  return value;
}

function sortOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === undefined) return null;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return deny('sort: expected an object');
  const sort = value as Record<string, unknown>;
  for (const key of Object.keys(sort)) {
    if (key !== 'direction' && key !== 'timestamp')
      return deny(`sort.${key}: not part of a search sort`);
  }
  if (sort.direction !== 'ascending' && sort.direction !== 'descending') {
    return deny("sort.direction: 'ascending' or 'descending'");
  }
  if (sort.timestamp !== 'last_edited_time')
    return deny("sort.timestamp: must be 'last_edited_time'");
  return sort;
}

function positionOf(args: Args): AppendPosition {
  const position = args.position ?? 'end';
  if (position === 'after_block') {
    if (args.after_block_id === undefined)
      return deny('after_block_id: required with position after_block');
    return { type: 'after_block', afterBlockId: idArg(args, 'after_block_id') };
  }
  if (args.after_block_id !== undefined)
    return deny('after_block_id: only with position after_block');
  if (position === 'end' || position === 'start') return { type: position };
  return deny("position: one of 'end', 'start', 'after_block'");
}

function relationsOf(value: unknown): readonly string[] {
  const outcome = checkProperties(value);
  return 'refused' in outcome ? deny(outcome.refused) : outcome.ok.relationIds;
}

/**
 * The one reader of a call, for `classify` and `execute` : the root, every
 * identifier canonical, every forwarded value checked ; or the refusal.
 * The undeclared-argument rule is applied by the callers, before it.
 */
export function readCall(tool: string, args: Args, resources: readonly Resource[]): Read {
  try {
    return readOrThrow(tool, args, resources);
  } catch (error) {
    if (error instanceof Denied) return { denied: error.reason };
    throw error;
  }
}

function readOrThrow(tool: string, args: Args, resources: readonly Resource[]): NotionCall {
  const op = opOf(tool);
  if (op === null) return deny(`unknown tool '${tool}'`);
  if (op === 'listRoots') return { op };
  const resolved = resolveRoot(args, resources);
  if ('denied' in resolved) return deny(resolved.denied);
  const root = resolved;
  switch (op) {
    case 'searchContent': {
      const query = args.query === undefined ? null : title(args.query, 'query');
      const object = args.object ?? null;
      if (object !== null && object !== 'page' && object !== 'data_source') {
        return deny("object: 'page' or 'data_source'");
      }
      return {
        op,
        root,
        query,
        object,
        sort: sortOf(args.sort),
        ...paged(args, DEFAULT_PAGE_SIZE.search),
      };
    }
    case 'getPage':
      return {
        op,
        root,
        pageId: idArg(args, 'page_id'),
      };
    case 'listBlockChildren': {
      const depth =
        args.depth === undefined
          ? 1
          : (boundedInt(args.depth, 1, 3) ?? deny('depth: an integer from 1 to 3'));
      return {
        op,
        root,
        blockId: idArg(args, 'block_id'),
        depth,
        ...paged(args, DEFAULT_PAGE_SIZE.children),
      };
    }
    case 'getDatabase':
      return {
        op,
        root,
        databaseId: idArg(args, 'database_id'),
      };
    case 'getDataSource':
      return {
        op,
        root,
        dataSourceId: idArg(args, 'data_source_id'),
      };
    case 'queryDataSource':
      return {
        op,
        root,
        dataSourceId: idArg(args, 'data_source_id'),
        filter: optional(args.filter, (v) =>
          typeof v === 'object' && v !== null && !Array.isArray(v)
            ? checkJson(v, 'filter')
            : 'filter: expected an object',
        ),
        sorts: optional(args.sorts, (v) =>
          Array.isArray(v) ? checkJson(v, 'sorts') : 'sorts: expected an array',
        ),
        ...paged(args, DEFAULT_PAGE_SIZE.query),
      };
    case 'createPage':
      return {
        op,
        root,
        parentPageId: idArg(args, 'parent_page_id'),
        title: title(args.title, 'title'),
        children: optional(args.children, (v) => checkChildren(v)),
        icon: optional(args.icon, checkIcon),
        cover: optional(args.cover, checkCover),
      };
    case 'updatePage': {
      if (args.title === undefined && args.icon === undefined && args.cover === undefined) {
        return deny('update_page: give a title, an icon or a cover');
      }
      return {
        op,
        root,
        pageId: idArg(args, 'page_id'),
        title: args.title === undefined ? null : title(args.title, 'title'),
        icon: optional(args.icon, checkIcon),
        cover: optional(args.cover, checkCover),
      };
    }
    case 'appendBlocks': {
      if (args.children === undefined) return deny('children: required');
      checked(checkChildren(args.children));
      return {
        op,
        root,
        blockId: idArg(args, 'block_id'),
        children: args.children,
        position: positionOf(args),
      };
    }
    case 'updateBlock': {
      const blockId = idArg(args, 'block_id');
      if (blockId === root.ref)
        return deny('block_id: the shared root itself — change a page with notion__update_page');
      checked(checkBlockUpdate(args.type, args.content));
      return {
        op,
        root,
        blockId,
        type: args.type as string,
        content: args.content as Readonly<Record<string, unknown>>,
      };
    }
    case 'deleteBlock': {
      const blockId = idArg(args, 'block_id');
      if (blockId === root.ref) {
        return deny(
          'block_id: the shared root itself — a page goes to the trash with notion__trash_page',
        );
      }
      return {
        op,
        root,
        blockId,
      };
    }
    case 'trashPage': {
      const pageId = idArg(args, 'page_id');
      if (pageId === root.ref && root.kind === 'database') {
        return deny('page_id: the shared root is a database, which this plugin does not trash');
      }
      return {
        op,
        root,
        pageId,
      };
    }
    case 'restorePage':
      return {
        op,
        root,
        pageId: idArg(args, 'page_id'),
      };
    case 'createEntry': {
      if (args.properties === undefined) return deny('properties: required');
      return {
        op,
        root,
        dataSourceId: idArg(args, 'data_source_id'),
        properties: args.properties,
        relationIds: relationsOf(args.properties),
        children: optional(args.children, (v) => checkChildren(v)),
        icon: optional(args.icon, checkIcon),
      };
    }
    case 'updateEntry': {
      if (args.properties === undefined) return deny('properties: required');
      return {
        op,
        root,
        dataSourceId: idArg(args, 'data_source_id'),
        pageId: idArg(args, 'page_id'),
        properties: args.properties,
        relationIds: relationsOf(args.properties),
        icon: optional(args.icon, checkIcon),
      };
    }
    case 'listComments':
      return {
        op,
        root,
        blockId: idArg(args, 'block_id'),
        ...paged(args, DEFAULT_PAGE_SIZE.comments),
      };
    case 'createComment': {
      if (args.rich_text === undefined) return deny('rich_text: required');
      checked(checkRichText(args.rich_text, 'rich_text'));
      if ((args.rich_text as unknown[]).length === 0)
        return deny('rich_text: the comment is empty');
      return {
        op,
        root,
        blockId: idArg(args, 'block_id'),
        richText: args.rich_text,
        discussionId: optionalIdArg(args, 'discussion_id'),
      };
    }
  }
}

/** The slices of a call that was read. */
export function slicesOf(call: NotionCall, resources: readonly Resource[]): Slice[] {
  const s = (path: string) => parseSlice(`${PROVIDER_ID}.${path}`);
  if (call.op === 'listRoots') {
    const roots = resources
      .filter((r) => r.provider === PROVIDER_ID)
      .map((r) => notionId(r.ref))
      .filter((ref): ref is string => ref !== null);
    return roots.map((ref) => s(`root[${ref}].R`));
  }
  const R = `root[${call.root.ref}]`;
  switch (call.op) {
    case 'searchContent':
      return [
        ...(call.object === 'data_source' ? [] : [s(`${R}.page[*].R`)]),
        ...(call.object === 'page' ? [] : [s(`${R}.data-source[*].R`)]),
      ];
    case 'getPage':
      return [s(`${R}.page[${call.pageId}].R`)];
    case 'listBlockChildren':
      return [s(`${R}.block[${call.blockId}].R`)];
    case 'getDatabase':
      return [s(`${R}.database[${call.databaseId}].R`)];
    case 'getDataSource':
      return [s(`${R}.data-source[${call.dataSourceId}].R`)];
    case 'queryDataSource':
      return [s(`${R}.data-source[${call.dataSourceId}].entry[*].R`)];
    case 'createPage':
      return [s(`${R}.page[${call.parentPageId}].subpage.W`)];
    case 'updatePage':
      return [s(`${R}.page[${call.pageId}].properties.W`)];
    case 'appendBlocks':
      return [s(`${R}.block[${call.blockId}].children.W`)];
    case 'updateBlock':
      return [s(`${R}.block[${call.blockId}].W`)];
    case 'deleteBlock':
      return [s(`${R}.block[${call.blockId}].delete.W`)];
    case 'trashPage':
      // The root page itself : the whole resource goes, a risk of its own on top.
      return [
        s(`${R}.page[${call.pageId}].trash.W`),
        ...(call.pageId === call.root.ref ? [s(`${R}.root-trash.W`)] : []),
      ];
    case 'restorePage':
      return [s(`${R}.page[${call.pageId}].restore.W`)];
    case 'createEntry':
      return [s(`${R}.data-source[${call.dataSourceId}].entry.W`)];
    case 'updateEntry':
      return [s(`${R}.data-source[${call.dataSourceId}].entry[${call.pageId}].W`)];
    case 'listComments':
      return [s(`${R}.block[${call.blockId}].comment[*].R`)];
    case 'createComment':
      return [
        s(
          call.discussionId
            ? `${R}.block[${call.blockId}].comment[${call.discussionId}].W`
            : `${R}.block[${call.blockId}].comment.W`,
        ),
      ];
  }
}

export function classifyNotion(
  tool: string,
  args: Args,
  resources: readonly Resource[],
): ClassifyOutcome {
  const undeclared = undeclaredArgument(tool, args);
  if (undeclared) return { denied: undeclared };
  const call = readCall(tool, args, resources);
  if ('denied' in call) return call;
  const slices = slicesOf(call, resources);
  if (slices.length === 0) return { denied: 'list_roots: the mission selects no Notion root' };
  return { slices };
}
