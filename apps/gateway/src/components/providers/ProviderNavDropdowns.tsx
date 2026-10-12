'use client';

/**
 * Provider-info navigation dropdowns — drop-in replacement for the
 * "← back to all providers" / "← back to all <provider> planes" anchor
 * links the page used to render in its top-right corner.
 *
 * Why dropdowns instead of back links :
 *  - The sidebar already exposes every provider in the org context, and
 *    the browser's back button handles "go back" intent ;
 *  - A "back" link with a Δ-target (which page would I land on ?) adds
 *    cognitive load. A dropdown that lets the user *jump* directly to
 *    another provider / plane in O(1) is strictly more useful.
 *
 * Two variants :
 *  - `<ProviderSwitcher>` : single dropdown, listed providers. Used on
 *    the multi-plane landing chooser (no plane chosen yet).
 *  - `<ProviderPlaneSwitcher>` : two dropdowns side by side, provider +
 *    plane. Used on the per-plane page.
 *
 * Both components are client islands because they need `onChange` →
 * `router.push()`. They render `<select>` so they're keyboard-accessible
 * out of the box and styled by `Input.module.css` via the shared
 * `<Select>` component.
 */

import { useRouter } from 'next/navigation';
import type { ChangeEvent } from 'react';

import { Select, Label } from '@/components/ui';

export interface ProviderOption {
  readonly slug: string;
  readonly label: string;
}

export interface PlaneOption {
  readonly slug: string;
  readonly label: string;
}

/**
 * Single dropdown — switch to another provider's landing page. Shown on
 * the multi-plane chooser (Supabase landing) where there is no current
 * plane selected.
 */
export function ProviderSwitcher({
  currentProviderSlug,
  providers,
  orgSlug,
}: {
  currentProviderSlug: string;
  providers: ReadonlyArray<ProviderOption>;
  orgSlug: string;
}) {
  const router = useRouter();
  const onChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (!next || next === currentProviderSlug) return;
    router.push(`/orgs/${orgSlug}/providers/${next}`);
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 180 }}>
      <Label>Provider</Label>
      <Select value={currentProviderSlug} onChange={onChange} aria-label="Switch provider">
        {providers.map((p) => (
          <option key={p.slug} value={p.slug}>
            {p.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

/**
 * Two dropdowns — switch provider (jumps to landing/single-plane route)
 * or switch plane within the current provider. Shown on the per-plane
 * page.
 */
export function ProviderPlaneSwitcher({
  currentProviderSlug,
  providers,
  currentPlaneSlug,
  planes,
  orgSlug,
}: {
  currentProviderSlug: string;
  providers: ReadonlyArray<ProviderOption>;
  currentPlaneSlug: string;
  planes: ReadonlyArray<PlaneOption>;
  orgSlug: string;
}) {
  const router = useRouter();
  const onProviderChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (!next || next === currentProviderSlug) return;
    // Jump to the parent provider route — single-plane providers will
    // redirect server-side to their only plane ; multi-plane lands on the
    // chooser.
    router.push(`/orgs/${orgSlug}/providers/${next}`);
  };
  const onPlaneChange = (e: ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    if (!next || next === currentPlaneSlug) return;
    router.push(`/orgs/${orgSlug}/providers/${currentProviderSlug}/${next}`);
  };
  return (
    <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 160 }}>
        <Label>Provider</Label>
        <Select
          value={currentProviderSlug}
          onChange={onProviderChange}
          aria-label="Switch provider"
        >
          {providers.map((p) => (
            <option key={p.slug} value={p.slug}>
              {p.label}
            </option>
          ))}
        </Select>
      </div>
      {planes.length > 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 160 }}>
          <Label>Plane</Label>
          <Select value={currentPlaneSlug} onChange={onPlaneChange} aria-label="Switch plane">
            {planes.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.label}
              </option>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}
