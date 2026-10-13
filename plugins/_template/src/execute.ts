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
 *   - 401 / 403 from the provider → `UpstreamAuthError`, so the host can try
 *     `refresh` and otherwise mark the connection `expired`.
 *   - the provider's public API base is a constant of the plugin : it is a
 *     fact about the provider, not configuration of the instance.
 *   - the workspace is resolved by the classifier's own `resolveWorkspace` :
 *     the call runs on the workspace the slice named, or not at all.
 *   - what the provider answers is untrusted : checked by a type guard
 *     before it becomes a `Resource`.
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { resolveWorkspace } from './classify.ts';
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
  if ('denied' in resolved) throw new Error(resolved.denied);
  const workspace = encodeURIComponent(resolved.ref);
  switch (tool) {
    case TOOL.listWidgets:
      return text(await request(ctx, 'GET', `/workspaces/${workspace}/widgets`));
    case TOOL.getWidget:
      return text(
        await request(
          ctx,
          'GET',
          `/workspaces/${workspace}/widgets/${encodeURIComponent(String(args.widget_id))}`,
        ),
      );
    case TOOL.updateWidget:
      return text(
        await request(
          ctx,
          'PATCH',
          `/workspaces/${workspace}/widgets/${encodeURIComponent(String(args.widget_id))}`,
          {
            name: args.name,
          },
        ),
      );
    default:
      return { content: [{ type: 'text', text: `unknown tool '${tool}'` }], isError: true };
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
  if (!res.ok) throw new Error(`${PROVIDER_ID} ${method} ${path} failed with HTTP ${res.status}`);
  return await res.json();
}

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
