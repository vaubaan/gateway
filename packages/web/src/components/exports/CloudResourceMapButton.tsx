'use client';

/**
 * `<CloudResourceMapButton>` — fetches
 * `/exports/cloud-resource-map`, writes the JSON file directly.
 *
 * Spec §6.7.1.
 *
 * No unseal: the response carries NO sealed_blob (zero secrets, just
 * metadata). The browser writes the JSON as-is.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui';
import { triggerBrowserDownload } from '@/lib/exports/download';

export interface CloudResourceMapButtonProps {
  readonly orgSlug: string;
  readonly filenameStem?: string;
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; resourceCount: number }
  | { kind: 'error'; message: string };

export function CloudResourceMapButton(props: CloudResourceMapButtonProps): ReactElement {
  const { orgSlug, filenameStem } = props;
  const [state, setState] = useState<UiState>({ kind: 'idle' });

  const handleClick = async (): Promise<void> => {
    setState({ kind: 'running' });
    try {
      const res = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(orgSlug)}/exports/cloud-resource-map`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errBody.error ?? `HTTP ${String(res.status)}`);
      }
      const payload = (await res.json()) as {
        readonly resources: ReadonlyArray<unknown>;
      };
      const stem = filenameStem ?? `${orgSlug}-cloud-resource-map`;
      triggerBrowserDownload(`${stem}.json`, JSON.stringify(payload, null, 2), 'application/json');
      setState({ kind: 'done', resourceCount: payload.resources.length });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'unknown error' });
    }
  };

  if (state.kind === 'running') {
    return (
      <span data-testid="crm-map-running" className="text-xs text-muted">
        building map…
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
          data-testid="crm-map-retry"
          onClick={() => void handleClick()}
        >
          Retry
        </Button>
        <span data-testid="crm-map-error" className="text-xs text-danger-foreground">
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
          data-testid="crm-map-again"
          onClick={() => void handleClick()}
        >
          Download again
        </Button>
        <span data-testid="crm-map-summary" className="text-xs text-muted">
          cloud-resource-map.json downloaded · {state.resourceCount} resource(s).
        </span>
      </div>
    );
  }
  return (
    <Button
      type="button"
      variant="primary"
      size="sm"
      data-testid="crm-map-button"
      onClick={() => void handleClick()}
    >
      Download cloud-resource-map.json
    </Button>
  );
}
