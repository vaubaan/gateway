/**
 * Classifier of the `template` service : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 *
 * Pure : no IO, no credential, no `Date`. Every tool maps to at least one
 * slice ; a call the plugin cannot place on the data model is `denied`
 * (never silently mapped to a broad slice).
 *
 * The classifier itself checks that a named workspace is one of the
 * mission's resources (`resolveWorkspace`) and refuses the call otherwise.
 * The gateway's resource stage runs on the slices this function returns and
 * only recognises refs the account has discovered, so a ref it has never
 * seen would not be caught there : the plugin is the place that knows which
 * argument names the resource. `execute` resolves the workspace with the
 * same function, so the slice always names the workspace the call runs on.
 */

import {
  parseSlice,
  type ClassifyOutcome,
  type Resource,
  PATH_IDENT,
  pathIdent,
} from '@vaubaan/plugin-sdk';

import { SERVICE_ID, TOOL } from './identity.ts';

/** The SDK's path identifier grammar, re-exported for this plugin's modules. */
export { PATH_IDENT, pathIdent };

/** Refusal sentence of a missing or malformed widget id, shared with `execute`. */
export const MALFORMED_WIDGET_ID = 'widget_id: missing or malformed';

export function classifyTemplate(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const workspace = resolveWorkspace(args, resources);
  if ('denied' in workspace) return workspace;
  const ws = workspace.ref;

  switch (tool) {
    case TOOL.listWidgets:
      return { slices: [parseSlice(`${SERVICE_ID}.workspace[${ws}].widget[*].R`)] };
    case TOOL.getWidget: {
      const id = pathIdent(args.widget_id);
      if (!id) return { denied: MALFORMED_WIDGET_ID };
      return { slices: [parseSlice(`${SERVICE_ID}.workspace[${ws}].widget[${id}].R`)] };
    }
    case TOOL.updateWidget: {
      const id = pathIdent(args.widget_id);
      if (!id) return { denied: MALFORMED_WIDGET_ID };
      return { slices: [parseSlice(`${SERVICE_ID}.workspace[${ws}].widget[${id}].W`)] };
    }
    case TOOL.deleteWidget: {
      const id = pathIdent(args.widget_id);
      if (!id) return { denied: MALFORMED_WIDGET_ID };
      // The verb leaf : this slice touches `widget-delete` AND `widget-write`
      // (whose pattern `widget[**].W` covers it), so a mission needs both.
      return { slices: [parseSlice(`${SERVICE_ID}.workspace[${ws}].widget[${id}].delete.W`)] };
    }
    default:
      return { denied: `unknown tool '${tool}'` };
  }
}

/**
 * The workspace a call targets, for `classify` and `execute` alike :
 *
 *   - `args.workspace` given : it must be a well-formed ref AND one of the
 *     mission's resources of this service — anything else is refused (fail
 *     closed, never the single resource as a silent substitute) ;
 *   - absent : the mission's single workspace, or a refusal when it holds
 *     none or several.
 */
export function resolveWorkspace(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): { ref: string } | { denied: string } {
  const own = resources.filter((r) => r.service === SERVICE_ID);
  if (args.workspace !== undefined) {
    const explicit = pathIdent(args.workspace);
    if (!explicit) return { denied: 'workspace: malformed ref' };
    return own.some((r) => r.ref === explicit)
      ? { ref: explicit }
      : { denied: `workspace '${explicit}' is not selected in this mission` };
  }
  if (own.length === 1) return { ref: own[0]!.ref };
  return {
    denied:
      own.length === 0
        ? 'workspace: argument missing and the mission touches no workspace of this service'
        : `workspace: argument missing and the mission touches ${own.length} workspaces — name one`,
  };
}
