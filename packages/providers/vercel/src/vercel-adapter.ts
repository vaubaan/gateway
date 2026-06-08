/**
 * VercelAdapter — paste-token mode, rewraps the official Vercel MCP server.
 *
 * Spec : docs/spec/vaubaan-gateway.md §5.1.
 * ADR  : docs/decisions/rewrap-official-mcps.md.
 *
 * Vaubaan's policy engine and audit live in front ; the actual tool execution
 * is forwarded as JSON-RPC `tools/call` to https://mcp.vercel.com/.
 *
 * Auth model : Bearer (team token, `vcp_...`). OAuth Integration registration
 * to surface a real "Vaubaan Gateway" install button is Phase 5+.
 */

import type {
  Capability,
  McpToolDeclaration,
  ProviderAdmin,
  ProviderBinding,
} from '@vaubaan/shared';
import { availableTools } from './tools.ts';
import { executeCall, type FetchImpl } from './execute.ts';
import { classifyVercel, vercelToolCapabilities, type ClassifyResult } from './classify.ts';

export interface VercelAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
}

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

export class VercelAdapter {
  readonly provider = 'vercel' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = availableTools;
  private readonly fetchImpl: FetchImpl;

  constructor(config: VercelAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  authorizationUrl(_orgId: string, _returnUrl: string, _state: string): string {
    throw new Error(
      'VercelAdapter: OAuth Integration flow not implemented yet — use paste-token mode by inserting provider_admins directly.',
    );
  }

  async handleCallback(_orgId: string, _params: URLSearchParams) {
    throw new Error('VercelAdapter: OAuth callback not implemented in v0.');
  }

  async mintUpstreamToken(admin: ProviderAdmin): Promise<{ token: string; expiresAt: Date }> {
    if (!admin.access_token_encrypted) {
      throw new Error('Vercel ProviderAdmin has no access_token_encrypted.');
    }
    const token = new TextDecoder().decode(admin.access_token_encrypted);
    return { token, expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000) };
  }

  async validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult> {
    if (!/^prj_[A-Za-z0-9]+$/.test(resourceRef)) {
      return { ok: false, error: 'Vercel binding must be a project id like `prj_xxx`.' };
    }
    try {
      const { token } = await this.mintUpstreamToken(admin);
      const data = (await executeCall(this.fetchImpl, token, admin.team_id, 'vercel__get_project', {
        projectId: resourceRef,
      })) as { content?: Array<{ text?: string }>; name?: string };
      // The upstream MCP wraps results in {content:[{type:'text',text:<JSON>}]} ;
      // we accept either shape for the display name.
      let displayName = data.name ?? resourceRef;
      if (Array.isArray(data.content)) {
        const first = data.content[0];
        if (first?.text) {
          try {
            const inner = JSON.parse(first.text) as { name?: string };
            displayName = inner.name ?? displayName;
          } catch {
            // leave default
          }
        }
      }
      return { ok: true, displayName };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Vercel validation failed: ${message}` };
    }
  }

  async executeCall(
    admin: ProviderAdmin,
    _binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const { token } = await this.mintUpstreamToken(admin);
    return executeCall(this.fetchImpl, token, admin.team_id, tool, args);
  }

  toolCapabilities(tool: string): readonly Capability[] {
    return vercelToolCapabilities(tool);
  }

  classify(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyResult {
    return classifyVercel(tool, args, bindings);
  }
}
