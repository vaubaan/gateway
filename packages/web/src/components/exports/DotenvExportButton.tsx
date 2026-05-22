'use client';

/**
 * `<DotenvExportButton>` — fetches `/exports/env`, unseals every blob
 * client-side, and triggers a `.env` (or `.env.json`) download.
 *
 * Spec §6.7, §7.5, §11.1.
 *
 * Surface :
 *
 *   1. Idle button "Download .env" / "Download .env.json" depending on
 *      `format`.
 *   2. On click, POST `/exports/env` with the resolved scope.
 *   3. Iterate response `entries`, unseal each via the in-memory
 *      identity (`identityStore`), assemble the file.
 *   4. Trigger the download via `triggerBrowserDownload`.
 *   5. Surface a small summary of resolved / unavailable keys after
 *      the download.
 *
 * Errors:
 *   - 401 / 403 → "Sign in / no permission".
 *   - identity locked → "Unlock your identity (top-right banner)".
 *   - network/server → raw message.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import type { SealedBlobV1 } from '@crm/core/crypto';

import { Button } from '@/components/ui';
import { identityStore } from '@/lib/crypto/identity-store';
import { assembleDotenv, assembleJson, type AssemblableEntry } from '@/lib/exports/dotenv-assembly';
import { triggerBrowserDownload } from '@/lib/exports/download';

export type DotenvScope =
  | { readonly kind: 'org' }
  | { readonly kind: 'project'; readonly scopeId: string };

export interface DotenvExportButtonProps {
  readonly orgSlug: string;
  readonly scope: DotenvScope;
  readonly variant: string | null;
  readonly format: 'dotenv' | 'json';
  readonly filenameStem?: string;
}

interface ExportEnvResponse {
  readonly format: 'dotenv' | 'json';
  readonly entries: ReadonlyArray<{
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

function fileName(stem: string, format: 'dotenv' | 'json'): string {
  return format === 'json' ? `${stem}.env.json` : `${stem}.env`;
}

export function DotenvExportButton(props: DotenvExportButtonProps): ReactElement {
  const { orgSlug, scope, variant, format, filenameStem } = props;
  const [state, setState] = useState<UiState>({ kind: 'idle' });

  const handleClick = async (): Promise<void> => {
    const identity = identityStore.get();
    if (!identity) {
      setState({ kind: 'error', message: 'Unlock your identity to download exports.' });
      return;
    }
    setState({ kind: 'running', status: 'fetching sealed bundles…' });
    try {
      const body =
        scope.kind === 'org'
          ? { scope: 'org', format, variant: variant ?? undefined }
          : { scope: 'project', scopeId: scope.scopeId, format, variant: variant ?? undefined };
      const res = await fetch(`/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/exports/env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${String(res.status)}`);
      }
      const payload = (await res.json()) as ExportEnvResponse;

      setState({ kind: 'running', status: 'unsealing bundles…' });
      const entries: AssemblableEntry[] = payload.entries.map((e) => ({
        key: e.key,
        source_resource_id: e.source_resource_id,
        source_resource_name: e.source_resource_name,
        source_kind: e.source_kind,
        sealed_blob: e.sealed_blob,
        recipient_fingerprints: e.recipient_fingerprints,
      }));
      const result =
        format === 'json'
          ? await assembleJson(entries, identity)
          : await assembleDotenv(entries, identity);

      const stem =
        filenameStem ?? (scope.kind === 'project' ? `project-${scope.scopeId}` : orgSlug);
      triggerBrowserDownload(
        fileName(stem, format),
        result.text,
        format === 'json' ? 'application/json' : 'text/plain',
      );

      setState({ kind: 'done', resolved: result.resolved, unavailable: result.unavailable });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'unknown error' });
    }
  };

  if (state.kind === 'running') {
    return (
      <span data-testid="dotenv-export-running" className="text-xs text-muted">
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
          data-testid="dotenv-export-retry"
          onClick={() => void handleClick()}
        >
          Retry download
        </Button>
        <span data-testid="dotenv-export-error" className="text-xs text-danger-foreground">
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
          data-testid="dotenv-export-again"
          onClick={() => void handleClick()}
        >
          Download again
        </Button>
        <span data-testid="dotenv-export-summary" className="text-xs text-muted">
          {state.resolved.length} unsealed
          {state.unavailable.length > 0 ? `, ${state.unavailable.length} placeholder(s)` : ''}.
        </span>
      </div>
    );
  }

  const label = format === 'json' ? 'Download .env.json' : 'Download .env';
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      data-testid="dotenv-export-button"
      onClick={() => void handleClick()}
    >
      {label}
    </Button>
  );
}
