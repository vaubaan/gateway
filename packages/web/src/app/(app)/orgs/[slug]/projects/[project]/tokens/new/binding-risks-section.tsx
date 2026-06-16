'use client';

/**
 * Risks for one binding under a provider card. Filters the catalog to
 * entries applicable to the binding env, then renders one `RiskRow` per
 * row (sorted by id for stable rendering).
 *
 * Post drop-confirm : no bucket grouping. The `effectiveGates` map carries
 * the preview-derived `{ acceptable, inherited, blocked_reason }` triple.
 */

import type { RiskId } from '@vaubaan/shared';
import { qualifyRiskId } from '@vaubaan/policy-engine';

import { Code } from '@/components/ui';

import {
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

  const rows = applicableEntries
    .map((entry) => {
      const qualifiedId = qualifyRiskId(entry.id, binding.env, asRiskEntry(entry));
      const isAccepted = accepted.has(qualifiedId);
      const previewRow = effectiveGates.get(qualifiedId);
      // Default: structural acceptable derived from catalog; inherited
      // optimistic until the preview lands.
      const acceptable =
        previewRow?.acceptable ??
        (entry.acceptable_in_envs === null ||
          entry.acceptable_in_envs === undefined ||
          (binding.env !== null && entry.acceptable_in_envs.includes(binding.env)));
      const inherited = previewRow?.inherited ?? true;
      const blocked = previewRow?.blocked_reason ?? null;
      return { entry, qualifiedId, isAccepted, acceptable, inherited, blocked };
    })
    .sort((a, b) => a.entry.id.localeCompare(b.entry.id));

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
              acceptable={row.acceptable}
              inherited={row.inherited}
              blocked={row.blocked}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
