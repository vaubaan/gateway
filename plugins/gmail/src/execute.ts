/**
 * Execution side of the `gmail` provider — experimental.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5 (plugins).
 * Handbook : docs/handbook/providers/gmail.md.
 *
 * `discoverResources` is real : it reads the authenticated mailbox's profile
 * and returns it as the single resource of the connection. `execute` is not :
 * every tool answers a structured `not_implemented` error, because no Gmail
 * tool is exposed (`gmailTools` is empty) and no upstream adapter exists yet.
 * Both use the injected `fetch`, never the global.
 */

import {
  UpstreamAuthError,
  expectCredentialKind,
  type ConnectionContext,
  type ExecuteContext,
  type McpToolResult,
  type Resource,
} from '@vaubaan/plugin-sdk';

import { GMAIL_API_BASE } from './credential.ts';

export const GMAIL_PLUGIN_ID = 'gmail';

/** Machine-readable error code `execute` returns for every tool while the plugin is experimental. */
export const GMAIL_NOT_IMPLEMENTED_CODE = 'not_implemented';

/**
 * Every tool answers the same structured error : the plugin classifies but
 * does not execute. `isError: true` so MCP clients surface it as a failure.
 */
export async function executeGmail(
  _ctx: ExecuteContext,
  tool: string,
  _args: Readonly<Record<string, unknown>>,
): Promise<McpToolResult> {
  const payload = {
    error: GMAIL_NOT_IMPLEMENTED_CODE,
    plugin: GMAIL_PLUGIN_ID,
    experimental: true,
    tool,
    message: `gmail: tool '${tool}' is not implemented — the gmail plugin is experimental (classifier only) and exposes no executable tool yet.`,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

interface ProfileDto {
  readonly emailAddress?: unknown;
  readonly messagesTotal?: unknown;
  readonly threadsTotal?: unknown;
}

/**
 * The authenticated mailbox (`users/me`) as the connection's single resource.
 * `ref` is the lower-cased address ; `metadata.account_email` seeds the
 * classifier's `to-zone[self]` rule. The zoning lists (internal domains,
 * allowlists, sensitive labels) are left for the owner to fill : pre-filling
 * `internal_domains` from the address would make every `gmail.com` sender
 * internal on a consumer mailbox.
 */
export async function discoverGmailResources(ctx: ConnectionContext): Promise<readonly Resource[]> {
  const token = expectCredentialKind(GMAIL_PLUGIN_ID, ctx.credential, 'oauth2').accessToken;
  const res = await ctx.fetch(`${GMAIL_API_BASE}/users/me/profile`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (res.status === 401 || res.status === 403) {
    throw new UpstreamAuthError(
      `gmail rejected the credential (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`,
      res.status,
    );
  }
  if (!res.ok) throw new Error(`gmail profile endpoint failed with HTTP ${res.status}`);

  const profile = (await res.json()) as ProfileDto;
  if (typeof profile.emailAddress !== 'string' || !profile.emailAddress.includes('@')) {
    throw new Error('gmail profile endpoint answered without an emailAddress');
  }
  const email = profile.emailAddress.toLowerCase();
  return [
    {
      provider: GMAIL_PLUGIN_ID,
      ref: email,
      displayName: email,
      metadata: {
        account_email: email,
        ...(typeof profile.messagesTotal === 'number'
          ? { messages_total: profile.messagesTotal }
          : {}),
        ...(typeof profile.threadsTotal === 'number'
          ? { threads_total: profile.threadsTotal }
          : {}),
      },
    },
  ];
}
