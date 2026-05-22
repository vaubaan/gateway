/**
 * `<SetDefaultButton>` — client component that PATCHes the SM to flip
 * `is_default=true`. The route handler unsets the previous default in
 * the same call. On success we reload the page so the server-rendered
 * badge reflects the new state.
 */

'use client';

import { useState } from 'react';

import { Button } from '@/components/ui';

export interface SetDefaultButtonProps {
  readonly orgSlug: string;
  readonly smId: string;
}

export function SetDefaultButton(props: SetDefaultButtonProps): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/crm/v1/orgs/${encodeURIComponent(props.orgSlug)}/secret-managers/${encodeURIComponent(
          props.smId,
        )}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ is_default: true }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${String(res.status)}`);
        return;
      }
      if (typeof window !== 'undefined') {
        window.location.reload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'unknown_error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        data-testid={`set-default-button-${props.smId}`}
        disabled={busy}
        loading={busy}
        onClick={() => void handleClick()}
      >
        {busy ? 'Setting…' : 'Set default'}
      </Button>
      {error ? (
        <span
          data-testid={`set-default-error-${props.smId}`}
          className="text-xs text-danger-foreground"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
