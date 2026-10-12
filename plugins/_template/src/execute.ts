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
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

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
  const workspace = encodeURIComponent(String(args.workspace ?? singleWorkspace(ctx.resources)));
  switch (tool) {
    case 'template__list_widgets':
      return text(await request(ctx, 'GET', `/workspaces/${workspace}/widgets`));
    case 'template__get_widget':
      return text(
        await request(
          ctx,
          'GET',
          `/workspaces/${workspace}/widgets/${encodeURIComponent(String(args.widget_id))}`,
        ),
      );
    case 'template__update_widget':
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
  const workspaces = (await request(ctx, 'GET', '/workspaces')) as readonly WorkspaceDto[];
  return workspaces.map((w) => ({ provider: 'template', ref: w.id, displayName: w.name }));
}

async function request(
  ctx: ConnectionContext,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const secret = expectCredentialKind('template', ctx.credential, 'api-key');
  const res = await ctx.fetch(`${TEMPLATE_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${secret.fields.api_key}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(
      `template rejected the credential (HTTP ${res.status})`,
      res.status,
    );
  }
  if (!res.ok) throw new Error(`template ${method} ${path} failed with HTTP ${res.status}`);
  return await res.json();
}

function singleWorkspace(resources: readonly Resource[]): string {
  const own = resources.filter((r) => r.provider === 'template');
  if (own.length !== 1)
    throw new Error('workspace: argument required when the mission touches several workspaces');
  return own[0]!.ref;
}

function text(payload: unknown): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
