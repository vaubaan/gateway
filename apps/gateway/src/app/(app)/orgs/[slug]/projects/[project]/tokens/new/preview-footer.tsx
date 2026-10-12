'use client';

/**
 * Sticky bottom footer : live counts of acceptable / not-acceptable /
 * not-inherited rows + primary mint action.
 */

import { Badge, Button } from '@/components/ui';

export function PreviewFooter({
  acceptableCount,
  notAcceptableCount,
  notInheritedCount,
  previewState,
  previewError,
  acceptedCount,
  canMint,
  isMinting,
  onMint,
}: {
  acceptableCount: number;
  notAcceptableCount: number;
  notInheritedCount: number;
  previewState: 'idle' | 'computing' | 'ready' | 'error';
  previewError: string | null;
  acceptedCount: number;
  canMint: boolean;
  isMinting: boolean;
  onMint: () => void;
}) {
  const buttonLabel = isMinting ? 'Minting…' : 'Mint token';

  return (
    <div
      style={{
        position: 'sticky',
        bottom: 0,
        background: 'var(--surface-raised)',
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
              <Badge tone="success">{acceptableCount} ok</Badge>
            </span>
            {notAcceptableCount > 0 && (
              <span>
                <Badge tone="danger">{notAcceptableCount} not acceptable</Badge>
              </span>
            )}
            {notInheritedCount > 0 && (
              <span>
                <Badge tone="warning">{notInheritedCount} not inherited</Badge>
              </span>
            )}
          </>
        )}
      </div>
      <Button variant="primary" disabled={!canMint} onClick={onMint}>
        {buttonLabel}
      </Button>
    </div>
  );
}
