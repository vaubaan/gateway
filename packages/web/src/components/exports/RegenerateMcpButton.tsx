'use client';

/**
 * `<RegenerateMcpButton>` — admin-only button to POST
 * `/mcp-configs/regenerate`. Surfaces `{ regenerated, hash,
 * mcp_config.generated_at }` so the operator can confirm whether the
 * snapshot moved or was a no-op.
 *
 * Spec §6.6.
 *
 * RBAC : the RLS policy `mcp_configs_insert_admin` will return a 403
 * if the caller isn't an org admin. We surface the error verbatim — no
 * client-side role guess.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui';

export type RegenerateScope =
  | { readonly kind: 'org' }
  | { readonly kind: 'project'; readonly scopeId: string };

export interface RegenerateMcpButtonProps {
  readonly orgSlug: string;
  readonly scope: RegenerateScope;
  readonly variant: string | null;
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; regenerated: boolean; hash: string }
  | { kind: 'error'; message: string };

export function RegenerateMcpButton(props: RegenerateMcpButtonProps): ReactElement {
  const { orgSlug, scope, variant } = props;
  const [state, setState] = useState<UiState>({ kind: 'idle' });

  const handleClick = async (): Promise<void> => {
    setState({ kind: 'running' });
    try {
      const body =
        scope.kind === 'org'
          ? { scope: 'org', variant: variant ?? undefined }
          : { scope: 'project', scopeId: scope.scopeId, variant: variant ?? undefined };
      const res = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/mcp-configs/regenerate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${String(res.status)}`);
      }
      const payload = (await res.json()) as { regenerated: boolean; hash: string };
      setState({ kind: 'done', regenerated: payload.regenerated, hash: payload.hash });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'unknown error' });
    }
  };

  if (state.kind === 'running') {
    return (
      <span data-testid="regen-mcp-running" className="text-xs text-muted">
        regenerating mcp_config…
      </span>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="danger"
          size="sm"
          data-testid="regen-mcp-retry"
          onClick={() => void handleClick()}
        >
          Retry regenerate
        </Button>
        <span data-testid="regen-mcp-error" className="text-xs text-danger-foreground">
          {state.message}
        </span>
      </div>
    );
  }
  if (state.kind === 'done') {
    return (
      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="regen-mcp-again"
          onClick={() => void handleClick()}
        >
          Regenerate again
        </Button>
        <span data-testid="regen-mcp-summary" className="text-xs text-muted">
          {state.regenerated ? 'mcp_config regenerated' : 'mcp_config unchanged (no-op)'} ·{' '}
          <code className="text-[10px]">{state.hash.slice(0, 12)}</code>
        </span>
      </div>
    );
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-testid="regen-mcp-button"
      onClick={() => void handleClick()}
    >
      Regenerate MCP snapshot
    </Button>
  );
}
