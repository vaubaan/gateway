/**
 * @deprecated legacy v4, deleted in P1.6.
 *
 * `VercelAdapter` — the v4 `UpstreamAdapter` duck type the gateway pipeline
 * (`apps/gateway/src/lib/gateway/build.ts`) still instantiates. It is a thin
 * shell over the v5 modules : the one classifier (`classify.ts`) and the one
 * upstream caller (`execute.ts`). The v4 `*_from_venv` secret transfer is
 * gone (plan §8-Q5 : no v5 counterpart) ; the `venvStore` option is accepted
 * and ignored so the v4 app keeps compiling.
 */

import type { McpToolDeclaration, ProviderAdmin, ProviderBinding } from '@vaubaan/shared';

import { callVercelTool, type FetchImpl } from './execute.ts';
import { classifyVercelV4, type ClassifyResult } from './risk-classifier.ts';
import { vercelTools } from './tools.ts';

/** @deprecated legacy v4, deleted in P1.6. */
export interface VercelAdapterConfig {
  /** Override fetch in tests. */
  fetchImpl?: FetchImpl;
  /** @deprecated ignored — the venv store has no v5 counterpart (plan §8-Q5). */
  venvStore?: unknown;
}

/** @deprecated legacy v4, deleted in P1.6. */
export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
  warnings?: string[];
}

/** @deprecated legacy v4, deleted in P1.6 — use `vercelPlugin`. */
export class VercelAdapter {
  readonly provider = 'vercel' as const;
  readonly availableTools: ReadonlyArray<McpToolDeclaration> = vercelTools;
  private readonly fetchImpl: FetchImpl;

  constructor(config: VercelAdapterConfig = {}) {
    this.fetchImpl = config.fetchImpl ?? fetch;
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
      const data = (await callVercelTool(
        { fetch: this.fetchImpl, token, teamId: admin.team_id },
        'vercel__get_project',
        { projectId: resourceRef },
      )) as { content?: Array<{ text?: string }>; name?: string };
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
      return {
        ok: true,
        displayName,
        warnings: [
          'Vercel does not allow API tokens to modify Deployment Protection (SSO / Password). ' +
            'If your previews are behind Vercel Authentication, disable it manually in the ' +
            'Vercel dashboard (Project → Settings → Deployment Protection) or attach a custom domain.',
        ],
      };
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
    return callVercelTool({ fetch: this.fetchImpl, token, teamId: admin.team_id }, tool, args);
  }

  classifyV4(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyResult {
    return classifyVercelV4(tool, args, bindings);
  }
}
