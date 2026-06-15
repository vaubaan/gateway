'use client';

/**
 * One row in the risk-checklist : checkbox + qualified id + effective gate
 * badge + collapsible details (reason + 6D vector + blocked reason).
 *
 * Pure presentational : state about whether the risk is currently accepted
 * is owned by the parent (the form root). The row only owns the local
 * `expanded` flag.
 */

import { useState } from 'react';
import type { RiskGate, RiskId } from '@vaubaan/shared';

import { Badge, Code } from '@/components/ui';

import { GATE_TONE, type MintFormCatalogEntry } from './mint-types';
import { VectorRow } from './vector-row';

export function RiskRow({
  entry,
  qualifiedId,
  isAccepted,
  effective,
  blocked,
  lockedByPolicy,
  onToggle,
}: {
  entry: MintFormCatalogEntry;
  qualifiedId: RiskId;
  isAccepted: boolean;
  effective: RiskGate;
  blocked: string | null;
  lockedByPolicy: boolean;
  onToggle: (qualifiedId: RiskId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const disabled = lockedByPolicy;
  const opacity = disabled ? 0.45 : 1;
  const tooltip = disabled ? (blocked ?? 'Blocked by project policy') : entry.reason;

  return (
    <li
      style={{
        display: 'flex',
        flexDirection: 'column',
        padding: 'var(--space-2) 0',
        borderBottom: '1px solid var(--border-subtle)',
        opacity,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          checked={isAccepted}
          disabled={disabled}
          onChange={() => onToggle(qualifiedId)}
          style={{ marginTop: 4, cursor: disabled ? 'not-allowed' : 'pointer' }}
          aria-label={`Accept risk ${qualifiedId}`}
          title={tooltip}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Code>{qualifiedId}</Code>
            <Badge tone={GATE_TONE[effective]}>{effective}</Badge>
            {lockedByPolicy && (
              <span title={tooltip}>
                <Badge tone="neutral">blocked by policy</Badge>
              </span>
            )}
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-muted)',
                fontSize: 'var(--text-xs)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              {expanded ? 'hide details ▴' : 'details ▾'}
            </button>
          </div>
          <div
            style={{
              fontSize: 'var(--text-sm)',
              color: 'var(--text-muted)',
              marginTop: 2,
            }}
          >
            {entry.label}
          </div>
          {expanded && (
            <div
              style={{
                fontSize: 'var(--text-xs)',
                color: 'var(--text-muted)',
                marginTop: 6,
                padding: 'var(--space-2)',
                background: 'var(--surface-base)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ marginBottom: 6 }}>{entry.reason}</div>
              <VectorRow vector={entry.vector} />
              {blocked && (
                <div
                  style={{
                    marginTop: 6,
                    color: 'var(--accent-danger-fg)',
                  }}
                >
                  {blocked}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
