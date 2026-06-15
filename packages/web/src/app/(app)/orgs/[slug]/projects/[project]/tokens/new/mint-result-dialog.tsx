'use client';

/**
 * Post-mint modal. One of 4 shapes :
 *   - 'minted'  → the plaintext api_key (one-time, shown until user closes) ;
 *   - 'pending' → an approval was opened, link to the approvals page ;
 *   - 'denied'  → list of risks rejected by catalog / policy ;
 *   - 'error'   → arbitrary error message.
 */

import Link from 'next/link';

import { Button, Code } from '@/components/ui';

import type { MintResult } from './mint-types';

export function MintResultDialog({ result, onClose }: { result: MintResult; onClose: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        padding: 'var(--space-4)',
      }}
    >
      <div
        style={{
          background: 'var(--surface-elevated)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md)',
          padding: 'var(--space-5)',
          maxWidth: 640,
          width: '100%',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}
      >
        {result.kind === 'minted' && (
          <>
            <h2 style={{ margin: 0 }}>Token minted</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              Copy the api_key below — it is shown <strong>once</strong>. Closing this dialog clears
              it from memory and there is no way to retrieve it again.
            </p>
            <pre
              style={{
                padding: 'var(--space-3)',
                background: 'var(--surface-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
                fontSize: 13,
                overflowX: 'auto',
                userSelect: 'all',
              }}
            >
              {result.apiKey}
            </pre>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Expires : <Code>{result.expiresAt}</Code>
            </p>
            <Button variant="primary" onClick={onClose}>
              I&apos;ve copied it — close
            </Button>
          </>
        )}
        {result.kind === 'pending' && (
          <>
            <h2 style={{ margin: 0 }}>Approval requested</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              Some risks need a human approval. A notification was dispatched via{' '}
              <Code>{result.channel}</Code>. Once approved, the api_key will be available to whoever
              polls the approval. Expires : <Code>{result.expiresAt}</Code>.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <Link href="approvals">
                <Button variant="primary" onClick={onClose}>
                  See pending approvals
                </Button>
              </Link>
              <Button variant="secondary" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
        {result.kind === 'denied' && (
          <>
            <h2 style={{ margin: 0 }}>Mint denied</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
              At least one accepted risk is denied by the project policy or the catalog. Untick the
              rows below and retry, or ask the project owner to relax the policy.
            </p>
            <ul style={{ paddingLeft: 18, fontSize: 13 }}>
              {result.risks.map((r) => (
                <li key={r.id}>
                  <Code>{r.id}</Code>{' '}
                  <span style={{ color: 'var(--text-muted)' }}>
                    — {r.blocked_reason ?? 'denied by policy'}
                  </span>
                </li>
              ))}
            </ul>
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        )}
        {result.kind === 'error' && (
          <>
            <h2 style={{ margin: 0 }}>Mint failed</h2>
            <p style={{ color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)' }}>
              {result.message}
            </p>
            <Button variant="primary" onClick={onClose}>
              Close
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
