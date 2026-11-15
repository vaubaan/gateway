/**
 * Notion's parent object reference, read once for the ancestry walk and for
 * discovery.
 *
 * Handbook : docs/handbook/services/notion.md ; Notion's parent
 *            object reference.
 */

import { isRecord } from '@vaubaan/plugin-sdk';

import { notionId } from './ids.ts';

/** The kinds of object a parent reference names, each read by its own endpoint. */
export type NodeKind = 'page' | 'block' | 'database' | 'data_source';

export const ENDPOINT: Readonly<Record<NodeKind, string>> = {
  page: '/pages',
  block: '/blocks',
  database: '/databases',
  data_source: '/data_sources',
};

export const LABEL: Readonly<Record<NodeKind, string>> = {
  page: 'page',
  block: 'block',
  database: 'database',
  data_source: 'data source',
};

/**
 * What a parent reference says :
 *   - `node` : the parent, and for a `data_source_id` parent the database it
 *     carries "for convenience" (`database`) ;
 *   - `workspace` : the top of the workspace ;
 *   - `agent` : an agent's instruction page, under no shared page ;
 *   - `unreadable` : a shape not known, or an id outside the grammar.
 */
export type ParentRef =
  | {
      readonly node: { readonly kind: NodeKind; readonly id: string };
      readonly database?: string;
    }
  | { readonly end: 'workspace' | 'agent' | 'unreadable' };

const KIND_OF: Readonly<Record<string, NodeKind>> = {
  page_id: 'page',
  block_id: 'block',
  database_id: 'database',
  data_source_id: 'data_source',
};

export function parentRef(parent: unknown): ParentRef {
  if (!isRecord(parent) || typeof parent.type !== 'string') return { end: 'unreadable' };
  if (parent.type === 'workspace') return { end: 'workspace' };
  if (parent.type === 'agent_id') return { end: 'agent' };
  const kind = KIND_OF[parent.type];
  if (!kind) return { end: 'unreadable' };
  const id = notionId(parent[parent.type]);
  if (!id) return { end: 'unreadable' };
  if (kind !== 'data_source' || parent.database_id === undefined) return { node: { kind, id } };
  const database = notionId(parent.database_id);
  return database ? { node: { kind, id }, database } : { end: 'unreadable' };
}
