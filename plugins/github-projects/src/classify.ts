/**
 * Classifier of the `github-projects` service : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §7. Handbook :
 * docs/handbook/services/github-projects.md §2 and §5.
 *
 * Pure. The call is read once by `readProjectCall` (`call.ts`), which the
 * executor calls too : the project, every id and every argument the request
 * carries are checked there, and a call it cannot read is `denied`. This
 * file only says what the checked call touches.
 */

import { parseSlice, type ClassifyOutcome, type Resource } from '@vaubaan/plugin-sdk';

import { isDenied, readProjectCall, type ProjectCall } from './call.ts';
import { SERVICE_ID } from './identity.ts';

export function classifyGithubProjects(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const call = readProjectCall(tool, args, resources);
  if (isDenied(call)) return call;
  return { slices: slicesOf(call).map((s) => parseSlice(s)) };
}

/** The slices of a checked call, as text. Every id went through its grammar : digits only. */
export function slicesOf(call: ProjectCall): string[] {
  const p = `${SERVICE_ID}.project[${call.project.ref}]`;
  switch (call.kind) {
    case 'get-project':
      return [`${p}.R`];
    case 'list-fields':
      return [`${p}.field[*].R`];
    case 'get-field':
      return [`${p}.field[${call.fieldId}].R`];
    case 'list-items':
      return [`${p}.item[*].R`];
    case 'get-item':
      return [`${p}.item[${call.itemId}].R`];
    case 'list-view-items':
      // The view's own settings, and the items it shows.
      return [`${p}.view[${call.viewNumber}].R`, `${p}.item[*].R`];
    case 'add-item':
    case 'add-draft':
      return [`${p}.item.W`];
    case 'update-item':
      // One slice per field written : a mission narrowed to one field
      // (`value[<Status id>]`) refuses a call that also writes another.
      return call.values.map((v) => `${p}.item[${call.itemId}].value[${v.id}].W`);
    case 'delete-item':
      return [`${p}.item[${call.itemId}].delete.W`];
    case 'create-field':
      return [`${p}.field.W`];
    case 'create-view':
      return [`${p}.view.W`];
  }
}
