/**
 * The ancestry check : proving that an object a call names is under the
 * root the call claims.
 *
 * Handbook : docs/handbook/providers/notion.md ; Notion's parent object
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
 * twice, or more than `MAX_ANCESTRY_DEPTH` levels. A target answered by an
 * object other than the one asked for is Notion's failure, not a decline
 * (`UpstreamProtocolError`).
 *
 * Memo within one call (siblings share ancestors), nothing across calls : a
 * page can be moved at any moment and the SDK offers no state for it.
 */

import {
  ExecutorRefusal,
  UpstreamProtocolError,
  anyJson,
  isRecord,
  type ConnectionContext,
} from '@vaubaan/plugin-sdk';

import { readOrMissing, request } from './api.ts';
import { notionId } from './ids.ts';
import type { Json } from './json.ts';
import { ENDPOINT, LABEL, parentRef, type NodeKind } from './parents.ts';

export type { NodeKind } from './parents.ts';

/** Most levels walked above a target ; deeper is refused (fail closed). */
export const MAX_ANCESTRY_DEPTH = 16;

interface Node {
  readonly kind: NodeKind;
  readonly id: string;
}

/**
 * What is above an object : the databases met on the way (each a possible
 * root, never a node of the walk) and the next node, absent at a dead end
 * (the workspace, an agent, a shape not known).
 */
interface Above {
  readonly databases: readonly string[];
  readonly next?: Node;
}

/** A data source names its database and, in `database_parent`, that database's own parent. */
function above(kind: NodeKind, object: Json): Above {
  const parent = parentRef(object.parent);
  if (!('node' in parent)) return { databases: [] };
  if (kind !== 'data_source') {
    return { databases: parent.database ? [parent.database] : [], next: parent.node };
  }
  if (parent.node.kind !== 'database') return { databases: [] };
  const database = parent.node.id;
  // Without `database_parent`, the database itself is the next node, read by its own `GET`.
  if (object.database_parent === undefined) return { databases: [], next: parent.node };
  const grand = parentRef(object.database_parent);
  return 'node' in grand ? { databases: [database], next: grand.node } : { databases: [database] };
}

export type Verdict = 'in' | 'out' | 'unknown';

/** A budget of requests shared by the walks of one call whose targets are not the call's own. */
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
    this.requests += 1;
    const object = await request(this.ctx, 'GET', `${ENDPOINT[kind]}/${id}`, isRecord);
    if (notionId(object.id) !== id) {
      throw new UpstreamProtocolError(
        `Notion GET ${ENDPOINT[kind]}/${id}: the answer is not that ${LABEL[kind]}`,
      );
    }
    return object;
  }

  /**
   * Proves `id` under the root, or declines the call. `first` is the
   * target's own answer, when read ; `budget`, when given, bounds the
   * requests and declines when it runs out (fail closed).
   */
  async prove(kind: NodeKind, id: string, first?: Json, budget?: WalkBudget): Promise<void> {
    const verdict = await this.walk({ kind, id }, first, budget ?? null);
    if (verdict.verdict === 'in') return;
    const where = `under the shared root '${this.root}' of this call`;
    throw new ExecutorRefusal(
      verdict.tooDeep
        ? `notion: ${LABEL[kind]} '${id}' could not be shown to be ${where} within ${MAX_ANCESTRY_DEPTH} levels`
        : verdict.verdict === 'unknown'
          ? `notion: ${LABEL[kind]} '${id}' could not be shown to be ${where} within the requests this call may spend`
          : `notion: ${LABEL[kind]} '${id}' is not ${where}`,
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
    // `visited` : the nodes read, for the cycle and depth checks ; `met` : every id
    // to settle once the verdict is known, the databases seen beside a parent included.
    const visited: string[] = [];
    const met: string[] = [];
    const settle = (verdict: 'in' | 'out') => {
      for (const id of met) (verdict === 'in' ? this.inside : this.outside).add(id);
      return { verdict };
    };
    let node: Node = start;
    let object: Json | undefined = first;
    for (;;) {
      if (this.inside.has(node.id)) return settle('in');
      if (this.outside.has(node.id) || visited.includes(node.id)) return settle('out');
      if (visited.length > MAX_ANCESTRY_DEPTH) return { verdict: 'out', tooDeep: true };
      visited.push(node.id);
      met.push(node.id);
      if (!object) {
        if (budget) {
          if (budget.left <= 0) return { verdict: 'unknown' };
          budget.left -= 1;
        }
        const path = `${ENDPOINT[node.kind]}/${node.id}`;
        this.requests += 1;
        // An ancestor this token cannot read is outside every root. So is a reference's own
        // id (a budgeted walk) : "exists elsewhere" and "not shared" get the same refusal.
        // The target's own 404 is Notion's answer to the call, thrown.
        const missingIsOut = visited.length > 1 || budget !== null;
        // Read leniently : an answer that is not an object proves nothing, so the walk ends out.
        const answer = missingIsOut
          ? await readOrMissing(this.ctx, path, anyJson)
          : await request(this.ctx, 'GET', path, anyJson);
        if (answer === null) return settle('out');
        object = isRecord(answer) ? answer : undefined;
      }
      if (!object || notionId(object.id) !== node.id) return settle('out');
      const step = above(node.kind, object);
      for (const database of step.databases) {
        if (this.inside.has(database)) return settle('in');
        met.push(database);
      }
      if (!step.next) return settle('out');
      node = step.next;
      object = undefined;
    }
  }
}
