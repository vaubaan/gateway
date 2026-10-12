'use client';

import { useMemo } from 'react';

import type { Provider, RiskId } from '@vaubaan/shared';
import { qualifyRiskId } from '@vaubaan/policy-engine';

import type { MintFormBinding, MintFormCatalog, PreviewRiskRow } from '../new/mint-types';
import { ProviderRisksCard } from '../new/provider-risks-card';
import { entryAppliesToBinding } from '../new/qualify-helpers';

function groupBindings(bindings: readonly MintFormBinding[]): Map<Provider, MintFormBinding[]> {
  const groups = new Map<Provider, MintFormBinding[]>();
  for (const b of bindings) {
    let arr = groups.get(b.provider);
    if (!arr) {
      arr = [];
      groups.set(b.provider, arr);
    }
    arr.push(b);
  }
  return groups;
}

export function TokenDetailRisks({
  bindings,
  catalogs,
  acceptedRisks,
}: {
  bindings: MintFormBinding[];
  catalogs: MintFormCatalog[];
  acceptedRisks: RiskId[];
}) {
  const accepted = useMemo(() => new Set<RiskId>(acceptedRisks), [acceptedRisks]);
  const groupedBindings = useMemo(() => groupBindings(bindings), [bindings]);

  const previewByRiskId = useMemo(() => {
    const map = new Map<RiskId, PreviewRiskRow>();
    for (const binding of bindings) {
      const cat = catalogs.find((c) => c.provider === binding.provider);
      if (!cat?.loaded) continue;
      for (const entry of cat.entries) {
        if (!entryAppliesToBinding(entry, binding.env)) continue;
        const qid = qualifyRiskId(entry.id, binding.env, entry);
        map.set(qid, {
          id: qid,
          base_id: entry.id,
          provider: binding.provider,
          env: binding.env,
          label: entry.label,
          reason: entry.reason,
          vector: entry.vector,
          acceptable: true,
          inherited: true,
        });
      }
    }
    return map;
  }, [bindings, catalogs]);

  const noop = () => {};

  return (
    <>
      {Array.from(groupedBindings.entries()).map(([provider, providerBindings]) => {
        const cat = catalogs.find((c) => c.provider === provider);
        return (
          <ProviderRisksCard
            key={provider}
            provider={provider}
            providerBindings={providerBindings}
            catalog={cat}
            accepted={accepted}
            previewByRiskId={previewByRiskId}
            onToggle={noop}
            readOnly
          />
        );
      })}
    </>
  );
}
