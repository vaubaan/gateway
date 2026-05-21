'use client';

/**
 * `<VariantSelector>` — small `<select>` for the export variant.
 *
 * The list of variants comes from the parent (server-resolved from the
 * `resources` table). Always includes the empty option `''` ("no
 * variant filter / show all"). Highlighting comes from the parent
 * setState.
 *
 * Spec §11.1 — "sélecteur de variant (none / staging / prod / …)".
 */

import type { ReactElement } from 'react';

export interface VariantSelectorProps {
  readonly variants: ReadonlyArray<string>;
  readonly value: string;
  readonly onChange: (next: string) => void;
}

export function VariantSelector(props: VariantSelectorProps): ReactElement {
  const { variants, value, onChange } = props;
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-neutral-700">Variant</span>
      <select
        data-testid="export-variant-selector"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1 text-xs"
      >
        <option value="">(none — all variants)</option>
        {variants.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}
