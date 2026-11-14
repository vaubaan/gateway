/**
 * Upstream calls of the `template` provider.
 *
 * Spec : docs/spec/vaubaan-gateway.md §2.4 — the credential arrives
 *        decrypted in the context, is used for one call, and is never
 *        returned to the executor.
 *
 * Rules :
 *   - every request goes through the SDK's `httpJson` : `fetch` and the
 *     caller's `signal` come from the context (tests inject `mockFetch`, the
 *     host a fetch with its own timeouts and proxy), the answer is bounded,
 *     and a failure is thrown typed — 401 / 403 `UpstreamAuthError` (on a
 *     401 the host tries `refresh` and otherwise marks the account
 *     `expired`), any other failed status `UpstreamHttpError`, an answer
 *     that is not what the guard says `UpstreamProtocolError`. The host
 *     records it as `upstream_error` in the audit.
 *   - `refusalResult` is returned only for what this executor declines
 *     itself (an unknown tool, a workspace outside the mission) : nothing
 *     failed at the provider.
 *   - the provider's public API base is a constant of the plugin : it is a
 *     fact about the provider, not configuration of the instance.
 *   - the workspace is resolved by the classifier's own `resolveWorkspace`
 *     and every identifier that reaches the request path goes through the
 *     classifier's own `pathIdent` : the call runs on the workspace and the
 *     widget the slice named, or not at all.
 *   - what the provider answers is untrusted : read through a type guard
 *     (`httpJson`'s third argument) before it becomes a `Resource` ; an
 *     answer passed to the agent as it is takes `anyJson`.
 */

import {
  UpstreamProtocolError,
  anyJson,
  expectCredentialKind,
  httpJson,
  isRecord,
  jsonResult,
  refusalResult,
  type AccountContext,
  type ExecuteContext,
  type Guard,
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
  if ('denied' in resolved) return refusalResult(resolved.denied);
  // `resolved.ref` and the widget id went through `pathIdent` : one path
  // segment each, so they are interpolated as they are.
  const widgets = `/workspaces/${resolved.ref}/widgets`;
  switch (tool) {
    case TOOL.listWidgets:
      return jsonResult(await request(ctx, 'GET', widgets, anyJson));
    case TOOL.getWidget: {
      const id = pathIdent(args.widget_id);
      if (!id) return refusalResult(MALFORMED_WIDGET_ID);
      return jsonResult(await request(ctx, 'GET', `${widgets}/${id}`, anyJson));
    }
    case TOOL.updateWidget: {
      const id = pathIdent(args.widget_id);
      if (!id) return refusalResult(MALFORMED_WIDGET_ID);
      if (typeof args.name !== 'string' || args.name.length === 0) {
        return refusalResult('name: expected a non-empty string');
      }
      return jsonResult(
        await request(ctx, 'PATCH', `${widgets}/${id}`, anyJson, { name: args.name }),
      );
    }
    case TOOL.deleteWidget: {
      const id = pathIdent(args.widget_id);
      if (!id) return refusalResult(MALFORMED_WIDGET_ID);
      await request(ctx, 'DELETE', `${widgets}/${id}`, anyJson);
      return jsonResult({ deleted: id });
    }
    default:
      return refusalResult(`unknown tool '${tool}'`);
  }
}

/** Resources reachable with this credential : one `Resource` per workspace. */
export async function discoverTemplateResources(ctx: AccountContext): Promise<readonly Resource[]> {
  const workspaces = await request(ctx, 'GET', '/workspaces', isWorkspaceDtoList);
  // A ref the classifier would refuse is of no use to a mission : say so at
  // account time instead of listing a resource no call can name.
  const unusable = workspaces.find((w) => pathIdent(w.id) === null);
  if (unusable) {
    throw new UpstreamProtocolError(
      `${PROVIDER_ID}: workspace id '${unusable.id}' is not a path-safe identifier`,
    );
  }
  return workspaces.map((w) => ({ provider: PROVIDER_ID, ref: w.id, displayName: w.name }));
}

function isWorkspaceDtoList(x: unknown): x is readonly WorkspaceDto[] {
  return Array.isArray(x) && x.every(isWorkspaceDto);
}

function isWorkspaceDto(x: unknown): x is WorkspaceDto {
  return isRecord(x) && typeof x.id === 'string' && typeof x.name === 'string';
}

/**
 * One call to the provider with the account's key, its answer read
 * through `guard` ; a failure is thrown, typed (`httpJson`).
 */
export async function request<T>(
  ctx: AccountContext,
  method: string,
  path: string,
  guard: Guard<T>,
  body?: unknown,
): Promise<T> {
  const secret = expectCredentialKind(PROVIDER_ID, ctx.credential, 'api-key');
  const apiKey = secret.fields[API_KEY_FIELD];
  if (!apiKey) throw new Error(`${PROVIDER_ID}: the credential has no '${API_KEY_FIELD}' field`);
  return httpJson(
    ctx,
    {
      url: `${TEMPLATE_API_BASE}${path}`,
      method,
      headers: { authorization: `Bearer ${apiKey}` },
      ...(body !== undefined ? { body } : {}),
      what: `${PROVIDER_ID} ${method} ${path}`,
    },
    guard,
  );
}
