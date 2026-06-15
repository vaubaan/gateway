'use client';

/**
 * Sticky bottom footer : live allow / confirm / deny counts + primary
 * action button. The button label depends on whether a confirm-gated risk
 * was selected ("Request approval" vs "Mint token").
 */

import { Badge, Button } from '@/components/ui';

export function PreviewFooter({
  allowCount,
  confirmCount,
  denyCount,
  previewState,
  previewError,
  acceptedCount,
  canMint,
  isMinting,
  onMint,
}: {
  allowCount: number;
  confirmCount: number;
  denyCount: number;
  previewState: 'idle' | 'computing' | 'ready' | 'error';
  previewError: string | null;
  acceptedCount: number;
  canMint: boolean;
  isMinting: boolean;
  onMint: () => void;
}) {
  const buttonLabel = isMinting
    ? 'Minting…'
    : confirmCount > 0
      ? `Request approval (${confirmCount} confirm)`
      : 'Mint token';

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        background: 'var(--surface-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-3) var(--space-4)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        boxShadow: '0 -4px 12px rgba(0,0,0,0.08)',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        {previewState === 'idle' && acceptedCount === 0 && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Pick at least one risk to enable mint.
          </span>
        )}
        {previewState === 'computing' && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
            Computing preview…
          </span>
        )}
        {previewState === 'error' && (
          <span style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)' }}>
            Preview error : {previewError}
          </span>
        )}
        {previewState === 'ready' && (
          <>
            <span>
              <Badge tone="success">{allowCount} allow</Badge>
            </span>
            <span>
              <Badge tone="warning">{confirmCount} confirm</Badge>
            </span>
            <span>
              <Badge tone="danger">{denyCount} deny</Badge>
            </span>
          </>
        )}
      </div>
      <Button variant="primary" disabled={!canMint} onClick={onMint}>
        {buttonLabel}
      </Button>
    </div>
  );
}
