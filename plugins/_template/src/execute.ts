/**
 * Upstream calls of the `template` provider.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *        decrypted in the context, is used for one call, and is never
 *        returned to the executor.
 *
 * Rules :
 *   - `fetch` comes from the context, never from the global : tests inject
 *     `mockFetch`, the host injects a fetch with its own timeouts and proxy.
 *   - a provider failure is thrown, never returned : 401 / 403 →
 *     `UpstreamAuthError` (on a 401 the host tries `refresh` and otherwise
 *     marks the connection `expired`), any other failed status →
 *     `UpstreamHttpError` ; a network error is left to propagate. The host
 *     records it as `upstream_error` in the audit.
 *   - `isError: true` is returned only for what this executor declines
 *     itself (an unknown tool, a workspace outside the mission) : nothing
 *     failed at the provider.
 *   - the provider's public API base is a constant of the plugin : it is a
 *     fact about the provider, not configuration of the instance.
 *   - the workspace is resolved by the classifier's own `resolveWorkspace`
 *     and every identifier that reaches the request path goes through the
 *     classifier's own `pathIdent` : the call runs on the workspace and the
 *     widget the slice named, or not at all.
 *   - what the provider answers is untrusted : checked by a type guard
 *     before it becomes a `Resource`.
 */

import {
  UpstreamAuthError,
  UpstreamHttpError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { MALFORMED_WIDGET_ID, pathIdent, resolveWorkspace } from './classify.ts';
import { API_KEY_FIELD, PROVIDER_ID, TOOL } from './identity.ts';

/** Public API of the provider. Replace with the real base URL in a copy of this template. */
export const TEMPLATE_API_BASE = 'https://api.example.com/v1';

interface WorkspaceDto {
  readonly id: string;
  readonly name: string;
}

export async function executeTemplate(
  ctx: ExecuteContext,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const resolved = resolveWorkspace(args, ctx.resources);
  // Declined here, before any request : a result the agent reads, not an upstream failure.
  if ('denied' in resolved) return refused(resolved.denied);
  // `resolved.ref` and the widget id went through `pathIdent` : one path
  // segment each, so they are interpolated as they are.
  const widgets = `/workspaces/${resolved.ref}/widgets`;
  switch (tool) {
    case TOOL.listWidgets:
      return text(await request(ctx, 'GET', widgets));
    case TOOL.getWidget: {
      const id = pathIdent(args.widget_id);
      if (!id) return refused(MALFORMED_WIDGET_ID);
      return text(await request(ctx, 'GET', `${widgets}/${id}`));
    }
    case TOOL.updateWidget: {
      const id = pathIdent(args.widget_id);
      if (!id) return refused(MALFORMED_WIDGET_ID);
      if (typeof args.name !== 'string' || args.name.length === 0) {
        return refused('name: expected a non-empty string');
      }
      return text(await request(ctx, 'PATCH', `${widgets}/${id}`, { name: args.name }));
    }
    default:
      return refused(`unknown tool '${tool}'`);
  }
}

/** Resources reachable with this credential : one `Resource` per workspace. */
export async function discoverTemplateResources(
  ctx: ConnectionContext,
): Promise<readonly Resource[]> {
  const workspaces = await request(ctx, 'GET', '/workspaces');
  if (!isWorkspaceDtoList(workspaces)) {
    throw new Error(`${PROVIDER_ID}: unexpected workspace list (expected [{ id, name }])`);
  }
  // A ref the classifier would refuse is of no use to a mission : say so at
  // connection time instead of listing a resource no call can name.
  const unusable = workspaces.find((w) => pathIdent(w.id) === null);
  if (unusable) {
    throw new Error(`${PROVIDER_ID}: workspace id '${unusable.id}' is not a path-safe identifier`);
  }
  return workspaces.map((w) => ({ provider: PROVIDER_ID, ref: w.id, displayName: w.name }));
}

function isWorkspaceDtoList(x: unknown): x is readonly WorkspaceDto[] {
  return Array.isArray(x) && x.every(isWorkspaceDto);
}

function isWorkspaceDto(x: unknown): x is WorkspaceDto {
  if (typeof x !== 'object' || x === null) return false;
  return 'id' in x && typeof x.id === 'string' && 'name' in x && typeof x.name === 'string';
}

async function request(
  ctx: ConnectionContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const apiKey = secret.fields[API_KEY_FIELD];
  if (!apiKey) throw new Error(`${PROVIDER_ID}: the credential has no '${API_KEY_FIELD}' field`);
  const res = await ctx.fetch(`${TEMPLATE_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(
      `${PROVIDER_ID} rejected the credential (HTTP ${res.status})`,
      res.status,
    );
  }
  if (!res.ok) {
    throw new UpstreamHttpError(
      `${PROVIDER_ID} ${method} ${path} failed with HTTP ${res.status}`,
      res.status,
    );
  }
  return await res.json();
}

/** What the executor declines itself. A provider failure is thrown instead. */
function refused(message: string): McpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
