'use client';

/**
 * `<McpExportButton>` — fetches `/exports/mcp`, writes `mcp.json`, then
 * unseals the manifest entries to write the `.env-mcp` companion file.
 *
 * Spec §6.7, §11.1.
 *
 * Two file downloads back-to-back :
 *   1. `<stem>.mcp.json` — the composed `mcp.json` snapshot (no
 *      cleartext, just `mcpServers: { ... }`).
 *   2. `<stem>.env-mcp` — placeholder-aware `.env` companion. Resolved
 *      values from unseal; unresolved keys become
 *      `# UNAVAILABLE: <key> (...)` lines.
 *
 * No ct ever lives in React state — `unsealAs` returns a `Uint8Array`
 * that is wiped immediately after decoding inside
 * `@/lib/exports/dotenv-assembly`.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import type { SealedBlobV1 } from '@crm/core/crypto';

import { Button } from '@/components/ui';
import { identityStore } from '@/lib/crypto/identity-store';
import { assembleMcpCompanion, type AssemblableEntry } from '@/lib/exports/dotenv-assembly';
import { triggerBrowserDownload } from '@/lib/exports/download';

export type McpScope =
  | { readonly kind: 'org' }
  | { readonly kind: 'project'; readonly scopeId: string };

export interface McpExportButtonProps {
  readonly orgSlug: string;
  readonly scope: McpScope;
  readonly variant: string | null;
  readonly filenameStem?: string;
}

interface ExportMcpResponse {
  readonly mcp_json: { readonly mcpServers: Readonly<Record<string, unknown>> };
  readonly env_manifest: {
    readonly keys: ReadonlyArray<{
      readonly key: string;
      readonly source_resource_id: string;
      readonly source_kind: string;
    }>;
  };
  readonly env_dotenv_template: string;
  readonly env_entries: ReadonlyArray<{
    readonly key: string;
    readonly source_resource_id: string;
    readonly source_resource_name: string;
    readonly source_kind: string;
    readonly sealed_blob: SealedBlobV1 | null;
    readonly recipient_fingerprints: ReadonlyArray<string>;
  }>;
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'running'; status: string }
  | {
      kind: 'done';
      resolved: ReadonlyArray<string>;
      unavailable: ReadonlyArray<string>;
    }
  | { kind: 'error'; message: string };

export function McpExportButton(props: McpExportButtonProps): ReactElement {
  const { orgSlug, scope, variant, filenameStem } = props;
  const [state, setState] = useState<UiState>({ kind: 'idle' });

  const handleClick = async (): Promise<void> => {
    const identity = identityStore.get();
    if (!identity) {
      setState({ kind: 'error', message: 'Unlock your identity to download exports.' });
      return;
    }
    setState({ kind: 'running', status: 'fetching mcp snapshot…' });
    try {
      const body =
        scope.kind === 'org'
          ? { scope: 'org', variant: variant ?? undefined }
          : { scope: 'project', scopeId: scope.scopeId, variant: variant ?? undefined };
      const res = await fetch(`/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/exports/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${String(res.status)}`);
      }
      const payload = (await res.json()) as ExportMcpResponse;

      const stem =
        filenameStem ?? (scope.kind === 'project' ? `project-${scope.scopeId}` : orgSlug);
      triggerBrowserDownload(
        `${stem}.mcp.json`,
        JSON.stringify(payload.mcp_json, null, 2),
        'application/json',
      );

      setState({ kind: 'running', status: 'unsealing .env-mcp companion…' });
      const entries: AssemblableEntry[] = payload.env_entries.map((e) => ({
        key: e.key,
        source_resource_id: e.source_resource_id,
        source_resource_name: e.source_resource_name,
        source_kind: e.source_kind,
        sealed_blob: e.sealed_blob,
        recipient_fingerprints: e.recipient_fingerprints,
      }));
      const result = await assembleMcpCompanion(entries, identity);
      triggerBrowserDownload(`${stem}.env-mcp`, result.text, 'text/plain');

      setState({ kind: 'done', resolved: result.resolved, unavailable: result.unavailable });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'unknown error' });
    }
  };

  if (state.kind === 'running') {
    return (
      <span data-testid="mcp-export-running" className="text-xs text-muted">
        {state.status}
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
          data-testid="mcp-export-retry"
          onClick={() => void handleClick()}
        >
          Retry mcp download
        </Button>
        <span data-testid="mcp-export-error" className="text-xs text-danger-foreground">
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
          data-testid="mcp-export-again"
          onClick={() => void handleClick()}
        >
          Download mcp.json again
        </Button>
        <span data-testid="mcp-export-summary" className="text-xs text-muted">
          mcp.json + .env-mcp downloaded · {state.resolved.length} resolved
          {state.unavailable.length > 0 ? `, ${state.unavailable.length} placeholder(s)` : ''}.
        </span>
      </div>
    );
  }
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      data-testid="mcp-export-button"
      onClick={() => void handleClick()}
    >
      Download mcp.json + .env companion
    </Button>
  );
}
