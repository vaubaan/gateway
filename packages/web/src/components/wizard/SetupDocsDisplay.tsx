/**
 * Wizard step 2 — render the kind's `setupDocs` markdown + form for the
 * Resource metadata (name, variant, provider_ref). Spec §7.1 step 2/3.
 *
 * `setupDocs` is markdown but we render it as a `<pre>` to avoid pulling
 * a markdown parser in this phase (TODO Phase 5: swap in a small
 * sanitised markdown renderer).
 */

'use client';

import { useState } from 'react';

import type { SerializedKind } from '@/lib/catalog/serialize';

export interface SetupDocsDisplayProps {
  readonly kind: SerializedKind;
  readonly onSubmit: (data: ResourceRegisterFormData) => void;
  readonly onBack: () => void;
}

export interface ResourceRegisterFormData {
  readonly name: string;
  readonly variant: string | null;
  readonly providerRef: string;
  readonly consoleUrl: string;
  readonly metadata: Record<string, string>;
}

const SLUG_REGEX = /^[a-z0-9](-?[a-z0-9])*$/;

export function SetupDocsDisplay(props: SetupDocsDisplayProps): React.ReactElement {
  const { kind, onSubmit, onBack } = props;
  const [name, setName] = useState('');
  const [variant, setVariant] = useState('');
  const [providerRef, setProviderRef] = useState('');
  const [consoleUrl, setConsoleUrl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    setError(null);
    if (!SLUG_REGEX.test(name)) {
      setError(`name must match ${SLUG_REGEX.source}`);
      return;
    }
    if (variant.length > 0 && !SLUG_REGEX.test(variant)) {
      setError(`variant must match ${SLUG_REGEX.source}`);
      return;
    }
    onSubmit({
      name,
      variant: variant.length > 0 ? variant : null,
      providerRef,
      consoleUrl,
      metadata: { provider_ref: providerRef },
    });
  };

  return (
    <div className="flex flex-col gap-3" data-testid="wizard-setup-docs">
      <h2 className="text-sm font-semibold">{kind.displayName} — setup</h2>
      <pre
        data-testid="wizard-setup-docs-md"
        className="max-h-64 overflow-y-auto rounded bg-neutral-100 p-2 font-mono text-xs whitespace-pre-wrap"
      >
        {kind.setupDocs}
      </pre>

      <form onSubmit={handleSubmit} className="flex flex-col gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span>Resource name (slug)</span>
          <input
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            data-testid="wizard-name"
            className="rounded border border-neutral-300 px-2 py-1 font-mono"
            placeholder="my-resource"
          />
        </label>
        {kind.kindClass !== 'org-admin' ? (
          <label className="flex flex-col gap-1">
            <span>Variant (optional — slug)</span>
            <input
              value={variant}
              onChange={(e) => {
                setVariant(e.target.value);
              }}
              data-testid="wizard-variant"
              className="rounded border border-neutral-300 px-2 py-1 font-mono"
              placeholder="staging, prod, …"
            />
          </label>
        ) : null}
        <label className="flex flex-col gap-1">
          <span>Provider reference (optional — opaque id at the provider)</span>
          <input
            value={providerRef}
            onChange={(e) => {
              setProviderRef(e.target.value);
            }}
            data-testid="wizard-provider-ref"
            className="rounded border border-neutral-300 px-2 py-1"
            placeholder="acme, prj_xxx, …"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span>Console URL (optional)</span>
          <input
            type="url"
            value={consoleUrl}
            onChange={(e) => {
              setConsoleUrl(e.target.value);
            }}
            data-testid="wizard-console-url"
            className="rounded border border-neutral-300 px-2 py-1"
            placeholder="https://github.com/acme"
          />
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded border border-neutral-300 px-3 py-1 text-sm"
            data-testid="wizard-back"
          >
            Back
          </button>
          <button
            type="submit"
            data-testid="wizard-next"
            className="rounded bg-neutral-900 px-3 py-1 text-sm text-white"
          >
            Next: paste secrets
          </button>
        </div>
        {error ? (
          <span data-testid="wizard-setup-error" className="text-red-700">
            {error}
          </span>
        ) : null}
      </form>
    </div>
  );
}
