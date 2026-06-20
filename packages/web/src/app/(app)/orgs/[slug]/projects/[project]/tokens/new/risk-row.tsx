'use client';

/**
 * One row in the risk-checklist : checkbox + qualified id + status badge
 * + collapsible details (reason + 6D vector + blocked reason).
 *
 * Post drop-confirm : the checkbox is disabled iff `!acceptable || !inherited`.
 * The tooltip explains which side blocks.
 */

import { useState } from 'react';
import type { RiskId } from '@vaubaan/shared';
import { resolveVector } from '@vaubaan/policy-engine';

import { Badge, Code } from '@/components/ui';

import { type MintFormCatalogEntry } from './mint-types';
import { VectorRow } from './vector-row';

export function RiskRow({
  entry,
  qualifiedId,
  env,
  isAccepted,
  acceptable,
  inherited,
  blocked,
  onToggle,
}: {
  entry: MintFormCatalogEntry;
  qualifiedId: RiskId;
  env: string | null;
  isAccepted: boolean;
  acceptable: boolean;
  inherited: boolean;
  blocked: string | null;
  onToggle: (qualifiedId: RiskId) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const disabled = !acceptable || !inherited;
  const opacity = disabled ? 0.45 : 1;
  const tooltip = !acceptable
    ? (blocked ?? `Not acceptable in this env (catalog restriction)`)
    : !inherited
      ? (blocked ?? `Your token doesn't carry this risk — request escalation`)
      : entry.reason;

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
            {!acceptable && (
              <span title={tooltip}>
                <Badge tone="danger">not acceptable</Badge>
              </span>
            )}
            {acceptable && !inherited && (
              <span title={tooltip}>
                <Badge tone="warning">not inherited</Badge>
              </span>
            )}
            {acceptable && inherited && isAccepted && <Badge tone="success">accepted</Badge>}
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
              <VectorRow vector={resolveVector(entry, env)} />
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
