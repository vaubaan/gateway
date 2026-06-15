'use client';

/**
 * Risks for one binding under a provider card. Filters the catalog to
 * entries applicable to the binding env, sorts by effective gate
 * (allow → confirm → deny), then renders one `RiskRow` per row.
 *
 * Owns no state — the parent passes the current `accepted` set and the
 * preview-derived `effectiveGates` map.
 */

import type { RiskGate, RiskId } from '@vaubaan/shared';
import { qualifyRiskId } from '@vaubaan/policy-engine';

import { Code } from '@/components/ui';

import {
  GATE_ORDER,
  type MintFormBinding,
  type MintFormCatalog,
  type MintFormCatalogEntry,
  type PreviewRiskRow,
} from './mint-types';
import { RiskRow } from './risk-row';
import { asRiskEntry, entryAppliesToBinding } from './qualify-helpers';

export function BindingRisksSection({
  binding,
  catalog,
  accepted,
  effectiveGates,
  onToggle,
}: {
  binding: MintFormBinding;
  catalog: MintFormCatalog;
  accepted: Set<RiskId>;
  effectiveGates: Map<RiskId, PreviewRiskRow>;
  onToggle: (qualifiedId: RiskId) => void;
}) {
  const applicableEntries = catalog.entries.filter((e: MintFormCatalogEntry) =>
    entryAppliesToBinding(e, binding.env),
  );

  // Sort by effective_gate (allow > confirm > deny). The effective gate
  // comes from the live preview when the risk is currently accepted, else
  // we fall back to `default_gate`.
  const rows = applicableEntries
    .map((entry) => {
      const qualifiedId = qualifyRiskId(entry.id, binding.env, asRiskEntry(entry));
      const isAccepted = accepted.has(qualifiedId);
      const previewRow = effectiveGates.get(qualifiedId);
      const effective: RiskGate = previewRow?.effective_gate ?? entry.default_gate;
      const blocked = previewRow?.blocked_reason ?? null;
      // A risk is policy-blocked if effective_gate === 'deny' AND the
      // entry isn't deny by default (i.e. the project policy is the
      // tightening source).
      const lockedByPolicy =
        effective === 'deny' && entry.default_gate !== 'deny' && previewRow !== undefined;
      return { entry, qualifiedId, isAccepted, effective, blocked, lockedByPolicy };
    })
    .sort((a, b) => {
      const diff = GATE_ORDER[a.effective] - GATE_ORDER[b.effective];
      if (diff !== 0) return diff;
      return a.entry.id.localeCompare(b.entry.id);
    });

  return (
    <div>
      <div
        style={{
          fontSize: 'var(--text-sm)',
          color: 'var(--text-muted)',
          marginBottom: 'var(--space-2)',
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
        }}
      >
        <strong style={{ color: 'var(--text-primary)' }}>{binding.display_name}</strong>
        {binding.env && <Code>{binding.env}</Code>}
      </div>
      {rows.length === 0 ? (
        <p
          style={{
            margin: 0,
            color: 'var(--text-subtle)',
            fontSize: 'var(--text-sm)',
          }}
        >
          No catalog entries apply to this binding env.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((row) => (
            <RiskRow
              key={row.qualifiedId}
              entry={row.entry}
              qualifiedId={row.qualifiedId}
              isAccepted={row.isAccepted}
              effective={row.effective}
              blocked={row.blocked}
              lockedByPolicy={row.lockedByPolicy || row.entry.default_gate === 'deny'}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
