/**
 * Classifier of the `asana` provider : `(tool, args, resources) → slices`.
 *
 * Spec     : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10.
 * Handbook : docs/handbook/providers/asana.md.
 *
 * Pure : no IO, no credential, no clock. `readCall` (call.ts) reads the
 * arguments, `slicesOf` names what the call touches. Every slice names
 * `project[<P>]`, the project the caller claims, checked against the
 * mission's resources. A task gid says nothing about its project : the claim
 * is proven by the executor (`membership.ts`) before anything is sent.
 */

import { parseSlice, type ClassifyOutcome, type Resource, type Slice } from '@vaubaan/plugin-sdk';

import { readCall, type AsanaCall } from './call.ts';
import { PROVIDER_ID } from './identity.ts';

const s = (path: string): Slice => parseSlice(`${PROVIDER_ID}.${path}`);

/** Every slice the call touches. */
export function slicesOf(call: AsanaCall): Slice[] {
  if (call.op === 'listProjects') {
    return [s(`project[${call.projects.map((p) => p.ref).join(',')}].R`)];
  }
  const P = `project[${call.project}]`;
  switch (call.op) {
    case 'getProject':
      return [s(`${P}.R`)];
    case 'listSections':
      return [s(`${P}.section[*].R`)];
    case 'listTasks':
    case 'searchTasks':
      return [s(`${P}.task[*].R`)];
    case 'getTask':
      return [s(`${P}.task[${call.task}].R`)];
    case 'listComments':
      return [s(`${P}.task[${call.task}].comment[*].R`)];
    case 'createTask':
      return [s(`${P}.task.W`)];
    case 'updateTask':
      return [s(`${P}.task[${call.task}].W`)];
    case 'addComment':
      return [s(`${P}.task[${call.task}].comment.W`)];
    case 'deleteTask':
      // Layered : a deletion is a change of the task AND a deletion.
      return [s(`${P}.task[${call.task}].W`), s(`${P}.task[${call.task}].delete.W`)];
  }
}

export function classifyAsana(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const call = readCall(tool, args, resources);
  if ('denied' in call) return call;
  return { slices: slicesOf(call) };
}
