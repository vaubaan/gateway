'use client';

/**
 * 6D vector mini-badges (one Badge per axis). Same logic used on the
 * provider info page — kept colocated with the mint-form for now because
 * the colour mapping is presentation-only and doesn't justify a public
 * shared module.
 */

import type { RiskVector } from '@vaubaan/shared';

import { Badge, type BadgeTone } from '@/components/ui';

function reversibilityTone(v: RiskVector['reversibility']): BadgeTone {
  if (v === 'reversible') return 'success';
  if (v === 'costly') return 'warning';
  return 'danger';
}
function blastTone(v: RiskVector['blast']): BadgeTone {
  if (v === 'single') return 'success';
  if (v === 'env') return 'info';
  if (v === 'account') return 'warning';
  return 'danger';
}
function dataTone(v: RiskVector['data']): BadgeTone {
  if (v === 'metadata') return 'neutral';
  if (v === 'data') return 'info';
  return 'danger';
}
function costTone(v: RiskVector['cost']): BadgeTone {
  if (v === 'free') return 'success';
  if (v === 'moderate') return 'warning';
  return 'danger';
}
function visibilityTone(v: RiskVector['visibility']): BadgeTone {
  if (v === 'internal') return 'success';
  if (v === 'team') return 'info';
  return 'danger';
}
function persistenceTone(v: RiskVector['persistence']): BadgeTone {
  if (v === 'stateless') return 'success';
  if (v === 'session') return 'info';
  return 'warning';
}

export function VectorRow({ vector }: { vector: RiskVector }) {
  const axes: Array<{ key: string; value: string; tone: BadgeTone }> = [
    { key: 'rev', value: vector.reversibility, tone: reversibilityTone(vector.reversibility) },
    { key: 'blast', value: vector.blast, tone: blastTone(vector.blast) },
    { key: 'data', value: vector.data, tone: dataTone(vector.data) },
    { key: 'cost', value: vector.cost, tone: costTone(vector.cost) },
    { key: 'vis', value: vector.visibility, tone: visibilityTone(vector.visibility) },
    { key: 'pers', value: vector.persistence, tone: persistenceTone(vector.persistence) },
  ];
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {axes.map((axis) => (
        <Badge key={axis.key} tone={axis.tone}>
          <span style={{ opacity: 0.6, fontSize: '0.85em' }}>{axis.key}:</span> {axis.value}
        </Badge>
      ))}
    </div>
  );
}
