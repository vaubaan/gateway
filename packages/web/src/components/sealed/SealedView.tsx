/**
 * `<SealedView>` — read-only summary of a sealed bundle.
 *
 * Renders `"sealed for N recipients"` + a Reveal button that opens a
 * `SealedReveal` in `reveal` mode. The cleartext is never shown until
 * the operator explicitly clicks Reveal.
 *
 * Spec §11.2 / Phase 4 wave B.
 */

'use client';

import { useState } from 'react';

import { type SealedBlobV1 } from '@crm/core/crypto';

import { Button } from '@/components/ui';

import { SealedReveal } from './SealedReveal';

export interface SealedViewProps {
  readonly blob: SealedBlobV1;
  readonly label?: string;
}

export function SealedView(props: SealedViewProps): React.ReactElement {
  const { blob, label } = props;
  const [open, setOpen] = useState(false);
  return (
    <div data-testid="sealed-view" className="flex flex-col gap-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span>
          {label ? <span className="font-medium">{label}: </span> : null}
          <span data-testid="sealed-view-summary">
            sealed for {String(blob.recipients.length)} recipient
            {blob.recipients.length === 1 ? '' : 's'}
          </span>
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          data-testid="sealed-view-toggle"
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {open ? 'Close' : 'Reveal'}
        </Button>
      </div>
      {open ? <SealedReveal blob={blob} mode="reveal" /> : null}
    </div>
  );
}
