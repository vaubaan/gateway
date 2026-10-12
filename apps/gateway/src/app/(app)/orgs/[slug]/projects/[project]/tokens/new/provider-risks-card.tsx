'use client';

/**
 * One Card per provider in the form. Holds the per-binding sub-sections.
 * Renders a "catalog not loaded" notice when the catalog payload is empty
 * (a provider whose risk-catalog.yaml failed validation at boot).
 */

import type { Provider, RiskId } from '@vaubaan/shared';

import { Badge, Card, CardBody, CardHeader, CardTitle, Code } from '@/components/ui';

import { BindingRisksSection } from './binding-risks-section';
import type { MintFormBinding, MintFormCatalog, PreviewRiskRow } from './mint-types';

export function ProviderRisksCard({
  provider,
  providerBindings,
  catalog,
  accepted,
  previewByRiskId,
  onToggle,
  readOnly,
}: {
  provider: Provider;
  providerBindings: MintFormBinding[];
  catalog: MintFormCatalog | undefined;
  accepted: Set<RiskId>;
  previewByRiskId: Map<RiskId, PreviewRiskRow>;
  onToggle: (qualifiedId: RiskId) => void;
  readOnly?: boolean;
}) {
  if (!catalog || !catalog.loaded) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{provider}</CardTitle>
          <Badge tone="danger">catalog not loaded</Badge>
        </CardHeader>
        <CardBody>
          <p style={{ margin: 0, color: 'var(--accent-danger-fg)', fontSize: 'var(--text-sm)' }}>
            Risk catalog for <Code>{provider}</Code> is unavailable — re-mint from this provider is
            blocked until it loads.
          </p>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {provider} ({providerBindings.length} binding{providerBindings.length === 1 ? '' : 's'})
        </CardTitle>
      </CardHeader>
      <CardBody>
        <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
          {providerBindings.map((binding) => (
            <BindingRisksSection
              key={`${provider}-${binding.resource_ref}-${binding.env ?? ''}`}
              binding={binding}
              catalog={catalog}
              accepted={accepted}
              previewByRiskId={previewByRiskId}
              onToggle={onToggle}
              readOnly={readOnly}
            />
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
