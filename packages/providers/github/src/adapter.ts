/**
 * Generic ProviderAdapter contract.
 *
 * Spec : docs/spec/gateway-capability-model.md
 *
 * Every cloud provider (GitHub, Vercel, Supabase, Railway) implements this
 * contract. The MCP gateway dispatches against it without knowing provider
 * specifics. Authorization is decided by classifying a concrete call into a
 * capability and checking it against the token's granted set — the provider
 * plugin owns that classification (`classify`), in the provider's *native*
 * semantics (no runner house-style leaks in).
 */

import type {
  Capability,
  EnvResolution,
  McpToolDeclaration,
  Provider,
  ProviderAdmin,
  ProviderBinding,
} from '@vaubaan/shared';

export interface ValidateResult {
  ok: boolean;
  displayName?: string;
  error?: string;
}

export interface MintedToken {
  token: string;
  expiresAt: Date;
}

/** The capability a concrete call requires, or a structural denial.
 *  `binding` is the binding the call resolved to (when applicable) — the
 *  gateway uses it to read per-binding policy knobs like the github
 *  env-less-exclude set (spec §5.1 #4). Optional ; not all classifiers / not
 *  all tools resolve to a binding. */
export type ClassifyResult =
  | { capability: Capability; binding?: ProviderBinding }
  | { denied: string };

export interface ProviderAdapter {
  readonly provider: Provider;
  readonly availableTools: ReadonlyArray<McpToolDeclaration>;

  authorizationUrl(orgId: string, returnUrl: string, state: string): string;

  handleCallback(
    orgId: string,
    params: URLSearchParams,
  ): Promise<{
    installation_id: string | null;
    team_id: string | null;
    access_token_encrypted: Uint8Array | null;
    refresh_token_encrypted: Uint8Array | null;
    expires_at: Date | null;
  }>;

  mintUpstreamToken(admin: ProviderAdmin): Promise<MintedToken>;

  validateBinding(admin: ProviderAdmin, resourceRef: string): Promise<ValidateResult>;

  executeCall(
    admin: ProviderAdmin,
    binding: ProviderBinding,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;

  /**
   * The env-less capability surface of a tool — every capability it may require
   * across its argument space. Used for static `tools/list` filtering and the
   * catalog's `callable` flag. Returns `[]` for an unknown tool.
   */
  toolCapabilities(tool: string): readonly Capability[];

  /**
   * How env is determined at `tools/call` time for this tool — drives whether
   * the static filter requires an exact env-less grant (`'static'`) or accepts
   * any env-qualified grant on the right 4-tuple (`'runtime'`). See
   * `EnvResolution` in `@vaubaan/shared/types.ts` for the full contract.
   * Defaults to `'static'` for unknown tools (safer : less false `callable`).
   */
  toolEnvResolution(tool: string): EnvResolution;

  /**
   * The exact capability a concrete call requires. `env` is resolved here (from
   * the call args, or from the matched binding for providers where env = a
   * distinct resource). `denied` when the call is structurally illegal: unknown
   * tool, missing/unbound target, or nonsensical arguments.
   */
  classify(
    tool: string,
    args: Record<string, unknown>,
    bindings: ReadonlyArray<ProviderBinding>,
  ): ClassifyResult;
}
