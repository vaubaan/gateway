/**
 * Classifier of the `template` provider : `(tool, args, resources) → slices`.
 *
 * Spec : docs/spec/gateway-risk-model.md §7 ; docs/spec/vaubaan-gateway.md §10
 *        ("a classification error is a security hole").
 *
 * Pure : no IO, no credential, no `Date`. Every tool maps to at least one
 * slice ; a call the plugin cannot place on the data model is `denied`
 * (never silently mapped to a broad slice). The gateway checks that the
 * workspace ref belongs to the mission (`resource-not-in-mission`) before
 * calling this ; the classifier only needs to *name* the ref in the slice
 * so env qualification and resource-specific patterns work.
 */

import { parseSlice, type ClassifyOutcome, type Resource } from '@vaubaan/plugin-sdk';

const PROVIDER = 'template';

/** Identifier chars a slice segment accepts ; anything else is refused rather than escaped. */
const SAFE_IDENT = /^[a-zA-Z0-9_./~-]+$/;

export function classifyTemplate(
  tool: string,
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): ClassifyOutcome {
  const workspace = resolveWorkspace(args, resources);
  if ('denied' in workspace) return workspace;
  const ws = workspace.ref;

  switch (tool) {
    case 'template__list_widgets':
      return { slices: [parseSlice(`${PROVIDER}.workspace[${ws}].widget[*].R`)] };
    case 'template__get_widget': {
      const id = ident(args.widget_id);
      if (!id) return { denied: 'widget_id: missing or malformed' };
      return { slices: [parseSlice(`${PROVIDER}.workspace[${ws}].widget[${id}].R`)] };
    }
    case 'template__update_widget': {
      const id = ident(args.widget_id);
      if (!id) return { denied: 'widget_id: missing or malformed' };
      return { slices: [parseSlice(`${PROVIDER}.workspace[${ws}].widget[${id}].W`)] };
    }
    default:
      return { denied: `unknown tool '${tool}'` };
  }
}

function resolveWorkspace(
  args: Readonly<Record<string, unknown>>,
  resources: readonly Resource[],
): { ref: string } | { denied: string } {
  const explicit = ident(args.workspace);
  if (explicit) return { ref: explicit };
  if (args.workspace !== undefined) return { denied: 'workspace: malformed ref' };
  const own = resources.filter((r) => r.provider === PROVIDER);
  if (own.length === 1) return { ref: own[0]!.ref };
  return {
    denied:
      own.length === 0
        ? 'workspace: argument missing and the mission touches no workspace of this provider'
        : `workspace: argument missing and the mission touches ${own.length} workspaces — name one`,
  };
}

function ident(value: unknown): string | null {
  return typeof value === 'string' && SAFE_IDENT.test(value) ? value : null;
}
