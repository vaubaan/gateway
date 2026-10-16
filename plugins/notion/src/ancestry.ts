/**
 * The ancestry check : proving that an object a call names is under the
 * root the call claims.
 *
 * Handbook : docs/handbook/providers/notion.md §5.1 ; Notion's parent object
 *            reference.
 *
 * The classifier prices a call on `root[<R>]` without being able to know
 * where a page, a block, a database or a data source lives : nothing in a
 * Notion id says it, and the connection's token reaches every root shared
 * with it. Before anything is written or returned, `execute` walks the
 * `parent` chain of every id the call acts on, one `GET` per level, until it
 * meets `R`. Refused (an `ExecutorRefusal`) when the chain reaches the
 * workspace, an agent, a parent the connection cannot read (`404` on an
 * ancestor), a parent kind it does not know, an id outside the grammar, an id
 * twice, or more than `MAX_ANCESTRY_DEPTH` levels.
 *
 * Memo within one call (siblings share ancestors), nothing across calls : a
 * page can be moved at any moment and the SDK offers no state for it.
 */

import { ExecutorRefusal, type ConnectionContext } from '@vaubaan/plugin-sdk';

import { failureOf, send } from './api.ts';
import { notionId } from './ids.ts';

/** The kinds of object a walk meets, each read by its own endpoint. */
export type NodeKind = 'page' | 'block' | 'database' | 'data_source';

const ENDPOINT: Readonly<Record<NodeKind, string>> = {
  page: '/pages',
  block: '/blocks',
  database: '/databases',
  data_source: '/data_sources',
};

const LABEL: Readonly<Record<NodeKind, string>> = {
  page: 'page',
  block: 'block',
  database: 'database',
  data_source: 'data source',
};

/** Most levels walked above a target ; deeper is refused (fail closed). */
export const MAX_ANCESTRY_DEPTH = 16;

type Json = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Node {
  readonly kind: NodeKind;
  readonly id: string;
}

/** Where a parent reference leads : the next node, a database met on the way, or a dead end. */
type Step =
  | { readonly next: Node; readonly via?: string }
  | { readonly at: string }
  | { readonly end: 'outside' | 'unreadable' };

/** The node a Notion parent reference names (parent object reference). */
function stepOf(parent: unknown): Step {
  if (!isObject(parent)) return { end: 'unreadable' };
  const ref = (key: string, kind: NodeKind): Step => {
    const id = notionId(parent[key]);
    return id ? { next: { kind, id } } : { end: 'unreadable' };
  };
  switch (parent.type) {
    case 'page_id':
      return ref('page_id', 'page');
    case 'block_id':
      return ref('block_id', 'block');
    case 'database_id':
      return ref('database_id', 'database');
    case 'data_source_id': {
      const id = notionId(parent.data_source_id);
      if (!id) return { end: 'unreadable' };
      // The `database_id` beside it is "provided for convenience" : one hop proves an entry of a database root.
      const via = parent.database_id === undefined ? undefined : notionId(parent.database_id);
      if (via === null) return { end: 'unreadable' };
      return via
        ? { next: { kind: 'data_source', id }, via }
        : { next: { kind: 'data_source', id } };
    }
    case 'workspace':
    case 'agent_id':
      return { end: 'outside' };
    default:
      return { end: 'unreadable' };
  }
}

/** The step above an object of `kind` : a data source names its database and that database's own parent. */
function stepAbove(kind: NodeKind, object: Json): Step {
  if (kind !== 'data_source') return stepOf(object.parent);
  const database = stepOf(object.parent);
  if (!('next' in database) || database.next.kind !== 'database') return database;
  if (object.database_parent === undefined) return database;
  const above = stepOf(object.database_parent);
  if ('next' in above) return { next: above.next, via: database.next.id };
  if ('end' in above) return { at: database.next.id, ...above };
  return above;
}

export type Verdict = 'in' | 'out' | 'unknown';

/** A budget of requests for a walk whose result may be dropped (search results). */
export interface WalkBudget {
  left: number;
}

/**
 * One call's walk : the root, what was proven in and out during the call,
 * and the requests it cost.
 */
export class Ancestry {
  private readonly inside = new Set<string>();
  private readonly outside = new Set<string>();
  requests = 0;

  constructor(
    private readonly ctx: ConnectionContext,
    readonly root: string,
  ) {
    this.inside.add(root);
  }

  /**
   * The object a call targets, read by its own `GET` : the first hop of its
   * walk. A failure is the provider's answer to the agent's call, thrown.
   */
  async fetch(kind: NodeKind, id: string): Promise<Json> {
    const path = `${ENDPOINT[kind]}/${id}`;
    const answer = await send(this.ctx, 'GET', path);
    this.requests += 1;
    if (answer.status < 200 || answer.status >= 300) throw failureOf('GET', path, answer);
    if (!isObject(answer.body) || notionId(answer.body.id) !== id) {
      throw new ExecutorRefusal(
        `notion: the answer for ${LABEL[kind]} '${id}' is not that ${LABEL[kind]}`,
      );
    }
    return answer.body;
  }

  /** Proves `id` under the root, or declines the call. `first` is the target's own answer, when read. */
  async prove(kind: NodeKind, id: string, first?: Json): Promise<void> {
    const verdict = await this.walk({ kind, id }, first, null);
    if (verdict.verdict === 'in') return;
    throw new ExecutorRefusal(
      verdict.tooDeep
        ? `notion: ${LABEL[kind]} '${id}' could not be shown to be under the shared root '${this.root}' of this call within ${MAX_ANCESTRY_DEPTH} levels`
        : `notion: ${LABEL[kind]} '${id}' is not under the shared root '${this.root}' of this call`,
    );
  }

  /** Whether `id` is under the root, within a budget of requests ; never declines. */
  async check(
    kind: NodeKind,
    id: string,
    first: Json | undefined,
    budget: WalkBudget,
  ): Promise<Verdict> {
    return (await this.walk({ kind, id }, first, budget)).verdict;
  }

  private async walk(
    start: Node,
    first: Json | undefined,
    budget: WalkBudget | null,
  ): Promise<{ readonly verdict: Verdict; readonly tooDeep?: boolean }> {
    const met: string[] = [];
    const settle = (verdict: 'in' | 'out') => {
      for (const id of met) (verdict === 'in' ? this.inside : this.outside).add(id);
      return { verdict };
    };
    let node: Node = start;
    let object: Json | undefined = first;
    for (;;) {
      if (this.inside.has(node.id)) return settle('in');
      if (this.outside.has(node.id) || met.includes(node.id)) return settle('out');
      if (met.length > MAX_ANCESTRY_DEPTH) return { verdict: 'out', tooDeep: true };
      met.push(node.id);
      if (!object) {
        if (budget) {
          if (budget.left <= 0) return { verdict: 'unknown' };
          budget.left -= 1;
        }
        const path = `${ENDPOINT[node.kind]}/${node.id}`;
        const answer = await send(this.ctx, 'GET', path);
        this.requests += 1;
        if (answer.status === 404 && met.length > 1) return settle('out'); // an ancestor this token cannot read
        if (answer.status < 200 || answer.status >= 300) throw failureOf('GET', path, answer);
        object = isObject(answer.body) ? answer.body : undefined;
      }
      if (!object || notionId(object.id) !== node.id) return settle('out');
      const step = stepAbove(node.kind, object);
      if ('next' in step) {
        if (step.via !== undefined) {
          if (this.inside.has(step.via)) return settle('in');
          met.push(step.via);
        }
        node = step.next;
        object = undefined;
        continue;
      }
      if ('at' in step) {
        if (this.inside.has(step.at)) return settle('in');
        met.push(step.at);
      }
      return settle('out');
    }
  }
}
