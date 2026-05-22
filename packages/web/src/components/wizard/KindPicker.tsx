/**
 * Wizard step 1 — pick a ResourceKind from the catalog.
 * Spec §7.1 step 1.
 */

'use client';

import type { SerializedKind } from '@/lib/catalog/serialize';

export interface KindPickerProps {
  readonly kinds: ReadonlyArray<SerializedKind>;
  readonly onPick: (kind: SerializedKind) => void;
}

export function KindPicker(props: KindPickerProps): React.ReactElement {
  const { kinds, onPick } = props;
  return (
    <div className="flex flex-col gap-2" data-testid="wizard-kind-picker">
      <h2 className="text-sm font-semibold">Pick a resource kind</h2>
      <ul className="flex flex-col gap-2">
        {kinds.map((k) => (
          <li
            key={k.id}
            className="rounded border border-border-default p-3 hover:border-border-strong"
          >
            <button
              type="button"
              data-testid={`wizard-kind-${k.id}`}
              onClick={() => {
                onPick(k);
              }}
              className="flex w-full flex-col items-start gap-1 text-left"
            >
              <span className="text-sm font-medium">{k.displayName}</span>
              <span className="font-mono text-xs text-muted">
                {k.id} · {k.provider} · {k.kindClass}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
